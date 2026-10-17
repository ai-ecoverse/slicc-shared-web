import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { after, test } from 'node:test';

const harness = new URL('../../harness/index.mjs', import.meta.url).href;
const page = new URL('page/', import.meta.url).pathname;
const scratch = new URL('../../node_modules/.cache/quiet-artifacts/', import.meta.url);
const artifacts = new URL('../../artifacts/quiet-artifacts-child/', import.meta.url);
after(() => rm(scratch, { recursive: true, force: true }));

const { NODE_TEST_CONTEXT: _, ...env } = process.env;

const child = `
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
const { launch } = await import(${JSON.stringify(harness)});
const chrome = await launch({ roots: [['/', ${JSON.stringify(page)}]], coverage: [], profile: false });
after(() => chrome.close());

test('a failing row', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  assert.deepEqual(await page.evaluate(() => window.fixture.worker()), { outer: 46368, inner: 46368 });
  assert.fail('on purpose');
});

test('a crashing row', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  await page.send('Page.crash').catch(() => null);
  await page.until(() => false);
});
`;

test('with nothing collected, failing rows still leave their console log, screenshot and crash dump', async () => {
  await mkdir(scratch, { recursive: true });
  const file = new URL('quiet-artifacts-child.test.mjs', scratch);
  await writeFile(file, child);
  await rm(artifacts, { recursive: true, force: true });
  const code = await new Promise((resolve) => {
    spawn(process.execPath, ['--test', file.pathname], { stdio: 'ignore', env }).once(
      'exit',
      resolve
    );
  });
  assert.equal(code, 1);
  const failing = new URL('a-failing-row/', artifacts);
  const log = await readFile(new URL('console.log', failing), 'utf8');
  for (const line of [
    'page: log page ready',
    'worker: log worker done',
    'nested: log nested done',
  ]) {
    assert.ok(log.includes(line), log);
  }
  assert.ok((await readdir(failing)).includes('tab-1.png'));
  const crashing = new URL('a-crashing-row/', artifacts);
  assert.match(
    await readFile(new URL('console.log', crashing), 'utf8'),
    /^page: page renderer crashed /m
  );
  assert.equal((await readdir(crashing)).filter((name) => name.endsWith('.dmp')).length, 1);
});
