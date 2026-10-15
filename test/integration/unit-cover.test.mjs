import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const bin = join(repo, 'bin', 'slicc-unit-cover.mjs');
const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const recorder = (name) =>
  `import { appendFileSync } from 'node:fs';\nappendFileSync(process.env.RAN, '${name}\\n');\n`;

const unit = (name, body) =>
  `${recorder(name)}import { test } from 'node:test';\n${body}\ntest('${name}', () => {});\n`;

function env(extra = {}) {
  const clean = { ...process.env, ...extra };
  for (const key of ['NODE_TEST_CONTEXT', 'NODE_V8_COVERAGE', 'NODE_OPTIONS', 'SLICC_UNIT_TESTS']) {
    if (!(key in extra)) delete clean[key];
  }
  delete clean.SLICC_UNIT_ALL;
  return { ...clean, ...extra };
}

function write(dir, files) {
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
}

function git(dir, ...args) {
  const run = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout;
}

async function fixture(files, extra = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'slicc-unit-cover-'));
  dirs.push(dir);
  write(dir, {
    '.gitignore': 'node_modules/\ncoverage/\ntest/unit/\nran.txt\ncovered.txt\n',
    'package.json': JSON.stringify({
      name: 'fixture',
      private: true,
      type: 'module',
      scripts: {
        'test:unit':
          "NODE_NO_WARNINGS=1 mcr -c node_modules/@ai-ecoverse/slicc-shared-web/mcr.config.mjs node --test 'test/unit/**/*.test.mjs'",
      },
      ...extra,
    }),
    'README.md': '# fixture\n',
    ...files,
  });
  mkdirSync(join(dir, 'node_modules', '@ai-ecoverse'), { recursive: true });
  mkdirSync(join(dir, 'node_modules', '.bin'));
  symlinkSync(repo, join(dir, 'node_modules', '@ai-ecoverse', 'slicc-shared-web'));
  const mcr = join(repo, 'node_modules', 'monocart-coverage-reports');
  symlinkSync(mcr, join(dir, 'node_modules', 'monocart-coverage-reports'));
  symlinkSync(join(mcr, 'lib', 'cli.js'), join(dir, 'node_modules', '.bin', 'mcr'));
  const cover = join(dir, 'node_modules', '.bin', 'slicc-diff-cover');
  writeFileSync(cover, '#!/bin/sh\ncp coverage/unit/lcov.info covered.txt\n');
  chmodSync(cover, 0o755);
  const past = new Date(Date.now() - 3_600_000);
  for (const path of Object.keys(files)) {
    if (path.startsWith('test/unit/')) utimesSync(join(dir, path), past, past);
  }
  git(dir, 'init', '-q');
  git(dir, 'add', '-A');
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init', '--no-verify');
  return dir;
}

function change(dir, files) {
  write(dir, files);
  git(dir, 'add', ...Object.keys(files));
}

function cover(dir, extra = {}) {
  const run = spawnSync(process.execPath, [bin], {
    cwd: dir,
    encoding: 'utf8',
    env: env({ RAN: join(dir, 'ran.txt'), ...extra }),
  });
  const ran = existsSync(join(dir, 'ran.txt'))
    ? readFileSync(join(dir, 'ran.txt'), 'utf8').trim().split('\n').sort()
    : [];
  const covered = existsSync(join(dir, 'covered.txt'))
    ? readFileSync(join(dir, 'covered.txt'), 'utf8')
    : undefined;
  return { ...run, ran, covered };
}

const record = (lcov, file) =>
  lcov.split('end_of_record').find((part) => part.includes(`SF:${file}\n`)) ?? '';

const js = {
  'src/a.mjs': 'export const a = (x) => x + 1;\n',
  'src/b.mjs': 'export const b = (x) => x * 2;\n',
  'src/leaf.mjs': 'export const leaf = () => "leaf";\n',
  'src/mid.mjs': "export { leaf } from './leaf.mjs';\n",
  'src/index.mjs': "export * from './mid.mjs';\n",
  'src/lazy.mjs': 'export const lazy = () => "lazy";\n',
  'src/orphan.mjs': 'export const orphan = () => "orphan";\n',
  'test/unit/helper.mjs': "export { a } from '../../src/a.mjs';\n",
  'test/unit/a.test.mjs': unit('a', "import { a } from './helper.mjs';\na(1);"),
  'test/unit/b.test.mjs': unit('b', "import { b } from '../../src/b.mjs';\nb(1);"),
  'test/unit/chain.test.mjs': unit('chain', "import { leaf } from '../../src/index.mjs';\nleaf();"),
  'test/unit/lazy.test.mjs': unit(
    'lazy',
    "const { lazy } = await import('../../src/lazy.mjs');\nlazy();"
  ),
};

