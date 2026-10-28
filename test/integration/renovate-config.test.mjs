import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const repo = fileURLToPath(new URL('../..', import.meta.url));
const resolver = fileURLToPath(new URL('renovate-config/resolve.mjs', import.meta.url));
const lookup = fileURLToPath(new URL('renovate-config/lookup.mjs', import.meta.url));
let dir;

before(async () => {
  const ci = await readFile(join(repo, '.github/workflows/ci.yml'), 'utf8');
  const pin = /^\s*RENOVATE=(\S+)$/m.exec(ci);
  assert.ok(pin, 'RENOVATE=<version> pin not found in .github/workflows/ci.yml');
  const [, version] = pin;
  dir = await mkdtemp(join(tmpdir(), 'slicc-renovate-'));
  await writeFile(join(dir, 'package.json'), '{"private":true}');
  await run(
    'npm',
    ['install', '--no-audit', '--no-fund', '--ignore-scripts', `renovate@${version}`],
    { cwd: dir, maxBuffer: 16 * 1024 * 1024 }
  );
});

after(() => dir && rm(dir, { recursive: true, force: true }));

async function resolve(configFile) {
  const { stdout } = await run(process.execPath, [resolver, dir, repo, configFile], {
    maxBuffer: 16 * 1024 * 1024,
  });
  return JSON.parse(stdout.trim().split('\n').at(-1));
}

async function offered(configFile, depName, cases) {
  const args = [lookup, dir, repo, configFile, depName, ...cases];
  const { stdout } = await run(process.execPath, args);
  const result = JSON.parse(stdout.trim().split('\n').at(-1));
  return Object.fromEntries(result.map((r) => [`${r.currentValue}:${r.newVersion}`, r.offered]));
}

test("this repo's own Renovate PRs automerge through GitHub auto-merge, like every repo on the preset", async () => {
  for (const upgrade of await resolve(join(repo, 'renovate.json'))) {
    assert.equal(upgrade.automerge, true, upgrade.depName);
    assert.equal(upgrade.automergeType, 'pr', upgrade.depName);
    assert.equal(upgrade.platformAutomerge, true, upgrade.depName);
    assert.equal(upgrade.usePlatformAutomerge, true, upgrade.depName);
  }
});

test('a repo that only extends the preset keeps GitHub auto-merge', async () => {
  const consumer = join(dir, 'consumer.json');
  await writeFile(consumer, JSON.stringify({ extends: ['github>ai-ecoverse/slicc-shared-web'] }));
  for (const upgrade of await resolve(consumer)) {
    assert.equal(upgrade.automerge, true, upgrade.depName);
    assert.equal(upgrade.usePlatformAutomerge, true, upgrade.depName);
  }
});

test('a repo that extends the preset is never offered @biomejs/biome 2.6.0 or 2.6.1, which have no platform packages', async () => {
  const consumer = join(dir, 'biome-consumer.json');
  await writeFile(consumer, JSON.stringify({ extends: ['github>ai-ecoverse/slicc-shared-web'] }));
  const cases = {
    '2.5.15:2.6.0': false,
    '2.5.15:2.6.1': false,
    '2.5.15:2.6.2': true,
    '2.5.15:2.6.3': true,
    '2.5.0:2.5.15': true,
    '2.5.14:2.5.15': true,
  };
  assert.deepEqual(await offered(consumer, '@biomejs/biome', Object.keys(cases)), cases);
});
