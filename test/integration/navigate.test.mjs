import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from '@ai-ecoverse/slicc-shared-web/harness';

const chrome = await launch({ roots: [['/', 'test/integration/page/']] });
after(() => chrome.close());

test('goto and reload survive a page that navigates before Chrome answers', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/plain.html');
  await page.send('Emulation.setCPUThrottlingRate', { rate: 20 });
  for (let i = 0; i < 50; i++) {
    await page.reload();
    assert.equal(await page.evaluate(() => document.title), 'plain');
  }
  await page.goto('/plain.html?after=reloads');
  assert.equal(await page.evaluate(() => location.search), '?after=reloads');
});

test('goto and reload work while the page has replaced its own timers', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/plain.html');
  await page.evaluate(() => {
    window.setTimeout = () => 0;
    window.queueMicrotask = () => undefined;
    return true;
  });
  await page.reload();
  await page.evaluate(() => {
    window.setTimeout = () => 0;
    return true;
  });
  await page.goto('/plain.html?timers=faked');
  assert.equal(await page.evaluate(() => location.search), '?timers=faked');
});