test('only the tests whose imports reach a staged file run, and diff coverage gets their lcov', async () => {
  const dir = await fixture(js);
  change(dir, { 'src/a.mjs': 'export const a = (x) => x + 2;\n' });
  const run = cover(dir);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.ran, ['a']);
  assert.match(run.stderr, /running 1 of 4 unit test files/);
  assert.match(record(run.covered, 'src/a.mjs'), /^LH:1$/m);
  assert.match(record(run.covered, 'src/b.mjs'), /^LH:0$/m);
});

test('a change behind a chain of re-exports runs the test at the top of the chain', async () => {
  const dir = await fixture(js);
  change(dir, { 'src/leaf.mjs': 'export const leaf = () => "changed";\n' });
  const run = cover(dir);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.ran, ['chain']);
});

test('a dynamically imported file runs the test that imports it', async () => {
  const dir = await fixture(js);
  change(dir, { 'src/lazy.mjs': 'export const lazy = () => "later";\n' });
  const run = cover(dir);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.ran, ['lazy']);
});

test('a unit test edited since the last commit runs even when its imports did not change', async () => {
  const dir = await fixture(js);
  writeFileSync(
    join(dir, 'test/unit/b.test.mjs'),
    unit('b', "import { b } from '../../src/b.mjs';\nb(2);")
  );
  change(dir, { 'src/a.mjs': 'export const a = (x) => x + 2;\n' });
  const run = cover(dir);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.ran, ['a', 'b']);
});

test('a staged file no test reaches runs no tests and leaves its lines uncovered for diff coverage', async () => {
  const dir = await fixture(js);
  change(dir, { 'src/orphan.mjs': 'export const orphan = () => "alone";\n' });
  const run = cover(dir);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.ran, []);
  assert.match(run.stderr, /running 0 of 4 unit test files/);
  assert.match(record(run.covered, 'src/orphan.mjs'), /^LH:0$/m);
});

test('deleting a module a test still imports runs that test, which fails the hook', async () => {
  const dir = await fixture(js);
  git(dir, 'rm', '-q', 'src/b.mjs');
  const run = cover(dir);
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /running 1 of 4 unit test files/);
  assert.equal(run.covered, undefined);
});

test('docs, YAML and lockfiles alone skip the unit tests and diff coverage', async () => {
  const dir = await fixture(js);
  change(dir, {
    'README.md': '# fixture, changed\n',
    'config.yml': 'a: 1\n',
    'package-lock.json': '{}\n',
  });
  const run = cover(dir);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.ran, []);
  assert.equal(run.covered, undefined);
  assert.match(run.stderr, /no code staged, skipping unit tests and diff coverage/);
});

test('a file the parser cannot read falls back to every unit test with a one-line warning', async () => {
  const dir = await fixture({
    ...js,
    'test/unit/broken.mjs': 'export const = ;\n',
    'test/unit/guarded.test.mjs': unit(
      'guarded',
      "if (process.env.NEVER) await import('./broken.mjs');"
    ),
  });
  change(dir, { 'src/a.mjs': 'export const a = (x) => x + 2;\n' });
  const run = cover(dir);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.ran, ['a', 'b', 'chain', 'guarded', 'lazy']);
  const warning = run.stderr.split('\n').filter((line) => line.includes('import graph'));
  assert.equal(warning.length, 1, run.stderr);
  assert.match(
    warning[0],
    /could not build the import graph \(test\/unit\/broken\.mjs: .+\), running every unit test/
  );
});

test('SLICC_UNIT_ALL=1 runs every unit test', async () => {
  const dir = await fixture(js);
  change(dir, { 'src/a.mjs': 'export const a = (x) => x + 2;\n' });
  const run = cover(dir, { SLICC_UNIT_ALL: '1' });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.ran, ['a', 'b', 'chain', 'lazy']);
});

