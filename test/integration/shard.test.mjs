import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const shard = fileURLToPath(new URL('../../harness/shard.cjs', import.meta.url));
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
    NODE_OPTIONS: `--require ${shard} --test-reporter=spec --test-reporter-destination=stdout --test-reporter=junit --test-reporter-destination=${join(dir, 'junit.xml')}`,
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
