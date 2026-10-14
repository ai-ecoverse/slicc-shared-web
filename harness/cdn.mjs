import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type } from './server.mjs';
import { cache, ignore } from './util.mjs';

const cors = [{ name: 'access-control-allow-origin', value: '*' }];
const store = new URL('cdn/', cache);

export const DOWNLOAD_TIMEOUT = 60000;

export async function fetched(url, { attempts = 3, ms = DOWNLOAD_TIMEOUT, fetcher = fetch } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetcher(url, { signal: AbortSignal.timeout(ms) });
      if (!response.ok) throw new Error(`${response.status} ${url}`);
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      if (attempt >= attempts || /^4\d\d /.test(error.message)) throw error;
    }
  }
}

const fresh = new Map();

export function mutable(url) {
  const { hostname, pathname } = new URL(url);
  return hostname.startsWith('registry.') && !/\/-\/[^/]+\.tgz$/.test(pathname);
}

async function unblock(dir) {
  const root = fileURLToPath(store);
  let path = root;
  for (const part of relative(root, dir).split(sep)) {
    path = join(path, part);
    const found = await stat(path).catch(ignore);
    if (!found) return;
    if (!found.isDirectory()) return unlink(path);
  }
}

async function save(file, body) {
  const dir = dirname(fileURLToPath(file));
  await mkdir(dir, { recursive: true }).catch(async (error) => {
    if (error.code !== 'EEXIST' && error.code !== 'ENOTDIR') throw error;
    await unblock(dir);
    await mkdir(dir, { recursive: true });
  });
  const partial = new URL(`${file.href}.${process.pid}`);
  await writeFile(partial, body);
  await rename(partial, file);
  return body;
}

async function refresh(url, file) {
  const body = await fetched(url).catch(async (error) => {
    if (/^4\d\d /.test(error.message)) throw error;
    const stale = await readFile(file).catch(ignore);
    if (!stale) throw error;
    console.warn(`harness: serving cached ${url}: ${error.message}`);
    return null;
  });
  return body ? save(file, body) : readFile(file);
}

export async function download(url) {
  const { host, pathname, search } = new URL(url);
  const query = search ? encodeURIComponent(search) : '';
  const path = `./${host}${pathname}${query}`;
  if (mutable(url)) {
    const file = new URL(`${path}/index.json`.replaceAll('%', '%25'), store);
    if (!fresh.has(url)) {
      const pending = refresh(url, file);
      fresh.set(url, pending);
      pending.catch(() => fresh.delete(url));
    }
    return fresh.get(url);
  }
  const file = new URL(path.replaceAll('%', '%25'), store);
  const hit = await readFile(file).catch(ignore);
  if (hit) return hit;
  return save(file, await fetched(url));
}

export async function cdn(cdp, remotes) {
  const state = { status: 0, corrupt: false, requests: [] };
  const reset = () => {
    state.status = 0;
    state.corrupt = false;
    state.requests.length = 0;
  };

  async function fulfil({ requestId, request }) {
    state.requests.push(request.url);
    if (state.status) {
      const failure = { requestId, responseCode: state.status, responseHeaders: cors };
      return cdp.send('Fetch.fulfillRequest', failure);
    }
    const body = await download(request.url).catch((error) => {
      console.warn(`harness: could not serve ${request.url}: ${error.message}`);
    });
    if (!body) return cdp.send('Fetch.failRequest', { requestId, errorReason: 'Failed' });
    const sent = Buffer.from(body);
    if (state.corrupt) sent[sent.length - 1] ^= 0xff;
    return cdp.send('Fetch.fulfillRequest', {
      requestId,
      responseCode: 200,
      responseHeaders: [
        ...cors,
        { name: 'content-type', value: type(new URL(request.url).pathname) },
      ],
      body: sent.toString('base64'),
    });
  }

  if (remotes.length > 0) {
    cdp.on(async ({ method, params }) => {
      if (method === 'Fetch.requestPaused') await fulfil(params).catch(ignore);
    });
    const patterns = remotes.map((remote) => ({ urlPattern: `${remote}*` }));
    await cdp.send('Fetch.enable', { patterns });
  }
  return { state, reset };
}
