import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function lint(silent) {
  const dir = mkdtempSync(join(tmpdir(), 'slicc-lint-'));
  dirs.push(dir);
  cpSync(join(repo, 'bin'), dir, { recursive: true });
  if (silent) {
    writeFileSync(join(dir, `${silent}.sh`), '#!/bin/sh\nexit 0\n');
    chmodSync(join(dir, `${silent}.sh`), 0o755);
  }
  return spawnSync('sh', [join(dir, 'slicc-lint.sh')], { cwd: repo, encoding: 'utf8' });
}

const STEPS = ['slicc-lint-comments', 'slicc-no-unit-tests', 'slicc-agents-md'];

test('a clean repo prints every step PASS, then slicc-lint: PASS as the last line', () => {
  const run = lint();
  assert.equal(run.status, 0, run.stderr);
  const lines = run.stdout.trim().split('\n');
  for (const step of ['biome', ...STEPS]) {
    assert.ok(
      lines.some((line) => line.startsWith(`${step}: PASS`)),
      `${step}: PASS in ${run.stdout}`
    );
  }
  assert.equal(lines.at(-1), 'slicc-lint: PASS');
});

for (const step of STEPS) {
  test(`a ${step} that exits 0 without its PASS line fails slicc-lint with 70 and no overall PASS`, () => {
    const run = lint(step);
    assert.equal(run.status, 70, run.stdout + run.stderr);
    assert.match(
      run.stderr,
      new RegExp(`^slicc-lint: FAIL ${step} \\(no PASS line from it\\)$`, 'm')
    );
    assert.doesNotMatch(run.stdout, /^slicc-lint: PASS$/m);
  });
}