test('TypeScript: tsconfig paths resolve from JSONC, type-only imports do not count, and .js specifiers find .ts files', async () => {
  const dir = await fixture(
    {
      'tsconfig.json':
        '{\n  /* JSONC, as TypeScript reads it */\n  "extends": "./tsconfig.base.json",\n  "compilerOptions": {\n    "paths": { "#lib/*": ["./src/lib/*"], },\n  },\n}\n',
      'tsconfig.base.json': JSON.stringify({ compilerOptions: { strict: true } }),
      'src/lib/math.ts':
        'export function add<T extends number>(a: T, b: T): number {\n  return a + b;\n}\n',
      'src/shapes.ts':
        'export interface Shape {\n  side: number;\n}\nexport const unit: Shape = { side: 1 };\n',
      'src/area.ts':
        "import type { Shape } from './shapes.js';\nimport { add } from '#lib/math.ts';\nexport const area = (s: Shape): number => add(s.side, 0) * s.side;\n",
      'src/main.ts':
        "import { area } from './area.ts';\nexport const main = (): number => area({ side: 2 });\n",
      'src/plain.ts': 'export const plain = (): string => "plain";\n',
      'src/built.ts': 'export const built = (): string => "built";\n',
      'test/unit/main.test.mjs': unit('main', "import { main } from '../../src/main.ts';\nmain();"),
      'test/unit/plain.test.mjs': unit(
        'plain',
        "import { plain } from '../../src/plain.ts';\nplain();\nif (process.env.NEVER) await import('../../src/built.js');"
      ),
    },
    { imports: { '#lib/*': './src/lib/*' } }
  );
  change(dir, {
    'src/lib/math.ts':
      'export function add<T extends number>(a: T, b: T): number {\n  return b + a;\n}\n',
  });
  const viaAlias = cover(dir);
  assert.equal(viaAlias.status, 0, viaAlias.stderr);
  assert.deepEqual(viaAlias.ran, ['main']);
  assert.match(record(viaAlias.covered, 'src/lib/math.ts'), /^LH:[1-9]/m);
  rmSync(join(dir, 'ran.txt'));
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'math', '--no-verify');
  change(dir, {
    'src/shapes.ts':
      'export interface Shape {\n  side: number;\n}\nexport const unit: Shape = { side: 2 };\n',
  });
  const typeOnly = cover(dir);
  assert.equal(typeOnly.status, 0, typeOnly.stderr);
  assert.deepEqual(typeOnly.ran, []);
  change(dir, { 'src/built.ts': 'export const built = (): string => "rebuilt";\n' });
  const swapped = cover(dir);
  assert.equal(swapped.status, 0, swapped.stderr);
  assert.deepEqual(swapped.ran, ['plain']);
});

test('npm run test:unit runs the files in SLICC_UNIT_TESTS that its own patterns match, and every file without it', async () => {
  const dir = await fixture(js);
  const unitRun = (extra) => {
    rmSync(join(dir, 'ran.txt'), { force: true });
    const run = spawnSync('npm', ['run', '--silent', 'test:unit'], {
      cwd: dir,
      encoding: 'utf8',
      env: env({ RAN: join(dir, 'ran.txt'), ...extra }),
    });
    assert.equal(run.status, 0, run.stderr);
    return existsSync(join(dir, 'ran.txt'))
      ? readFileSync(join(dir, 'ran.txt'), 'utf8').trim().split('\n').sort()
      : [];
  };
  assert.deepEqual(unitRun({}), ['a', 'b', 'chain', 'lazy']);
  assert.deepEqual(
    unitRun({
      SLICC_UNIT_TESTS: 'test/unit/b.test.mjs\ntest/unit/lazy.test.mjs\nother/x.test.mjs',
    }),
    ['b', 'lazy']
  );
  assert.deepEqual(unitRun({ SLICC_UNIT_TESTS: '' }), []);
  assert.match(
    record(readFileSync(join(dir, 'coverage/unit/lcov.info'), 'utf8'), 'src/a.mjs'),
    /^LH:0$/m
  );
});
