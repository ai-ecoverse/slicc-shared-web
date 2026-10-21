import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { commit, commitAll, initFixtureRepo } from '@ai-ecoverse/slicc-shared-web/testing';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const bin = join(repo, 'bin', 'slicc-unit-cover.mjs');
const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const has = (command) => spawnSync('sh', ['-c', `command -v ${command}`]).status === 0;

function git(dir, args, ok = true) {
  const run = spawnSync('git', args, {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, GIT_EDITOR: 'true', GIT_MERGE_AUTOEDIT: 'no' },
  });
  if (ok) assert.equal(run.status, 0, run.stderr);
  return run;
}

function write(dir, files) {
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
}

const uncovered = (name) => `export function ${name}() {\n  return '${name}';\n}\n`;

async function fixture() {
  const dir = realpathSync(await mkdtemp(join(tmpdir(), 'slicc-merge-cover-')));
  dirs.push(dir);
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
    'src/m.mjs': "export const m = () => 'm';\n",
    'test/unit/a.test.mjs':
      "import { test } from 'node:test';\nimport { a } from '../../src/a.mjs';\nimport { m } from '../../src/m.mjs';\ntest('a', () => {\n  a(1);\n  m();\n});\n",
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
    const shims = join(dir, '..', `shims-${Date.now()}`);
    mkdirSync(shims);
    dirs.push(shims);
    writeFileSync(
      join(shims, 'uvx'),
      '#!/bin/sh\nshift\nexec pipx run --spec diff-cover==10.6.0 diff-cover "$@"\n'
    );
    chmodSync(join(shims, 'uvx'), 0o755);
    path = `${shims}${delimiter}${path}`;
  }
  initFixtureRepo(dir);
  commitAll(dir, 'init');
  const main = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
  git(dir, ['switch', '-q', '-c', 'side']);
  return { dir, path, main };
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
  ])
    delete env[key];
  return spawnSync(process.execPath, [bin], { cwd: dir, encoding: 'utf8', env });
}

const stage = (dir, files) => {
  write(dir, files);
  git(dir, ['add', '--', ...Object.keys(files)]);
};

const save = (dir, files, message) => {
  stage(dir, files);
  commit(dir, message);
};

test('merging main into a branch asks no coverage for what main brought, only for lines new to both sides', async () => {
  const fx = await fixture();
  save(fx.dir, { 'src/a.mjs': 'export const a = (x) => x + 2;\n' }, 'side');
  git(fx.dir, ['switch', '-q', fx.main]);
  save(fx.dir, { 'src/m.mjs': `export const m = () => 'm';\n${uncovered('main')}` }, 'main');
  git(fx.dir, ['switch', '-q', 'side']);
  git(fx.dir, ['merge', '-q', '--no-ff', '--no-commit', fx.main]);
  const clean = cover(fx);
  assert.equal(clean.status, 0, clean.stdout + clean.stderr);
  assert.match(clean.stdout, /slicc-unit-cover: PASS no code staged/);
  stage(fx.dir, { 'src/a.mjs': `export const a = (x) => x + 2;\n${uncovered('own')}` });
  const own = cover(fx);
  assert.equal(own.status, 1, own.stdout + own.stderr);
  assert.match(own.stdout, /src\/a\.mjs \([\d.]+%\): Missing lines 3$/m);
  assert.doesNotMatch(own.stdout, /src\/m\.mjs/);
});

test('a conflict resolution taken from one side passes, and one with a new uncovered line fails naming only it', async () => {
  const fx = await fixture();
  save(fx.dir, { 'src/a.mjs': 'export const a = (x) => x + 2;\n' }, 'side');
  git(fx.dir, ['switch', '-q', fx.main]);
  save(
    fx.dir,
    {
      'src/a.mjs': 'export const a = (x) => x + 3;\n',
      'src/m.mjs': `export const m = () => 'm';\n${uncovered('main')}`,
    },
    'main'
  );
  git(fx.dir, ['switch', '-q', 'side']);
  assert.notEqual(git(fx.dir, ['merge', '-q', '--no-ff', fx.main], false).status, 0);
  stage(fx.dir, { 'src/a.mjs': 'export const a = (x) => x + 3;\n' });
  const taken = cover(fx);
  assert.equal(taken.status, 0, taken.stdout + taken.stderr);
  assert.match(taken.stdout, /slicc-unit-cover: PASS no code staged/);
  stage(fx.dir, { 'src/a.mjs': `export const a = (x) => x + 4;\n${uncovered('resolved')}` });
  const resolved = cover(fx);
  assert.equal(resolved.status, 1, resolved.stdout + resolved.stderr);
  assert.match(resolved.stdout, /src\/a\.mjs \([\d.]+%\): Missing lines 3$/m);
  assert.doesNotMatch(resolved.stdout, /src\/m\.mjs/);
});

