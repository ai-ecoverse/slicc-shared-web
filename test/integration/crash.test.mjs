import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { launch } from '@ai-ecoverse/slicc-shared-web/harness';

const roots = [['/', 'test/integration/page/']];
const chrome = await launch({ roots });
after(() => chrome.close());
const artifacts = new URL('../../artifacts/crash/', import.meta.url);

test('a crashed page fails its wait in seconds', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  const started = Date.now();
  const waiting = page.until(() => false);
  await page.send('Page.crash').catch(() => null);
  await assert.rejects(
    waiting,
    /^Error: Runtime\.evaluate: page renderer crashed .*at http:\/\/127\.0\.0\.1:\d+\//
  );
  await assert.rejects(
    page.evaluate(() => 1),
    /page renderer crashed/
  );
  assert.ok(Date.now() - started < 5000, `${Date.now() - started} ms`);
});

test('a killed browser fails every call in seconds', async (t) => {
  const doomed = await launch({ roots });
  t.after(() => doomed.close());
  const page = await doomed.page(t);
  await page.goto('/');
  const started = Date.now();
  const waiting = page.until(() => false);
  process.kill(doomed.pid, 'SIGKILL');
  await assert.rejects(waiting, /^Error: Runtime\.evaluate: browser exited with SIGKILL/);
  await assert.rejects(
    page.evaluate(() => 1),
    /browser exited with SIGKILL/
  );
  assert.ok(Date.now() - started < 5000, `${Date.now() - started} ms`);
});

test('the crash is in console.log, and every test keeps the browser stderr', async () => {
  const crashed = new URL('a-crashed-page-fails-its-wait-in-seconds/', artifacts);
  const log = await readFile(new URL('console.log', crashed), 'utf8');
  assert.match(log, /^page: page renderer crashed .*at http:\/\/127\.0\.0\.1:\d+\/$/m, log);
  for (const name of [
    'a-crashed-page-fails-its-wait-in-seconds',
    'a-killed-browser-fails-every-call-in-seconds',
  ]) {
    await readFile(new URL(`${name}/chrome-stderr.log`, artifacts), 'utf8');
  }
});
