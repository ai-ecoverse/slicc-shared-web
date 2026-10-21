import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { commit, commitAll, initFixtureRepo } from '@ai-ecoverse/slicc-shared-web/testing';

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
  initFixtureRepo(dir);
  commitAll(dir, 'init');
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

test('a unit test edited or synced in since the last commit runs only when its imports reach a staged file', async () => {
  const dir = await fixture(js);
  writeFileSync(
    join(dir, 'test/unit/b.test.mjs'),
    unit('b', "import { b } from '../../src/b.mjs';\nb(2);")
  );
  write(dir, {
    'test/unit/other.test.mjs': unit('other', "import '../../src/b.mjs';"),
    'test/unit/a2.test.mjs': unit('a2', "import { a } from '../../src/a.mjs';\na(3);"),
  });
  change(dir, { 'src/a.mjs': 'export const a = (x) => x + 2;\n' });
  const run = cover(dir);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.ran, ['a', 'a2']);
  assert.match(run.stderr, /running 2 of 6 unit test files/);
});

test('a synced-in unit test that also imports a module this tree lacks is skipped and named, not run to fail', async () => {
  const dir = await fixture(js);
  write(dir, {
    'test/unit/elsewhere.test.mjs': unit(
      'elsewhere',
      "import { a } from '../../src/a.mjs';\nimport '../../src/not-here-yet.mjs';\na(1);"
    ),
  });
  change(dir, { 'src/a.mjs': 'export const a = (x) => x + 2;\n' });
  const run = cover(dir);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.ran, ['a']);
  assert.match(
    run.stderr,
    /skipping 1 that import a module this tree lacks: test\/unit\/elsewhere\.test\.mjs\n.*running 1 of 5 unit test files/
  );
});

test('a source that points at build-only artifacts a fresh tree lacks still runs the test that imports it', async () => {
  const dir = await fixture({
    ...js,
    '.gitignore':
      'node_modules/\ncoverage/\ntest/unit/\nran.txt\ncovered.txt\ndist/\nsrc/codemode/generated.mjs\n',
    'src/codemode/run.mjs': [
      "export const wasm = () => [new URL('../quickjs.wasm', import.meta.url)];",
      "export const worker = () => new URL('./codemode-worker.mjs', import.meta.url);",
      "export const built = () => import('../../dist/codemode-worker.mjs');",
      "export const generated = () => import('./generated.mjs');",
      'export const run = (x) => x + 1;',
      '',
    ].join('\n'),
    'src/cli/main.mjs': "export { run } from '../codemode/run.mjs';\n",
    'test/unit/main.test.mjs': unit(
      'main',
      "import { run } from '../../src/cli/main.mjs';\nrun(1);"
    ),
  });
  change(dir, {
    'src/codemode/run.mjs': readFileSync(join(dir, 'src/codemode/run.mjs'), 'utf8').replace(
      'x + 1',
      'x + 2'
    ),
  });
  const run = cover(dir);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.ran, ['main']);
  assert.doesNotMatch(run.stderr, /skipping/);
  assert.match(run.stderr, /running 1 of 5 unit test files/);
  assert.match(record(run.covered, 'src/codemode/run.mjs'), /^DA:5,1$/m);
});

