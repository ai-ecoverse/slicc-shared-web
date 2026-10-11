import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { after, test } from 'node:test';
import { launch } from '@ai-ecoverse/slicc-shared-web/harness';

const chrome = await launch({
  roots: [['/', 'test/integration/page/']],
  isolated: true,
  exits: { '/exit.js': [/self\.close\(\)/] },
  intercept: ['https://cdn.jsdelivr.net/'],
});
after(() => chrome.close());

test('profiles the page, its dedicated and nested workers, and a shared worker', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  assert.equal(await page.evaluate(() => typeof window.fixture === 'object'), true);
  assert.equal(await page.until(() => document.title), 'harness fixture');
  assert.equal(await page.until(() => Infinity), Infinity);
  assert.equal(await page.evaluate(() => 1n), 1n);
  assert.equal(await page.evaluate(() => crossOriginIsolated), true);
  assert.deepEqual(await page.evaluate(() => window.fixture.worker()), {
    outer: 46368,
    inner: 46368,
  });
  assert.equal(await page.evaluate(() => window.fixture.shared()), 6765);
  assert.equal(await page.evaluate(() => window.fixture.exit()), 17711);
  await page.reload();
  assert.ok(chrome.requests.includes('/worker.js'));
  assert.ok(chrome.requests.includes('/nested.js'));
  const script = page.responses.find((response) => response.url.endsWith('/page.js'));
  const { size } = await stat('test/integration/page/page.js');
  assert.equal(Number(script.headers['content-length']), size);
  assert.deepEqual(page.errors, []);
});

test('types into the page, overrides files and opens a second tab', async (t) => {
  const page = await chrome.page(t);
  chrome.overrides.set('/extra.json', '{"ok":true}');
  const seen = [];
  await page.expose('report', (value) => seen.push(value));
  await page.init(() => {
    addEventListener('load', () => window.report(JSON.stringify(location.pathname)));
  });
  await page.goto('/');
  await page.until(() => document.activeElement?.id === 'field');
  await page.type('a.b');
  await page.press('ArrowLeft');
  await page.press(' ');
  await page.insert('c');
  await page.press('Backspace');
  await page.press('X', 'shift');
  await page.press('Escape');
  await page.enter();
  assert.equal(await page.evaluate(() => document.querySelector('#field').value), 'a. Xb');
  await page.until((count) => window.report && count > 0, seen.length);
  assert.deepEqual(seen, ['/']);
  const second = await page.tab();
  await second.goto('/extra.json');
  await second.until(() => document.body.textContent.includes('"ok"'));
  assert.equal(second.dir.href, page.dir.href);
  const extra = second.responses.find((response) => response.url.endsWith('/extra.json'));
  assert.equal(extra.headers['content-length'], '11');
});

test('until reports the last answer when the deadline cuts the final check short', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  const late = () => new Promise((resolve) => setTimeout(resolve, 100, false));
  await assert.rejects(page.within(180, late), /\nlast result: false$/);
  const nothing = () => new Promise((resolve) => setTimeout(resolve, 100, undefined));
  await assert.rejects(page.within(180, nothing), /\nlast result: undefined$/);
});

test('serves remotes from the CDN cache and injects failures', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  await page.until(() => typeof window.fixture === 'object');
  const url = 'https://cdn.jsdelivr.net/npm/modern-tar@0.8.5/package.json';
  chrome.cdn.status = 503;
  assert.equal(await page.evaluate((u) => window.fixture.remote(u), url), 503);
  chrome.cdn.status = 0;
  assert.equal(await page.evaluate((u) => window.fixture.remote(u), url), 200);
  assert.deepEqual(chrome.cdn.requests, [url, url]);
});
