import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const workflow = readFileSync(
  new URL('../../.github/workflows/pipeline.yml', import.meta.url),
  'utf8'
);
const step = workflow
  .split('      - name: semantic-release\n')[1]
  .split('        run: |\n')[1]
  .split('\n      - id: released')[0]
  .split('\n')
  .map((line) => line.slice(10))
  .join('\n');

function release(
  t,
  { error = 'TLOG_CREATE_ENTRY_ERROR', failures = 1, visible = '', command, dryRun = false } = {}
) {
  const dir = mkdtempSync(join(tmpdir(), 'slicc-release-npm-retry-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pkgDir = join(dir, 'publish directory');
  mkdirSync(pkgDir);
  writeFileSync(
    join(pkgDir, 'package.json'),
    JSON.stringify({ name: '@test/pkg', version: '1.2.3' })
  );
  const calls = join(dir, 'calls');
  writeFileSync(calls, '');
  const files = {
    npm: `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require('node:fs');
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');
if (args[0] === 'view') {
  console.log(${JSON.stringify(visible)});
  process.exit(${visible ? 0 : 1});
}
const count = readFileSync(${JSON.stringify(calls)}, 'utf8').trim().split('\\n').map(JSON.parse).filter((args) => args[0] === 'publish').length;
if (args[0] !== 'publish' || count <= ${failures}) {
  console.error(${JSON.stringify(error)});
  process.exit(42);
}
console.log('published');
`,
    npx: `#!/bin/sh\nexec npm ${command ?? `publish '${pkgDir}' ${dryRun ? '--dry-run' : '--provenance'} --tag latest --registry https://registry.example.invalid --userconfig '${join(dir, 'npmrc')}'`}\n`,
  };
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(dir, name), contents);
    chmodSync(join(dir, name), 0o755);
  }
  const result = spawnSync('bash', ['-e', '-c', step], {
    encoding: 'utf8',
    cwd: dir,
    env: { PATH: `${dir}:${process.env.PATH}`, RUNNER_TEMP: dir, NPM_RETRY_DELAY_MS: '1' },
  });
  const args = readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  return {
    ...result,
    publishes: args.filter((args) => args[0] === 'publish'),
    views: args.filter((args) => args[0] === 'view'),
  };
}

test('a transparency-log error is retried with the original publish arguments', (t) => {
  const run = release(t);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.publishes.length, 2);
  assert.deepEqual(run.publishes[0], run.publishes[1]);
  assert.ok(run.publishes[1].includes('--provenance'));
  assert.deepEqual(run.views[0].slice(0, 3), ['view', '@test/pkg@1.2.3', 'version']);
  assert.ok(run.views[0].includes('https://registry.example.invalid'));
});

test('a 409 whose exact version is visible counts as published', (t) => {
  const run = release(t, {
    error: '409: an equivalent entry already exists in the transparency log',
    visible: '1.2.3',
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.publishes.length, 1);
  assert.equal(run.views.length, 1);
});

test('other publish failures keep their exit status without a registry check', (t) => {
  const run = release(t, { error: 'E403 Forbidden' });
  assert.equal(run.status, 42);
  assert.equal(run.publishes.length, 1);
  assert.equal(run.views.length, 0);
  assert.match(run.stderr, /E403 Forbidden/);
});

test('a conflict that never lands fails after three attempts and three registry checks', (t) => {
  const run = release(t, { failures: 99 });
  assert.equal(run.status, 42);
  assert.equal(run.publishes.length, 3);
  assert.equal(run.views.length, 3);
});

test('a different registry version does not turn a failed publish into success', (t) => {
  const run = release(t, { failures: 99, visible: '1.2.2' });
  assert.equal(run.status, 42);
  assert.equal(run.publishes.length, 3);
});

test('an unrelated 409 is not retried', (t) => {
  const run = release(t, { error: '409 Conflict' });
  assert.equal(run.status, 42);
  assert.equal(run.publishes.length, 1);
  assert.equal(run.views.length, 0);
});

test('other npm subcommands pass through once with their exit status', (t) => {
  const run = release(t, { command: 'whoami' });
  assert.equal(run.status, 42);
  assert.equal(run.publishes.length, 0);
  assert.equal(run.views.length, 0);
});

for (const error of [
  'tlog_create_entry_error',
  'sigstore transparency log answered 409',
  '409 Conflict from Rekor',
]) {
  test(`a conflict reported as ${error} is retried`, (t) => {
    const run = release(t, { error });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.publishes.length, 2);
    assert.equal(run.views.length, 1);
  });
}

test('a dry run fails immediately even when the exact version is visible', (t) => {
  const run = release(t, { dryRun: true, visible: '1.2.3' });
  assert.equal(run.status, 42);
  assert.equal(run.publishes.length, 1);
  assert.equal(run.views.length, 0);
});