test('a README-only commit after syncing in new unit tests runs none of them', async () => {
  const dir = await fixture(js);
  write(dir, { 'test/unit/elsewhere.test.mjs': unit('elsewhere', "import '../../src/a.mjs';") });
  change(dir, { 'README.md': '# fixture, changed\n' });
  const run = cover(dir);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.ran, []);
  assert.equal(run.covered, undefined);
  assert.match(run.stderr, /no code staged/);
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
  commit(dir, 'math');
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

const barrels = {
  'src/a.mjs': 'export const a = () => "a";\n',
  'src/b.mjs': 'export const b = () => "b";\n',
  'src/c.mjs': 'export default () => "c";\n',
  'src/d.mjs': 'export const d = () => "d";\n',
  'src/e.mjs': 'export const e = () => "e";\n',
  'src/f.mjs': 'export const f = () => "f";\n',
  'src/index.mjs':
    "export { a } from './a.mjs';\nexport * from './b.mjs';\nexport { default as c } from './c.mjs';\nimport { d } from './d.mjs';\nexport { d };\n",
  'src/g.cjs': 'exports.g = () => "g";\n',
  'src/h.mjs': 'export const h = () => "h";\n',
  'src/mixed.mjs': "export * from './g.cjs';\nexport * from './h.mjs';\n",
  'src/open.mjs':
    "export * from 'node:path';\nexport * from './e.mjs';\nexport * from './f.mjs';\n",
  'test/unit/a.test.mjs': unit('a', "import { a } from '../../src/index.mjs';\na();"),
  'test/unit/b.test.mjs': unit('b', "import { b } from '../../src/index.mjs';\nb();"),
  'test/unit/c.test.mjs': unit('c', "import { c } from '../../src/index.mjs';\nc();"),
  'test/unit/d.test.mjs': unit('d', "import { d } from '../../src/index.mjs';\nd();"),
  'test/unit/ns.test.mjs': unit('ns', "import * as all from '../../src/index.mjs';\nall.a();"),
  'test/unit/dyn.test.mjs': unit('dyn', "const { b } = await import('../../src/index.mjs');\nb();"),
  'test/unit/then.test.mjs': unit(
    'then',
    "await import('../../src/index.mjs').then((m) => m.b());"
  ),
  'test/unit/rest.test.mjs': unit(
    'rest',
    "const { b, ...rest } = await import('../../src/index.mjs');\nb(rest);"
  ),
  'test/unit/mixed.test.mjs': unit('mixed', "import { h } from '../../src/mixed.mjs';\nh();"),
  'test/unit/open.test.mjs': unit('open', "import { e } from '../../src/open.mjs';\ne();"),
};

test('a test that imports names from a barrel, statically or by destructuring an awaited import(), runs only for the modules that provide them', async () => {
  const dir = await fixture(barrels);
  const expected = {
    'src/a.mjs': ['a', 'ns', 'rest', 'then'],
    'src/b.mjs': ['b', 'dyn', 'ns', 'rest', 'then'],
    'src/c.mjs': ['c', 'ns', 'rest', 'then'],
    'src/d.mjs': ['d', 'ns', 'rest', 'then'],
    'src/e.mjs': ['open'],
    'src/f.mjs': ['open'],
    'src/g.cjs': ['mixed'],
    'src/h.mjs': ['mixed'],
  };
  for (const [file, ran] of Object.entries(expected)) {
    rmSync(join(dir, 'ran.txt'), { force: true });
    const body = readFileSync(join(dir, file), 'utf8').replace('=> "', '=> "changed ');
    change(dir, { [file]: body });
    const run = cover(dir);
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(run.ran, ran, file);
    commit(dir, file);
  }
});

test('a selection larger than SLICC_UNIT_BATCH runs in batches, each with its own lcov, and diff coverage gets every batch', async () => {
  const dir = await fixture(js);
  writeFileSync(
    join(dir, 'node_modules', '.bin', 'slicc-diff-cover'),
    '#!/bin/sh\nprintf "%s\\n" "$@" > args.txt\ncat "$@" > covered.txt\n'
  );
  change(dir, {
    'src/a.mjs': 'export const a = (x) => x + 2;\n',
    'src/b.mjs': 'export const b = (x) => x * 3;\n',
  });
  const run = cover(dir, { SLICC_UNIT_BATCH: '1' });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.ran, ['a', 'b']);
  assert.match(run.stderr, /running 2 of 4 unit test files/);
  assert.match(run.stderr, /batch 1 of 2: 1 files/);
  assert.match(run.stderr, /batch 2 of 2: 1 files/);
  const args = readFileSync(join(dir, 'args.txt'), 'utf8').trim().split('\n');
  assert.deepEqual(args, ['coverage/unit/batch-1/lcov.info', 'coverage/unit/batch-2/lcov.info']);
  const [one, two] = args.map((file) => readFileSync(join(dir, file), 'utf8'));
  const hit = (lcov, file) => /^LH:1$/m.test(record(lcov, file));
  assert.deepEqual(
    [
      hit(one, 'src/a.mjs') || hit(two, 'src/a.mjs'),
      hit(one, 'src/b.mjs') || hit(two, 'src/b.mjs'),
    ],
    [true, true]
  );
  assert.equal(
    hit(one, 'src/a.mjs') && hit(one, 'src/b.mjs'),
    false,
    'each batch ran its own files only'
  );
  assert.equal(
    run.stdout
      .trim()
      .split('\n')
      .filter((l) => l.startsWith('slicc-unit-cover:'))
      .join('\n'),
    'slicc-unit-cover: PASS 2 unit test files in 2 batches, diff coverage 100%'
  );
});

