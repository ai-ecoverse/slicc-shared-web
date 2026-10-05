import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from '@ai-ecoverse/slicc-shared-web/harness';

const chrome = await launch({
  roots: [['/', 'test/integration/page/']],
  extensions: ['test/integration/extension/'],
  args: ['--host-resolver-rules=MAP fixture.test 127.0.0.1'],
});
after(() => chrome.close());

test('loads an unpacked extension and profiles its service worker and content script', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  await page.until(() => document.documentElement.dataset.extension === '987');
  const second = await page.tab();
  await second.goto('/');
  await second.until(() => document.documentElement.dataset.extension === '987');
  await second.close();
});

test('runs the next test in the same default context', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  await page.until(() => document.documentElement.dataset.extension === '987');
  assert.equal(await page.evaluate(() => crossOriginIsolated), false);
});
