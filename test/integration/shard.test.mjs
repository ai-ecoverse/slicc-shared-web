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

test('runs a call outside test-glob in full on shard 0 only, and keeps every call report', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'slicc-shard-'));
  dirs.push(dir);
  const plain = (name) => `import { test } from 'node:test';\ntest('${name}', () => {});\n`;
  await mkdir(join(dir, 'u'));
  await mkdir(join(dir, 'i'));
  await writeFile(join(dir, 'u', 'a.test.mjs'), plain('a'));
  await writeFile(join(dir, 'i', 'b.test.mjs'), plain('b'));
  await writeFile(join(dir, 'i', 'c.test.mjs'), plain('c'));
  const ran = {};
  for (const [shard, file] of [
    ['0', 'i/b.test.mjs'],
    ['1', 'i/c.test.mjs'],
  ]) {
    const junitDir = join(dir, `junit-${shard}`);
    await mkdir(junitDir);
    const junit = join(junitDir, `${shard}.xml`);
    const env = {
      ...shardEnv(dir, [file]),
      SLICC_TEST_ALL: 'i/b.test.mjs\ni/c.test.mjs',
      SLICC_TEST_SHARD: shard,
      SLICC_TEST_JUNIT: junit,
      NODE_OPTIONS: `--require ${shardPath} --test-reporter=junit --test-reporter-destination=${junit}`,
    };
    await run('bash', ['-c', 'node --test "u/*.test.mjs" && node --test "i/*.test.mjs"'], {
      cwd: dir,
      env,
    });
    const reports = await readdir(junitDir);
    assert.equal(reports.length, 2, reports.join());
    const xml = (
      await Promise.all(reports.map((name) => readFile(join(junitDir, name), 'utf8')))
    ).join();
    ran[shard] = ['a', 'b', 'c'].filter((name) => xml.includes(`name="${name}"`));
  }
  assert.deepEqual(ran, { 0: ['a', 'b'], 1: ['c'] });
});