test('one failing batch fails the whole run with one FAIL verdict, and diff coverage never runs', async () => {
  const dir = await fixture({
    ...js,
    'test/unit/b.test.mjs': unit(
      'b',
      "import { b } from '../../src/b.mjs';\nb(1);\nthrow new Error('b broke');"
    ),
  });
  change(dir, {
    'src/a.mjs': 'export const a = (x) => x + 2;\n',
    'src/b.mjs': 'export const b = (x) => x * 3;\n',
  });
  const run = cover(dir, { SLICC_UNIT_BATCH: '1' });
  assert.notEqual(run.status, 0);
  const lines = run.stdout.split('\n').filter((l) => l.startsWith('slicc-unit-cover:'));
  assert.deepEqual(lines, ['slicc-unit-cover: FAIL batch 2 of 2 failed (status 1)']);
  assert.equal(run.covered, undefined, 'diff coverage did not run');
});

test('a commit with no code staged passes with one verdict, and a failing diff coverage fails with one', async () => {
  const docs = await fixture(js);
  change(docs, { 'README.md': '# changed\n' });
  const skipped = cover(docs);
  assert.equal(skipped.status, 0);
  assert.equal(skipped.stdout.trim(), 'slicc-unit-cover: PASS no code staged');
  const dir = await fixture(js);
  writeFileSync(join(dir, 'node_modules', '.bin', 'slicc-diff-cover'), '#!/bin/sh\nexit 1\n');
  change(dir, { 'src/a.mjs': 'export const a = (x) => x + 2;\n' });
  const low = cover(dir);
  assert.notEqual(low.status, 0);
  assert.equal(
    low.stdout.trim().split('\n').at(-1),
    'slicc-unit-cover: FAIL diff coverage is not 100% (1 unit test files in 1 batch)'
  );
});

function bounded(dir, extra, ms) {
  const child = spawn(process.execPath, [bin], {
    cwd: dir,
    detached: true,
    env: env({ RAN: join(dir, 'ran.txt'), ...extra }),
  });
  let stdout = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.resume();
  return new Promise((resolve) => {
    const timer = setTimeout(() => process.kill(-child.pid, 'SIGKILL'), ms);
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      const covered = existsSync(join(dir, 'covered.txt')) ? 'written' : undefined;
      resolve({ status, signal, stdout, covered });
    });
  });
}

const verdicts = (run) => run.stdout.split('\n').filter((l) => l.startsWith('slicc-unit-cover:'));

test('a unit test that leaves a server listening ends the hook with a FAIL naming the file and its open handle', async () => {
  const dir = await fixture({
    ...js,
    'test/unit/a.test.mjs': unit(
      'a',
      "import { createServer } from 'node:http';\nimport { a } from '../../src/a.mjs';\na(1);\ntest('listens', () => new Promise((done) => createServer().listen(0, done)));"
    ),
  });
  change(dir, { 'src/a.mjs': 'export const a = (x) => x + 2;\n' });
  const run = await bounded(dir, { SLICC_UNIT_TIMEOUT: '2000' }, 45_000);
  assert.equal(run.signal, null, 'the hook hung on the open server');
  assert.notEqual(run.status, 0);
  assert.deepEqual(verdicts(run), [
    'slicc-unit-cover: FAIL the unit tests failed (status 1): test/unit/a.test.mjs was still running 2000ms after its tests ended, open handles kept it alive (TCPServerWrap)',
  ]);
  assert.equal(run.covered, undefined);
});

test('a unit test that closes the server it started passes', async () => {
  const dir = await fixture({
    ...js,
    'test/unit/a.test.mjs': unit(
      'a',
      "import { createServer } from 'node:http';\nimport { a } from '../../src/a.mjs';\na(1);\ntest('listens and closes', async () => {\n  const server = createServer();\n  await new Promise((done) => server.listen(0, done));\n  await new Promise((done) => server.close(done));\n});"
    ),
  });
  change(dir, { 'src/a.mjs': 'export const a = (x) => x + 2;\n' });
  const run = await bounded(dir, {}, 45_000);
  assert.equal(run.status, 0, run.stdout);
  assert.deepEqual(verdicts(run), [
    'slicc-unit-cover: PASS 1 unit test files in 1 batch, diff coverage 100%',
  ]);
});

