import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
  if (process.env.UPSTREAM === 'gone') return new Response('', { status: 404 });
  return new Response(process.env.UPSTREAM + ' ' + new URL(url).pathname.split('/').pop());
};
const urls = JSON.parse(process.env.URLS);
const bodies = [];
for (const url of [...urls, ...urls]) bodies.push(String(await download(url).catch((error) => error.message)));
console.log(JSON.stringify({ bodies, calls }));
`;

async function session(cwd, upstream, urls = [packument, tarball]) {
  const { stdout } = await run(process.execPath, ['--input-type=module', '-e', script], {
    cwd,
    env: {
      ...process.env,
      HARNESS: harness,
      UPSTREAM: upstream,
      URLS: JSON.stringify(urls),
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
  assert.deepEqual(await session(cwd, 'gone'), {
    bodies: [`404 ${packument}`, `v1 ${tgz}`, `404 ${packument}`, `v1 ${tgz}`],
    calls: 2,
  });
});

const unscoped = 'https://registry.npmjs.org/left-pad';
const unscopedTarball = 'https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz';

for (const urls of [
  [unscopedTarball, unscoped],
  [unscoped, unscopedTarball],
]) {
  test(`an unscoped packument and its tarball both cache, ${urls[0] === unscoped ? 'packument' : 'tarball'} first`, async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'slicc-cdn-'));
    dirs.push(cwd);
    const names = urls.map((url) => `v1 ${new URL(url).pathname.split('/').pop()}`);
    assert.deepEqual(await session(cwd, 'v1', urls), { bodies: [...names, ...names], calls: 2 });
    const again = urls.map((url) => (url === unscoped ? 'v2 left-pad' : 'v1 left-pad-1.3.0.tgz'));
    assert.deepEqual(await session(cwd, 'v2', urls), { bodies: [...again, ...again], calls: 1 });
    assert.deepEqual(await session(cwd, 'down', urls), { bodies: [...again, ...again], calls: 3 });
  });
}

test('a packument cached where its tarball directory goes is a miss, and is replaced', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'slicc-cdn-'));
  dirs.push(cwd);
  const registry = join(cwd, 'node_modules/.cache/slicc-harness/cdn/registry.npmjs.org');
  await mkdir(registry, { recursive: true });
  await writeFile(join(registry, 'left-pad'), 'old left-pad');
  const urls = [unscoped, unscopedTarball];
  assert.deepEqual(await session(cwd, 'down', urls), {
    bodies: ['offline', 'offline', 'offline', 'offline'],
    calls: 12,
  });
  const names = ['v1 left-pad', 'v1 left-pad-1.3.0.tgz'];
  assert.deepEqual(await session(cwd, 'v1', urls), { bodies: [...names, ...names], calls: 2 });
});

test('downloads racing to replace an old packument file all succeed', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'slicc-cdn-'));
  dirs.push(cwd);
  const registry = join(cwd, 'node_modules/.cache/slicc-harness/cdn/registry.npmjs.org');
  await mkdir(registry, { recursive: true });
  await writeFile(join(registry, 'left-pad'), 'old left-pad');
  const { stdout } = await run(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `const { download } = await import(process.env.HARNESS);
globalThis.fetch = async (url) => new Response(new URL(url).pathname.split('/').pop());
const urls = ['1.1.0', '1.2.0', '1.3.0'].map((v) => 'https://registry.npmjs.org/left-pad/-/left-pad-' + v + '.tgz');
const bodies = await Promise.all(urls.map((url) => download(url).then(String, (error) => error.message)));
console.log(JSON.stringify(bodies));`,
    ],
    { cwd, env: { ...process.env, HARNESS: harness } }
  );
  assert.deepEqual(JSON.parse(stdout), [
    'left-pad-1.1.0.tgz',
    'left-pad-1.2.0.tgz',
    'left-pad-1.3.0.tgz',
  ]);
});
