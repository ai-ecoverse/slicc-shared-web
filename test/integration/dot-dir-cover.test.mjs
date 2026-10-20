import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const bin = join(repo, 'bin', 'slicc-unit-cover.mjs');
const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const has = (command) => spawnSync('sh', ['-c', `command -v ${command}`]).status === 0;

function git(dir, ...args) {
  const run = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout;
}

function write(dir, files) {
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
}

async function fixture() {
  const base = realpathSync(await mkdtemp(join(tmpdir(), 'slicc-dot-dir-')));
  dirs.push(base);
  const dir = join(base, '.bb', 'worktrees', 'fixture');
  write(dir, {
    '.gitignore': 'node_modules/\ncoverage/\ntest/unit/\n',
    'package.json': JSON.stringify({
      name: 'fixture',
      private: true,
      type: 'module',
      scripts: {
        'test:unit':
          "NODE_NO_WARNINGS=1 mcr -c node_modules/@ai-ecoverse/slicc-shared-web/mcr.config.mjs node --test 'test/unit/**/*.test.mjs'",
      },
    }),
    'src/a.mjs': 'export const a = (x) => x + 1;\n',
    'src/b.mjs': 'export const b = (x) => x * 2;\n',
    'test/unit/a.test.mjs':
      "import { test } from 'node:test';\nimport { a } from '../../src/a.mjs';\ntest('a', () => a(1));\n",
  });
  mkdirSync(join(dir, 'node_modules', '@ai-ecoverse'), { recursive: true });
  mkdirSync(join(dir, 'node_modules', '.bin'));
  symlinkSync(repo, join(dir, 'node_modules', '@ai-ecoverse', 'slicc-shared-web'));
  const mcr = join(repo, 'node_modules', 'monocart-coverage-reports');
  symlinkSync(mcr, join(dir, 'node_modules', 'monocart-coverage-reports'));
  symlinkSync(join(mcr, 'lib', 'cli.js'), join(dir, 'node_modules', '.bin', 'mcr'));
  let path = process.env.PATH;
  if (!has('uvx')) {
    assert.ok(has('pipx'), 'diff-cover needs uvx, or pipx to stand in for it');
    const shims = join(base, 'shims');
    mkdirSync(shims);
    writeFileSync(
      join(shims, 'uvx'),
      '#!/bin/sh\nshift\nexec pipx run --spec diff-cover==10.6.0 diff-cover "$@"\n'
    );
    chmodSync(join(shims, 'uvx'), 0o755);
    path = `${shims}${delimiter}${path}`;
  }
  git(dir, 'init', '-q');
  git(dir, 'add', '-A');
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init', '--no-verify');
  return { dir, path };
}

function cover({ dir, path }) {
  const env = { ...process.env, PATH: path };
  for (const key of [
    'NODE_TEST_CONTEXT',
    'NODE_V8_COVERAGE',
    'NODE_OPTIONS',
    'SLICC_UNIT_TESTS',
    'SLICC_UNIT_ALL',
    'SLICC_UNIT_COVERAGE_DIR',
  ]) {
    delete env[key];
  }
  return spawnSync(process.execPath, [bin], { cwd: dir, encoding: 'utf8', env });
}

test('in a checkout under a dot-directory, an uncovered staged line fails diff coverage until a unit test covers it', async () => {
  const fx = await fixture();
  write(fx.dir, { 'src/b.mjs': 'export const b = (x) => x * 3;\n' });
  git(fx.dir, 'add', 'src/b.mjs');
  const uncovered = cover(fx);
  assert.match(uncovered.stderr, /running 0 of 1 unit test files/);
  assert.notEqual(uncovered.status, 0, uncovered.stdout);
  assert.match(uncovered.stdout, /src\/b\.mjs \(0\.0%\): Missing lines 1/);
  assert.match(uncovered.stdout, /slicc-unit-cover: FAIL diff coverage is not 100%/);
  write(fx.dir, {
    'test/unit/b.test.mjs':
      "import { test } from 'node:test';\nimport { b } from '../../src/b.mjs';\ntest('b', () => b(1));\n",
  });
  const covered = cover(fx);
  assert.equal(covered.status, 0, `${covered.stdout}\n${covered.stderr}`);
  assert.match(covered.stderr, /running 1 of 2 unit test files/);
  assert.match(covered.stdout, /slicc-unit-cover: PASS 1 unit test files in 1 batch/);
});
