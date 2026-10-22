import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const shardPath = fileURLToPath(new URL('../../harness/shard.cjs', import.meta.url));
const dirs = [];
after(() => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))));

const nested = `
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
test('nested', () => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  assert.equal(env.SLICC_TEST_FILES, undefined);
  assert.doesNotMatch(env.NODE_OPTIONS ?? '', /shard\\.cjs|junit/);
  const out = execFileSync(process.execPath, ['--test', 'a.test.mjs', 'b.test.mjs'], { env, encoding: 'utf8' });
  assert.match(out, /tests 2/);
});
`;

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'slicc-shard-'));
  dirs.push(dir);
  const plain = (name) => `import { test } from 'node:test';\ntest('${name}', () => {});\n`;
  await writeFile(join(dir, 'a.test.mjs'), plain('a'));
  await writeFile(join(dir, 'b.test.mjs'), plain('b'));
  await writeFile(join(dir, 'c.test.mjs'), nested);
  return dir;
}

function shardEnv(dir, files) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return {
    ...env,
    SLICC_TEST_FILES: files.join('\n'),
    SLICC_TEST_ALL: 'a.test.mjs\nb.test.mjs\nc.test.mjs',
    SLICC_TEST_SHARD: '0',
    SLICC_TEST_NODE_OPTIONS: '',
    NODE_OPTIONS: `--require ${shardPath} --test-reporter=spec --test-reporter-destination=stdout --test-reporter=junit --test-reporter-destination=${join(dir, 'junit.xml')}`,
  };
}

test('runs only the listed files and writes their JUnit report', async () => {
  const dir = await fixture();
  const { stdout } = await run(process.execPath, ['--test', '*.test.mjs'], {
    cwd: dir,
    env: shardEnv(dir, ['b.test.mjs']),
  });
  assert.match(stdout, /tests 1/);
  const junit = await readFile(join(dir, 'junit.xml'), 'utf8');
  assert.match(junit, /name="b"/);
  assert.doesNotMatch(junit, /name="a"/);
});

test('lists the files it hands to node --test next to the JUnit report', async () => {
  const dir = await fixture();
  await mkdir(join(dir, 'lib'));
  await writeFile(
    join(dir, 'lib', 'cases.mjs'),
    "import { test } from 'node:test';\nexport const cases = () => test('shared', () => {});\n"
  );
  await writeFile(join(dir, 'd.test.mjs'), "import { cases } from './lib/cases.mjs';\ncases();\n");
  await run(process.execPath, ['--test', '*.test.mjs'], {
    cwd: dir,
    env: {
      ...shardEnv(dir, ['b.test.mjs', 'd.test.mjs']),
      SLICC_TEST_JUNIT: join(dir, 'junit.xml'),
    },
  });
  const lists = (await readdir(dir)).filter((name) => name.endsWith('.files'));
  assert.equal(lists.length, 1, lists.join());
  assert.equal(await readFile(join(dir, lists[0]), 'utf8'), 'b.test.mjs\nd.test.mjs\n');
});