test('a unit test file whose top-level after() takes a while to clean up passes', async () => {
  const dir = await fixture({
    ...js,
    'test/unit/a.test.mjs': unit(
      'a',
      "import { after } from 'node:test';\nimport { setTimeout } from 'node:timers/promises';\nimport { a } from '../../src/a.mjs';\na(1);\nafter(() => setTimeout(4000));"
    ),
  });
  change(dir, { 'src/a.mjs': 'export const a = (x) => x + 2;\n' });
  const run = await bounded(dir, { SLICC_UNIT_TIMEOUT: '6000' }, 45_000);
  assert.equal(run.status, 0, run.stdout);
  assert.deepEqual(verdicts(run), [
    'slicc-unit-cover: PASS 1 unit test files in 1 batch, diff coverage 100%',
  ]);
});

test('a unit test with its own timeout longer than SLICC_UNIT_TIMEOUT runs to the end and passes', async () => {
  const dir = await fixture({
    ...js,
    'test/unit/a.test.mjs': unit(
      'a',
      "import { setTimeout } from 'node:timers/promises';\nimport { a } from '../../src/a.mjs';\na(1);\ntest('slow', { timeout: 20000 }, () => setTimeout(8000));"
    ),
  });
  change(dir, { 'src/a.mjs': 'export const a = (x) => x + 2;\n' });
  const run = await bounded(dir, { SLICC_UNIT_TIMEOUT: '1000' }, 45_000);
  assert.equal(run.status, 0, run.stdout);
  assert.deepEqual(verdicts(run), [
    'slicc-unit-cover: PASS 1 unit test files in 1 batch, diff coverage 100%',
  ]);
});

test('a unit test file that hangs outside any test is killed and the FAIL names it', async () => {
  const dir = await fixture({
    ...js,
    'test/unit/a.test.mjs': unit(
      'a',
      "import { a } from '../../src/a.mjs';\na(1);\nawait new Promise(() => setInterval(() => {}, 1000));"
    ),
  });
  change(dir, { 'src/a.mjs': 'export const a = (x) => x + 2;\n' });
  const run = await bounded(dir, { SLICC_UNIT_TIMEOUT: '1000' }, 45_000);
  assert.equal(run.signal, null, 'the hook hung on the file');
  assert.notEqual(run.status, 0);
  assert.deepEqual(verdicts(run), [
    'slicc-unit-cover: FAIL the unit tests failed (status 1): test/unit/a.test.mjs was killed after 6000ms with no test running and nothing finishing, or its event loop blocked',
  ]);
});

test('a unit test that never resolves times out after SLICC_UNIT_TIMEOUT and the FAIL names it', async () => {
  const dir = await fixture({
    ...js,
    'test/unit/a.test.mjs': unit(
      'a',
      "import { a } from '../../src/a.mjs';\na(1);\ntest('waits forever', () => new Promise(() => setInterval(() => {}, 1000)));"
    ),
  });
  change(dir, { 'src/a.mjs': 'export const a = (x) => x + 2;\n' });
  const run = await bounded(dir, { SLICC_UNIT_TIMEOUT: '2000' }, 45_000);
  assert.equal(run.signal, null, 'the hook hung on the pending test');
  assert.notEqual(run.status, 0);
  const [line] = verdicts(run);
  assert.match(
    line,
    /^slicc-unit-cover: FAIL the unit tests failed \(status 1\): test\/unit\/a\.test\.mjs: "waits forever" test timed out after 2000ms; /
  );
  assert.equal(run.covered, undefined);
});

test('a selection that runs past SLICC_UNIT_BATCH_TIMEOUT is killed, process group and all, and the FAIL names the batch and its files', async () => {
  const dir = await fixture({
    ...js,
    'test/unit/a.test.mjs': unit(
      'a',
      "import { a } from '../../src/a.mjs';\na(1);\ntest('waits with no limit of its own', { timeout: Number.POSITIVE_INFINITY }, () => new Promise(() => setInterval(() => {}, 1000)));"
    ),
  });
  change(dir, {
    'src/a.mjs': 'export const a = (x) => x + 2;\n',
    'src/b.mjs': 'export const b = (x) => x * 3;\n',
  });
  const run = await bounded(
    dir,
    { SLICC_UNIT_BATCH: '1', SLICC_UNIT_BATCH_TIMEOUT: '8000' },
    45_000
  );
  assert.equal(run.signal, null, 'the hook hung on the batch');
  assert.notEqual(run.status, 0);
  assert.deepEqual(verdicts(run), [
    'slicc-unit-cover: FAIL batch 1 of 2 ran past 8000ms and was killed (test/unit/a.test.mjs)',
  ]);
  const left = spawnSync('pgrep', ['-f', join(dir, 'node_modules')], { encoding: 'utf8' });
  assert.equal(left.stdout, '', 'nothing of the batch is left running');
});

