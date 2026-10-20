import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const workflow = readFileSync(
  new URL('../../.github/workflows/node-release.yml', import.meta.url),
  'utf8'
);
const lines = workflow.slice(workflow.indexOf('\n  release:\n')).split('\n');
const runs = lines.flatMap((line, index) => {
  const single = line.match(/^ {6}[- ] run: (npx .*)$/);
  if (single) return [single[1]];
  if (line !== '        run: |') return [];
  const rest = lines.slice(index + 1);
  const end = rest.findIndex((next) => next !== '' && !next.startsWith(' '.repeat(10)));
  return [
    rest
      .slice(0, end === -1 ? undefined : end)
      .map((next) => next.slice(10))
      .join('\n'),
  ];
});
const step = runs.find((run) => run.includes('npx semantic-release'));

function release(t, failures, args) {
  const dir = mkdtempSync(join(tmpdir(), 'slicc-release-git-retry-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const calls = join(dir, 'calls');
  writeFileSync(calls, '');
  writeFileSync(
    join(dir, 'git'),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\nn=$(wc -l < '${calls}')\nif [ "$n" -le ${failures} ]; then echo ' ! [remote rejected] (failed)' >&2; exit 1; fi\necho ok\n`
  );
  writeFileSync(join(dir, 'npx'), `#!/bin/sh\nexec git ${args}\n`);
  chmodSync(join(dir, 'git'), 0o755);
  chmodSync(join(dir, 'npx'), 0o755);
  const result = spawnSync('bash', ['-e', '-c', step], {
    encoding: 'utf8',
    env: {
      PATH: `${dir}:${process.env.PATH}`,
      RUNNER_TEMP: dir,
      GIT_RETRY_DELAY_MS: '1',
    },
  });
  const count = readFileSync(calls, 'utf8').split('\n').filter(Boolean).length;
  return { ...result, count };
}

const notes = 'push https://example.invalid/repo.git refs/notes/semantic-release-v1.2.3';

test('the release step runs semantic-release', () => {
  assert.match(step ?? '', /npx semantic-release/);
});

test('a push that fails twice is retried and the release goes on', (t) => {
  const run = release(t, 2, notes);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.count, 3);
  assert.match(run.stdout, /ok/);
  assert.match(run.stderr, /attempt 2 of 5/);
});

test('a fetch that fails once is retried', (t) => {
  const run = release(t, 1, 'fetch --tags');
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.count, 2);
});

test('a push that keeps failing fails the step after five attempts', (t) => {
  const run = release(t, 99, notes);
  assert.equal(run.status, 1);
  assert.equal(run.count, 5);
});

test('a fetch --unshallow, which fails on a full clone, runs once', (t) => {
  const run = release(t, 99, 'fetch --unshallow --tags https://example.invalid/repo.git');
  assert.equal(run.status, 1);
  assert.equal(run.count, 1);
});

test('a command that is not a push or fetch runs once', (t) => {
  const run = release(t, 99, 'tag v1.2.3');
  assert.equal(run.status, 1);
  assert.equal(run.count, 1);
});
