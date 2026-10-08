import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { after, test } from 'node:test';
import { launch } from '@ai-ecoverse/slicc-shared-web/harness';

const chrome = await launch({ roots: [['/', 'test/integration/page/']], stallAfter: 300 });
const slow = createServer((request, response) => {
  setTimeout(() => {
    response
      .writeHead(200, { 'access-control-allow-origin': '*', 'content-type': 'text/html' })
      .end('slow');
  }, 4000);
});
await new Promise((done) => slow.listen(0, '127.0.0.1', done));
const late = `http://127.0.0.1:${slow.address().port}/slow`;
after(async () => {
  await chrome.close();
  slow.closeAllConnections();
  await new Promise((done) => slow.close(done));
});
const artifacts = new URL('../../artifacts/stall/', import.meta.url);
const logOf = (name) => readFile(new URL(`${name}/console.log`, artifacts), 'utf8');

test('a busy page is probed', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  const busy = () => {
    const end = Date.now() + 1500;
    while (Date.now() < end);
    return 'done';
  };
  assert.equal(await page.evaluate(busy), 'done');
  assert.equal(await page.evaluate(() => 'quick'), 'quick');
});

test('a debugger statement is resumed', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  assert.equal(await page.evaluate(() => new Function('debugger; return "resumed";')()), 'resumed');
});

test('a main thread blocked on a sync request', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  assert.equal(await page.evaluate((url) => window.fixture.later(url, 2000), late), 200);
});

test('a navigation that is not answered yet', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  await page.evaluate((url) => setTimeout(() => location.assign(url)) && null, late);
  assert.equal(
    await page.until(() => location.pathname === '/slow' && document.body.textContent),
    'slow'
  );
});

test('the probe left a sample and a log line', async () => {
  const dir = new URL('a-busy-page-is-probed/', artifacts);
  const files = await readdir(dir);
  assert.ok(
    files.some((name) => /^stall-1-page-.*\.cpuprofile$/.test(name)),
    files.join(' ')
  );
  assert.match(await logOf('a-busy-page-is-probed'), /^stall-1: page: running, profile /m);
});

test('the trace names the blocked call and symbolizes its samples', async () => {
  const name = 'a-main-thread-blocked-on-a-sync-request';
  const log = await logOf(name);
  assert.match(
    log,
    /main thread: \d+ tasks, longest \d+\.\d ms in .*FunctionCall blockOnXhr \/page\.js:5 .*ResourceFetcher::requestResource http:\/\/127\.0\.0\.1:\d+\/slow > URLLoader::loadSynchronously/,
    log
  );
  assert.match(log, /samples in \d+: .*\d+% in blockOnXhr \/page\.js:5/, log);
  const trace = JSON.parse(await readFile(new URL(`${name}/stall-1-trace.json`, artifacts)));
  const nodes = trace.traceEvents
    .filter((event) => event.name === 'ProfileChunk')
    .flatMap((event) => event.args.data.cpuProfile?.nodes ?? []);
  assert.ok(nodes.some((node) => node.callFrame.functionName === 'blockOnXhr'));
});

test('the probe names a navigation that is still waiting for its answer', async () => {
  const log = await logOf('a-navigation-that-is-not-answered-yet');
  assert.match(
    log,
    /^stall-1: pending navigation to http:\/\/127\.0\.0\.1:\d+\/slow \(differentDocument\) for \d+\.\ds$/m,
    log
  );
  assert.match(
    log,
    /^stall-1: pending GET http:\/\/127\.0\.0\.1:\d+\/slow \(Document\) for /m,
    log
  );
});
