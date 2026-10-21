import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
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

const box = (area) =>
  [
    'export enum Unit {',
    '  Metre,',
    '  Foot,',
    '}',
    'export class Box {',
    '  constructor(private readonly side: number, readonly unit: Unit = Unit.Metre) {}',
    '  area(): number {',
    `    return ${area};`,
    '  }',
    '  label(): string {',
    '    return Unit[this.unit];',
    '  }',
    '}',
    '',
  ].join('\n');

const tally = (step) =>
  [
    'export enum Step {',
    `  One = ${step},`,
    '}',
    'export const next = (n: number): number => n + Step.One;',
    '',
  ].join('\n');

const counter = (start) =>
  [
    'class Counter {',
    `  constructor(public count: number = ${start}) {}`,
    '}',
    'module.exports = { Counter };',
    '',
  ].join('\n');

async function fixture() {
  const dir = realpathSync(await mkdtemp(join(tmpdir(), 'slicc-ts-transform-')));
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
    'src/box.ts': box('this.side * this.side'),
    'src/tally.mts': tally(1),
    'src/counter.cts': counter(0),
    'src/idle.ts': 'enum Idle {\n  On,\n}\nexport const idle = (): Idle => Idle.On;\n',
    'test/unit/box.test.mjs': [
      "import assert from 'node:assert/strict';",
      "import { createRequire } from 'node:module';",
      "import { test } from 'node:test';",
      "import { Box, Unit } from '../../src/box.ts';",
      "import { next } from '../../src/tally.mts';",
      'const { Counter } = createRequire(import.meta.url)("../../src/counter.cts");',
      "test('box', () => {",
      '  assert.equal(new Box(3, Unit.Foot).area() > 0, true);',
      '  assert.equal(next(1) > 1, true);',
      '  assert.equal(new Counter().count >= 0, true);',
      '});',
      '',
    ].join('\n'),
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
    const shims = join(dir, 'node_modules', '.shims');
    mkdirSync(shims);
    writeFileSync(
      join(shims, 'uvx'),
      '#!/bin/sh\nshift\nexec pipx run --spec diff-cover==10.6.0 diff-cover "$@"\n'
    );
    chmodSync(join(shims, 'uvx'), 0o755);
    path = `${shims}${delimiter}${path}`;
  }
  initFixtureRepo(dir);
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
  const run = spawnSync(process.execPath, [bin], { cwd: dir, encoding: 'utf8', env });
  return { ...run, out: `${run.stdout}\n${run.stderr}` };
}

const lines = (dir, file) => {
  const lcov = readFileSync(join(dir, 'coverage', 'unit', 'lcov.info'), 'utf8');
  const part = lcov.split('end_of_record').find((one) => one.includes(`SF:${file}\n`)) ?? '';
  return Object.fromEntries(
    [...part.matchAll(/^DA:(\d+),(\d+)/gm)].map(([, line, hits]) => [Number(line), Number(hits)])
  );
};

test('TypeScript that needs a transform (enums, parameter properties) runs under the unit tests and its staged lines are measured against the original source', async () => {
  const fx = await fixture();
  write(fx.dir, {
    'src/box.ts': box('this.side * this.side * 1'),
    'src/tally.mts': tally(2),
    'src/counter.cts': counter(1),
  });
  git(fx.dir, 'add', 'src');
  const covered = cover(fx);
  assert.equal(covered.status, 0, covered.out);
  assert.match(covered.stdout, /slicc-unit-cover: PASS 1 unit test files in 1 batch/);
  assert.match(covered.stderr, /running 1 of 1 unit test files/);
  const boxed = lines(fx.dir, 'src/box.ts');
  assert.ok(boxed[6] > 0, JSON.stringify(boxed));
  assert.ok(boxed[8] > 0, JSON.stringify(boxed));
  assert.equal(boxed[11], 0, JSON.stringify(boxed));
  assert.ok(lines(fx.dir, 'src/tally.mts')[2] > 0);
  assert.ok(lines(fx.dir, 'src/counter.cts')[2] > 0);
  assert.deepEqual(Object.values(lines(fx.dir, 'src/idle.ts')).filter(Boolean), []);
  assert.ok(Object.keys(lines(fx.dir, 'src/idle.ts')).length > 0);
  git(fx.dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'covered');
  write(fx.dir, {
    'src/box.ts': box('this.side * this.side * 1').replace(
      'Unit[this.unit]',
      'Unit[this.unit] ?? ""'
    ),
  });
  git(fx.dir, 'add', 'src/box.ts');
  const uncovered = cover(fx);
  assert.notEqual(uncovered.status, 0, uncovered.out);
  assert.match(uncovered.stdout, /src\/box\.ts \(0\.0%\): Missing lines 11$/m);
  assert.match(uncovered.stdout, /slicc-unit-cover: FAIL diff coverage is not 100%/);
  assert.doesNotMatch(uncovered.out, /ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX/);
});

test('a TS-convention ./x.js specifier loads the sibling x.ts, and a package whose main is JSON imports without an attribute', async () => {
  const fx = await fixture();
  write(fx.dir, {
    'src/a.ts': [
      "import data from 'json-main';",
      "import { next } from './tally.mjs';",
      'export enum Kind {',
      '  Plain,',
      '  Fancy,',
      '}',
      'export const pick = (fancy: boolean): Kind => (fancy ? Kind.Fancy : Kind.Plain);',
      'export const sized = (): number => next(data.size);',
      '',
    ].join('\n'),
    'node_modules/json-main/package.json': JSON.stringify({ name: 'json-main', main: 'data.json' }),
    'node_modules/json-main/data.json': JSON.stringify({ size: 41 }),
    'test/unit/a.test.mjs': [
      "import assert from 'node:assert/strict';",
      "import { test } from 'node:test';",
      "import { createRequire } from 'node:module';",
      "import data from 'json-main';",
      "import { Kind, pick, sized } from '../../src/a.js';",
      "test('a', () => {",
      '  assert.equal(pick(true), Kind.Fancy);',
      '  assert.equal(pick(false), Kind.Plain);',
      '  assert.equal(sized(), 42);',
      '  assert.deepEqual(data, { size: 41 });',
      "  assert.equal(new (createRequire(import.meta.url)('../../src/counter.cjs').Counter)().count, 0);",
      '});',
      '',
    ].join('\n'),
  });
  git(fx.dir, 'add', 'src');
  const covered = cover(fx);
  assert.equal(covered.status, 0, covered.out);
  assert.match(
    covered.stdout,
    /slicc-unit-cover: PASS 1 unit test files in 1 batch, diff coverage 100%/
  );
  assert.match(covered.stderr, /running 1 of 2 unit test files/);
  const typed = lines(fx.dir, 'src/a.ts');
  assert.ok(typed[7] > 0, JSON.stringify(typed));
  assert.ok(typed[8] > 0, JSON.stringify(typed));
  assert.ok(lines(fx.dir, 'src/tally.mts')[4] > 0);
});
