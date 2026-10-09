import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

export const isolation = {
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-embedder-policy': 'require-corp',
  'cross-origin-resource-policy': 'same-origin',
};

const types = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
};

export function type(path) {
  return types[extname(path)] ?? 'application/octet-stream';
}

export function locator(roots) {
  const mounted = roots.map(([prefix, dir]) => [prefix, `${resolve(dir)}${sep}`]);
  return (pathname) => {
    const found = mounted.find(([prefix]) => pathname.startsWith(prefix));
    if (!found) return null;
    const [prefix, root] = found;
    const rel = pathname.slice(prefix.length);
    const file = join(root, normalize(rel === '' || rel.endsWith('/') ? `${rel}index.html` : rel));
    return file.startsWith(root) ? file : null;
  };
}

export async function serve({
  roots = [['/', 'src/']],
  aliases = [],
  isolated = false,
  port = 0,
} = {}) {
  const headers = isolated ? isolation : {};
  const locate = locator(roots);
  const lookup = locator([...aliases, ...roots]);
  const requests = [];
  const overrides = new Map();
  const overridden = new Set();
  const server = createServer(async (request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    requests.push(pathname);
    if (overrides.has(pathname)) {
      overridden.add(pathname);
      return response
        .writeHead(200, { ...headers, 'content-type': type(pathname), 'cache-control': 'no-cache' })
        .end(overrides.get(pathname));
    }
    const file = locate(pathname);
    const found = file && (await stat(file).catch(() => null))?.isFile();
    if (!found) return response.writeHead(404, headers).end();
    response.writeHead(200, {
      ...headers,
      'content-type': type(file),
      'cache-control': 'no-cache',
    });
    createReadStream(file).pipe(response);
  });
  await new Promise((done) => server.listen(port, '127.0.0.1', done));
  const url = `http://127.0.0.1:${server.address().port}/`;
  return {
    url,
    requests,
    overrides,
    overridden,
    locate,
    source: (href) =>
      href.startsWith(url) ? lookup(decodeURIComponent(new URL(href).pathname)) : null,
    close: () =>
      new Promise((done) => {
        server.close(done);
        server.closeAllConnections();
      }),
  };
}
