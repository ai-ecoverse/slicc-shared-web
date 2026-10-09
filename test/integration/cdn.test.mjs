import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { promisify } from 'node:util';

const run = promisify(execFile);
const harness = new URL('../../harness/cdn.mjs', import.meta.url).href;
const dirs = [];
after(() => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))));

const packument = 'https://registry.npmjs.org/@ai-ecoverse%2fwasm-xxd';
const tarball = 'https://registry.npmjs.org/@ai-ecoverse/wasm-xxd/-/wasm-xxd-9.1.1850.tgz';
const script = `
const { download } = await import(process.env.HARNESS);
let calls = 0;
globalThis.fetch = async (url) => {
  calls++;
  if (process.env.UPSTREAM === 'down') throw new Error('offline');
  return new Response(process.env.UPSTREAM + ' ' + new URL(url).pathname.split('/').pop());
};
const urls = JSON.parse(process.env.URLS);
const bodies = [];
for (const url of [...urls, ...urls]) bodies.push(String(await download(url)));
console.log(JSON.stringify({ bodies, calls }));
`;

async function session(cwd, upstream) {
  const { stdout } = await run(process.execPath, ['--input-type=module', '-e', script], {
    cwd,
    env: {
      ...process.env,
      HARNESS: harness,
      UPSTREAM: upstream,
      URLS: JSON.stringify([packument, tarball]),
    },
  });
  return JSON.parse(stdout);
}

test('a packument is fetched fresh each run, a tarball comes from the cache', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'slicc-cdn-'));
  dirs.push(cwd);
  const pack = '@ai-ecoverse%2fwasm-xxd';
  const tgz = 'wasm-xxd-9.1.1850.tgz';
  assert.deepEqual(await session(cwd, 'v1'), {
    bodies: [`v1 ${pack}`, `v1 ${tgz}`, `v1 ${pack}`, `v1 ${tgz}`],
    calls: 2,
  });
  assert.deepEqual(await session(cwd, 'v2'), {
    bodies: [`v2 ${pack}`, `v1 ${tgz}`, `v2 ${pack}`, `v1 ${tgz}`],
    calls: 1,
  });
  assert.deepEqual(await session(cwd, 'down'), {
    bodies: [`v2 ${pack}`, `v1 ${tgz}`, `v2 ${pack}`, `v1 ${tgz}`],
    calls: 3,
  });
});
