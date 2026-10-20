import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { inSources, unitSources } from '../../unit/sources.mjs';

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

async function fixture(slicc) {
  const dir = realpathSync(await mkdtemp(join(tmpdir(), 'slicc-unit-sources-')));
  dirs.push(dir);
  write(dir, {
    '.gitignore': 'node_modules/\ncoverage/\ntest/unit/\n',
    'package.json': JSON.stringify({
      name: 'fixture',
      private: true,
      type: 'module',
      ...(slicc ? { slicc } : {}),
      scripts: {
        'test:unit':
          "NODE_NO_WARNINGS=1 mcr -c node_modules/@ai-ecoverse/slicc-shared-web/mcr.config.mjs node --test 'test/unit/**/*.test.mjs'",
      },
    }),
    'src/a.mjs': 'export const a = (x) => x + 1;\n',
    'extension/e.mjs': 'export const e = (x) => x + 1;\n',
    'six/s.ts': 'export const s = (x: number): number => x + 1;\n',
    'scripts/c.mjs': 'export const c = (x) => x + 1;\n',
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
  ])
    delete env[key];
  return spawnSync(process.execPath, [bin], { cwd: dir, encoding: 'utf8', env });
}

const stage = (fx, files) => {
  write(fx.dir, files);
  git(fx.dir, 'add', ...Object.keys(files));
};

test('unitSources: the default is src only; a list in package.json slicc.unitSources names repo-relative directories, and anything else is refused', async () => {
  const plain = await fixture();
  assert.equal(unitSources(plain.dir), null);
  assert.equal(inSources('src/a.mjs', plain.dir), true);
  assert.equal(inSources('packages/x/src/a.mjs', plain.dir), true);
  assert.equal(inSources('extension/e.mjs', plain.dir), false);
  const custom = await fixture({ unitSources: ['extension', 'six'] });
  assert.deepEqual(unitSources(custom.dir), ['extension', 'six']);
  assert.equal(inSources('extension/e.mjs', custom.dir), true);
  assert.equal(inSources('six/s.ts', custom.dir), true);
  assert.equal(inSources('scripts/c.mjs', custom.dir), false);
  assert.equal(inSources('src/a.mjs', custom.dir), false);
  assert.equal(inSources('extension/node_modules/x.mjs', custom.dir), false);
  for (const bad of [[], 'src', ['../x'], ['/abs'], [3]]) {
    const fx = await fixture({ unitSources: bad });
    assert.throws(() => unitSources(fx.dir), /slicc\.unitSources must be/, JSON.stringify(bad));
  }
});

test('the default is unchanged: a staged file outside src is no code for the hook, and src is still diff-covered', async () => {
  const fx = await fixture();
  stage(fx, { 'scripts/c.mjs': 'export const c = (x) => x + 2;\n' });
  const outside = cover(fx);
  assert.equal(outside.status, 0, outside.stdout);
  assert.match(outside.stdout, /slicc-unit-cover: PASS no code staged/);
  stage(fx, { 'src/a.mjs': 'export const a = (x) => x + 3;\n' });
  const inside = cover(fx);
  assert.notEqual(inside.status, 0, inside.stdout);
  assert.match(inside.stdout, /src\/a\.mjs \(0\.0%\): Missing lines 1/);
});

test('a listed non-src directory is diff-covered (TypeScript stripped), and a file outside the list is skipped', async () => {
  const fx = await fixture({ unitSources: ['extension', 'six'] });
  stage(fx, {
    'extension/e.mjs': 'export const e = (x) => x + 2;\n',
    'six/s.ts': 'export const s = (x: number): number => x + 2;\n',
    'scripts/c.mjs': 'export const c = (x) => x + 2;\n',
  });
  const uncovered = cover(fx);
  assert.notEqual(uncovered.status, 0, uncovered.stdout);
  assert.match(uncovered.stdout, /extension\/e\.mjs \(0\.0%\): Missing lines 1/);
  assert.match(uncovered.stdout, /six\/s\.ts \(0\.0%\): Missing lines 1/);
  assert.doesNotMatch(uncovered.stdout, /scripts\/c\.mjs/);
  write(fx.dir, {
    'test/unit/e.test.mjs':
      "import { test } from 'node:test';\nimport { e } from '../../extension/e.mjs';\nimport { s } from '../../six/s.ts';\ntest('e', () => e(1) + s(1));\n",
  });
  const covered = cover(fx);
  assert.equal(covered.status, 0, `${covered.stdout}\n${covered.stderr}`);
  assert.match(covered.stdout, /slicc-unit-cover: PASS 1 unit test files in 1 batch/);
});