test('a conflicted cherry-pick asks no coverage for the picked lines, only for the resolution', async () => {
  const fx = await fixture();
  save(fx.dir, { 'src/a.mjs': 'export const a = (x) => x + 2;\n' }, 'side');
  git(fx.dir, ['switch', '-q', fx.main]);
  save(
    fx.dir,
    {
      'src/a.mjs': 'export const a = (x) => x + 3;\n',
      'src/m.mjs': `export const m = () => 'm';\n${uncovered('main')}`,
    },
    'main'
  );
  git(fx.dir, ['switch', '-q', 'side']);
  assert.notEqual(git(fx.dir, ['cherry-pick', fx.main], false).status, 0);
  stage(fx.dir, { 'src/a.mjs': 'export const a = (x) => x + 3;\n' });
  const picked = cover(fx);
  assert.equal(picked.status, 0, picked.stdout + picked.stderr);
  assert.match(picked.stdout, /slicc-unit-cover: PASS no code staged/);
  stage(fx.dir, { 'src/a.mjs': `export const a = (x) => x + 4;\n${uncovered('resolved')}` });
  const resolved = cover(fx);
  assert.equal(resolved.status, 1, resolved.stdout + resolved.stderr);
  assert.match(resolved.stdout, /src\/a\.mjs \([\d.]+%\): Missing lines 3$/m);
  assert.doesNotMatch(resolved.stdout, /src\/m\.mjs/);
});

test('in a merge, a file whose name has a space is still diff-covered', async () => {
  const fx = await fixture();
  save(fx.dir, { 'src/a b.mjs': 'export const s = 1;\n' }, 'side');
  git(fx.dir, ['switch', '-q', fx.main]);
  save(fx.dir, { 'src/m.mjs': `export const m = () => 'm';\n${uncovered('main')}` }, 'main');
  git(fx.dir, ['switch', '-q', 'side']);
  git(fx.dir, ['merge', '-q', '--no-ff', '--no-commit', fx.main]);
  stage(fx.dir, { 'src/a b.mjs': `export const s = 1;\n${uncovered('own')}` });
  const own = cover(fx);
  assert.equal(own.status, 1, own.stdout + own.stderr);
  assert.doesNotMatch(own.stdout, /no code staged/);
  assert.match(own.stdout, /src\/a b\.mjs \([\d.]+%\): Missing lines \d/);
  assert.doesNotMatch(own.stdout, /src\/m\.mjs/);
});

test('once a conflicted rebase has finished, the next commit is diff-covered as usual', async () => {
  const fx = await fixture();
  save(fx.dir, { 'src/a.mjs': `export const a = (x) => x + 2;\n${uncovered('side')}` }, 'side');
  git(fx.dir, ['switch', '-q', fx.main]);
  save(fx.dir, { 'src/a.mjs': 'export const a = (x) => x + 3;\n' }, 'main');
  git(fx.dir, ['switch', '-q', 'side']);
  assert.notEqual(git(fx.dir, ['rebase', fx.main], false).status, 0);
  stage(fx.dir, { 'src/a.mjs': 'export const a = (x) => x + 4;\n' });
  git(fx.dir, ['rebase', '--continue']);
  stage(fx.dir, { 'src/a.mjs': `export const a = (x) => x + 4;\n${uncovered('side')}` });
  const later = cover(fx);
  assert.equal(later.status, 1, later.stdout + later.stderr);
  assert.match(later.stdout, /src\/a\.mjs \([\d.]+%\): Missing lines 3$/m);
});

test('a conflict resolution that drops a line both sides had runs the unit tests', async () => {
  const fx = await fixture();
  save(
    fx.dir,
    { 'src/m.mjs': "export const m = () => 'm';\nexport const shared = 1;\n" },
    'shared'
  );
  git(fx.dir, ['switch', '-q', fx.main]);
  git(fx.dir, ['merge', '-q', '--ff-only', 'side']);
  save(
    fx.dir,
    { 'src/m.mjs': "export const m = () => 'main';\nexport const shared = 1;\n" },
    'main'
  );
  git(fx.dir, ['switch', '-q', 'side']);
  save(
    fx.dir,
    { 'src/m.mjs': "export const m = () => 'side';\nexport const shared = 1;\n" },
    'side'
  );
  assert.notEqual(git(fx.dir, ['merge', '-q', '--no-ff', fx.main], false).status, 0);
  stage(fx.dir, { 'src/m.mjs': "export const m = () => 'main';\n" });
  const dropped = cover(fx);
  assert.equal(dropped.status, 0, dropped.stdout + dropped.stderr);
  assert.doesNotMatch(dropped.stdout, /no code staged/);
  assert.match(
    dropped.stdout,
    /slicc-unit-cover: PASS 1 unit test files in 1 batch, diff coverage 100%/
  );
});

test('deleting during a merge a file the other side renamed runs the unit tests', async () => {
  const fx = await fixture();
  save(fx.dir, { 'src/a.mjs': 'export const a = (x) => x + 2;\n' }, 'side');
  git(fx.dir, ['switch', '-q', fx.main]);
  write(fx.dir, { 'src/n.mjs': "export const m = () => 'm';\n" });
  git(fx.dir, ['rm', '-q', '--', 'src/m.mjs']);
  git(fx.dir, ['add', '--', 'src/n.mjs']);
  commit(fx.dir, 'rename');
  git(fx.dir, ['switch', '-q', 'side']);
  git(fx.dir, ['merge', '-q', '--no-ff', '--no-commit', fx.main]);
  git(fx.dir, ['rm', '-q', '-f', '--', 'src/n.mjs']);
  const removed = cover(fx);
  assert.doesNotMatch(removed.stdout, /no code staged/);
  assert.match(removed.stderr, /running 1 of 1 unit test files/);
});
