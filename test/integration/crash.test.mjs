import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { promisify } from 'node:util';
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

test('a browser that segfaults leaves its minidump, even when it closes first', async (t) => {
  const doomed = await launch({ roots });
  t.after(() => doomed.close());
  const page = await doomed.page(t);
  await page.goto('/');
  process.kill(doomed.pid, 'SIGSEGV');
  await assert.rejects(
    page.until(() => false),
    /browser exited with SIGSEGV/
  );
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

test('a browser crash leaves its minidump', async () => {
  const died = new URL(
    'a-browser-that-segfaults-leaves-its-minidump-even-when-it-closes-first/',
    artifacts
  );
  const dumps = (await readdir(died)).filter((file) => file.endsWith('.dmp'));
  assert.equal(dumps.length, 1, dumps.join());
});

test('a renderer crash leaves its minidump, and slicc-minidump prints its stack', async () => {
  const crashed = new URL('a-crashed-page-fails-its-wait-in-seconds/', artifacts);
  const dumps = (await readdir(crashed)).filter((file) => file.endsWith('.dmp'));
  assert.equal(dumps.length, 1, dumps.join());
  const script = new URL('../../bin/slicc-minidump.mjs', import.meta.url);
  const { stdout } = await promisify(execFile)(process.execPath, [
    script.pathname,
    new URL(dumps[0], crashed).pathname,
  ]);
  const head = stdout.slice(0, 4000);
  assert.match(stdout, /^crash: \S+/m, head);
  assert.match(stdout, /^ {2}ptype = renderer$/m, head);
  assert.match(stdout, /^ {3}0 {2}.+ \+ 0x[0-9a-f]+ {2}\(context\)$/m, head);
  assert.match(stdout, /^modules:$/m, head);
});