test('a leaked child process holding the runner output open is ended by the batch limit, and the FAIL names its handle', async () => {
  const dir = await fixture({
    ...js,
    'test/unit/a.test.mjs': unit(
      'a',
      "import { spawn } from 'node:child_process';\nimport { a } from '../../src/a.mjs';\na(1);\ntest('child', () => {\n  spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });\n});"
    ),
  });
  change(dir, { 'src/a.mjs': 'export const a = (x) => x + 2;\n' });
  const run = await bounded(
    dir,
    { SLICC_UNIT_TIMEOUT: '1000', SLICC_UNIT_BATCH_TIMEOUT: '10000' },
    45_000
  );
  assert.equal(run.signal, null, 'the hook hung on the child process');
  assert.notEqual(run.status, 0);
  const [line] = verdicts(run);
  assert.match(
    line,
    /^slicc-unit-cover: FAIL the unit tests ran past 10000ms and were killed \(test\/unit\/a\.test\.mjs\): test\/unit\/a\.test\.mjs was still running 1000ms after its tests ended, open handles kept it alive \(.*ProcessWrap.*\)$/
  );
  const left = spawnSync('pgrep', ['-f', 'setInterval\\(\\(\\) => \\{\\}, 1000\\)'], {
    encoding: 'utf8',
  });
  assert.equal(left.stdout, '', 'the leaked child is gone');
});

test('a leaked child that does not hold the runner open is killed with the batch once the guard ends its file', async () => {
  const dir = await fixture({
    ...js,
    'test/unit/a.test.mjs': unit(
      'a',
      "import { spawn } from 'node:child_process';\nimport { a } from '../../src/a.mjs';\na(1);\ntest('child', () => {\n  spawn(process.execPath, ['-e', 'setInterval(() => {}, 1001)'], { stdio: 'ignore' });\n});"
    ),
  });
  change(dir, { 'src/a.mjs': 'export const a = (x) => x + 2;\n' });
  const run = await bounded(dir, { SLICC_UNIT_TIMEOUT: '1000' }, 45_000);
  assert.equal(run.signal, null, 'the hook hung on the child process');
  const [line] = verdicts(run);
  assert.match(
    line,
    /^slicc-unit-cover: FAIL the unit tests failed \(status 1\): test\/unit\/a\.test\.mjs was still running 1000ms after its tests ended, open handles kept it alive \(.*ProcessWrap.*\)$/
  );
  const left = spawnSync('pgrep', ['-f', 'setInterval\\(\\(\\) => \\{\\}, 1001\\)'], {
    encoding: 'utf8',
  });
  assert.equal(left.stdout, '', 'the leaked child is gone');
});

test('a SLICC_UNIT_TIMEOUT or SLICC_UNIT_BATCH_TIMEOUT that is not a whole number of milliseconds fails the hook before any test runs', async () => {
  const dir = await fixture(js);
  change(dir, { 'src/a.mjs': 'export const a = (x) => x + 2;\n' });
  for (const [name, value] of [
    ['SLICC_UNIT_TIMEOUT', '60s'],
    ['SLICC_UNIT_TIMEOUT', ''],
    ['SLICC_UNIT_BATCH_TIMEOUT', '1m'],
    ['SLICC_UNIT_BATCH_TIMEOUT', '-1'],
    ['SLICC_UNIT_BATCH_TIMEOUT', '3000000000'],
  ]) {
    const run = cover(dir, { [name]: value });
    assert.equal(run.status, 1, `${name}=${value}`);
    assert.deepEqual(verdicts(run), [
      `slicc-unit-cover: FAIL ${name} must be a whole number of milliseconds up to 2147483647, 0 for none, not ${JSON.stringify(value)}`,
    ]);
    assert.deepEqual(run.ran, []);
  }
});
