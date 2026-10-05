import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cache, ignore } from './util.mjs';

const cors = [{ name: 'access-control-allow-origin', value: '*' }];
const store = new URL('cdn/', cache);

export async function download(url) {
  const { host, pathname } = new URL(url);
  const file = new URL(`./${host}${pathname}`, store);
  const hit = await readFile(file).catch(ignore);
  if (hit) return hit;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  const body = Buffer.from(await response.arrayBuffer());
  await mkdir(dirname(fileURLToPath(file)), { recursive: true });
  const partial = new URL(`${file.href}.${process.pid}`);
  await writeFile(partial, body);
  await rename(partial, file);
  return body;
}

function contentType(url) {
  return new URL(url).pathname.endsWith('.js') ? 'text/javascript' : 'application/octet-stream';
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
    const body = await download(request.url).catch(ignore);
    if (!body) return cdp.send('Fetch.failRequest', { requestId, errorReason: 'Failed' });
    const sent = Buffer.from(body);
    if (state.corrupt) sent[sent.length - 1] ^= 0xff;
    return cdp.send('Fetch.fulfillRequest', {
      requestId,
      responseCode: 200,
      responseHeaders: [...cors, { name: 'content-type', value: contentType(request.url) }],
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
