import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const pnpmfile = fileURLToPath(new URL('../../pnpmfile.mjs', import.meta.url));
const pnpm = fileURLToPath(new URL('../../node_modules/.bin/pnpm', import.meta.url));
const dirs = [];
after(() => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))));

async function lock(settings) {
  const dir = await mkdtemp(join(tmpdir(), 'slicc-pnpm-'));
  dirs.push(dir);
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({
      name: 'probe',
      private: true,
      dependencies: { '@ai-ecoverse/wasm-jq': '1.8.1-1' },
    })
  );
  await writeFile(join(dir, 'pnpm-workspace.yaml'), `minimumReleaseAge: 100000000\n${settings}`);
  const result = await run(pnpm, ['install', '--lockfile-only'], {
    cwd: dir,
  }).then(
    () => '',
    (error) => `${error.stdout}${error.stderr}`
  );
  const locked = await access(join(dir, 'pnpm-lock.yaml')).then(
    () => true,
    () => false
  );
  return { locked, result };
}

test('pnpm holds back an @ai-ecoverse release younger than minimumReleaseAge', async () => {
  const { locked, result } = await lock('');
  assert.equal(locked, false);
  assert.match(result, /ERR_PNPM_NO_MATURE_MATCHING_VERSION/);
});

test('the shared pnpmfile lets @ai-ecoverse releases through at any age', async () => {
  const { locked, result } = await lock(`pnpmfile: ${JSON.stringify(pnpmfile)}\n`);
  assert.equal(result, '');
  assert.equal(locked, true);
});