test('times each test file it hands over by its own wall time, helper-registered tests included', async () => {
  const dir = await fixture();
  await mkdir(join(dir, 'lib'));
  await writeFile(
    join(dir, 'lib', 'slow.mjs'),
    "import { test } from 'node:test';\nexport const slow = () => test('slow', () => new Promise((r) => setTimeout(r, 400)));\n"
  );
  await writeFile(join(dir, 'd.test.mjs'), "import { slow } from './lib/slow.mjs';\nslow();\n");
  await run(process.execPath, ['--test', '*.test.mjs'], {
    cwd: dir,
    env: {
      ...shardEnv(dir, ['b.test.mjs', 'd.test.mjs']),
      SLICC_TEST_JUNIT: join(dir, 'junit.xml'),
    },
  });
  const times = (await readdir(dir)).filter((name) => name.endsWith('.times'));
  assert.equal(times.length, 1, times.join());
  const rows = (await readFile(join(dir, times[0]), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const ms = Object.fromEntries(rows.map(({ file, ms }) => [file, ms]));
  assert.deepEqual(Object.keys(ms).sort(), ['b.test.mjs', 'd.test.mjs']);
  assert.ok(ms['d.test.mjs'] >= 400, JSON.stringify(ms));
  assert.ok(ms['d.test.mjs'] > ms['b.test.mjs'], JSON.stringify(ms));
});

test('leaves a nested node --test alone', async () => {
  const dir = await fixture();
  const { stdout } = await run(process.execPath, ['--test', '*.test.mjs'], {
    cwd: dir,
    env: shardEnv(dir, ['c.test.mjs']),
  });
  assert.match(stdout, /tests 1/);
  const junit = await readFile(join(dir, 'junit.xml'), 'utf8');
  assert.match(junit, /name="nested"/);
  assert.equal(junit.match(/<testcase /g).length, 1);
});

test('runs nothing when the shard is empty', async () => {
  const dir = await fixture();
  const { stdout } = await run(process.execPath, ['--test', '*.test.mjs'], {
    cwd: dir,
    env: shardEnv(dir, []),
  });
  assert.match(stdout, /none\.mjs/);
  assert.doesNotMatch(await readFile(join(dir, 'junit.xml'), 'utf8'), /name="(a|b|nested)"/);
});

async function split(command, { all, shards, fail = false }) {
  const dir = await mkdtemp(join(tmpdir(), 'slicc-shard-'));
  dirs.push(dir);
  const body = (name) =>
    `import { test } from 'node:test';\ntest('${name}', () => {${fail && name === 'a' ? " throw new Error('a'); " : ''}});\n`;
  await mkdir(join(dir, 'u'));
  await mkdir(join(dir, 'i'));
  await writeFile(join(dir, 'u', 'a.test.mjs'), body('a'));
  await writeFile(join(dir, 'i', 'b.test.mjs'), body('b'));
  await writeFile(join(dir, 'i', 'c.test.mjs'), body('c'));
  const ran = {};
  for (const [shard, files] of Object.entries(shards)) {
    const junitDir = join(dir, `junit-${shard}`);
    await mkdir(junitDir);
    const junit = join(junitDir, `${shard}.xml`);
    const env = {
      ...shardEnv(dir, files),
      SLICC_TEST_ALL: all.join('\n'),
      SLICC_TEST_SHARD: shard,
      SLICC_TEST_JUNIT: junit,
      NODE_OPTIONS: `--require ${shardPath} --test-reporter=junit --test-reporter-destination=${junit}`,
    };
    const code = await run('bash', ['-c', command], { cwd: dir, env }).then(
      () => 0,
      (error) => error.code
    );
    const reports = (await readdir(junitDir)).filter((name) => name.endsWith('.xml'));
    const xml = (
      await Promise.all(reports.map((name) => readFile(join(junitDir, name), 'utf8')))
    ).join();
    ran[shard] = {
      code,
      reports: reports.length,
      names: ['a', 'b', 'c'].filter((n) => xml.includes(`name="${n}"`)),
    };
  }
  return ran;
}

const integration = ['i/b.test.mjs', 'i/c.test.mjs'];
const halves = { 0: ['i/b.test.mjs'], 1: ['i/c.test.mjs'] };

test('runs a call outside test-glob in full on shard 0 only, and keeps every call report', async () => {
  const ran = await split('node --test "u/*.test.mjs" && node --test "i/*.test.mjs"', {
    all: integration,
    shards: halves,
  });
  assert.deepEqual(ran, {
    0: { code: 0, reports: 2, names: ['a', 'b'] },
    1: { code: 0, reports: 2, names: ['c'] },
  });
});

test('keeps the files outside test-glob of a mixed call on shard 0', async () => {
  const ran = await split('node --test "u/*.test.mjs" "i/*.test.mjs"', {
    all: integration,
    shards: halves,
  });
  assert.deepEqual(ran[0].names, ['a', 'b']);
  assert.deepEqual(ran[1].names, ['c']);
});

test('keeps the files outside test-glob of a bare node --test on shard 0', async () => {
  const ran = await split('node --test', { all: integration, shards: halves });
  assert.deepEqual(ran[0].names, ['a', 'b']);
  assert.deepEqual(ran[1].names, ['c']);
});

test('runs the command unchanged on shard 0 when test-glob matches nothing', async () => {
  const ran = await split('node --test "u/*.test.mjs" "i/*.test.mjs"', {
    all: [],
    shards: { 0: [], 1: [] },
    fail: true,
  });
  assert.notEqual(ran[0].code, 0);
  assert.deepEqual(ran[0].names, ['a', 'b', 'c']);
  assert.equal(ran[1].code, 0);
  assert.deepEqual(ran[1].names, []);
});
