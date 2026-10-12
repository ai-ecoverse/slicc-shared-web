import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { launch } from '@ai-ecoverse/slicc-shared-web/harness';

const chrome = await launch({ roots: [['/', 'test/integration/page/']], persistent: true });
after(() => chrome.close());

const stored = () =>
  navigator.storage
    .getDirectory()
    .then((root) => root.getFileHandle('kept.txt'))
    .then((handle) => handle.getFile())
    .then((file) => file.text())
    .catch((error) => error.name);

test('keeps OPFS on disk in the default context across reloads', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle('kept.txt', { create: true });
    const writable = await handle.createWritable();
    await writable.write('persistent');
    await writable.close();
    localStorage.setItem('kept', 'yes');
  });
  await page.reload();
  assert.equal(await page.evaluate(stored), 'persistent');
  assert.equal(await page.evaluate(() => localStorage.getItem('kept')), 'yes');
  const profile = await readdir(join(chrome.profile, 'Default'));
  assert.ok(profile.includes('File System'), profile.join());
});

test('clears the origin storage before the next test', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  assert.equal(await page.evaluate(stored), 'NotFoundError');
  assert.equal(await page.evaluate(() => localStorage.getItem('kept')), null);
});
