import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { commitAll, initFixtureRepo } from '@ai-ecoverse/slicc-shared-web/testing';

const repo = fileURLToPath(new URL('../../', import.meta.url));
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

async function copy() {
  const base = realpathSync(await mkdtemp(join(tmpdir(), 'slicc-self-cover-')));
  dirs.push(base);
  const dir = join(base, 'shared-web');
  for (const file of git(repo, 'ls-files', '-z').split('\0').filter(Boolean)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    copyFileSync(join(repo, file), join(dir, file));
  }
  symlinkSync(join(repo, 'node_modules'), join(dir, 'node_modules'));
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
  initFixtureRepo(dir, { hooks: false });
  commitAll(dir, 'init');
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
  return spawnSync(process.execPath, [join(dir, 'bin', 'slicc-unit-cover.mjs')], {
    cwd: dir,
    encoding: 'utf8',
    env,
  });
}

test('this repo names its own code directories as unit sources, and none of them is src', () => {
  const { slicc } = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
  assert.deepEqual(slicc?.unitSources, ['bin', 'harness', 'testing', 'unit']);
});

test("in a copy of this repo, an uncovered staged line in bin/, harness/, testing/ or unit/ fails this repo's own diff-coverage hook", async () => {
  const fx = await copy();
  const files = {
    'bin/self-cover.mjs': 'export const b = (x) => x + 1;\n',
    'harness/self-cover.mjs': 'export const h = (x) => x + 1;\n',
    'testing/self-cover.mjs': 'export const t = (x) => x + 1;\n',
    'unit/self-cover.mjs': 'export const u = (x) => x + 1;\n',
  };
  write(fx.dir, files);
  git(fx.dir, 'add', ...Object.keys(files));
  const uncovered = cover(fx);
  assert.notEqual(uncovered.status, 0, `${uncovered.stdout}\n${uncovered.stderr}`);
  assert.doesNotMatch(uncovered.stdout, /no code staged/);
  for (const file of Object.keys(files)) {
    const escaped = file.replace(/[./]/g, (c) => `\\${c}`);
    assert.match(uncovered.stdout, new RegExp(`${escaped} \\(0\\.0%\\): Missing lines 1`));
  }
  assert.match(uncovered.stdout, /slicc-unit-cover: FAIL diff coverage is not 100%/);
  write(fx.dir, {
    'test/unit/self-cover.test.mjs': [
      "import { test } from 'node:test';",
      "import { b } from '../../bin/self-cover.mjs';",
      "import { h } from '../../harness/self-cover.mjs';",
      "import { t } from '../../testing/self-cover.mjs';",
      "import { u } from '../../unit/self-cover.mjs';",
      "test('all', () => b(1) + h(1) + t(1) + u(1));",
      '',
    ].join('\n'),
  });
  const covered = cover(fx);
  assert.equal(covered.status, 0, `${covered.stdout}\n${covered.stderr}`);
  assert.match(covered.stdout, /slicc-unit-cover: PASS 1 unit test files in 1 batch/);
});
