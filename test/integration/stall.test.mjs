import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { launch } from '@ai-ecoverse/slicc-shared-web/harness';

const chrome = await launch({ roots: [['/', 'test/integration/page/']], stallAfter: 300 });
after(() => chrome.close());
const artifacts = new URL('../../artifacts/stall/', import.meta.url);

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

test('the probe left a sample and a log line', async () => {
  const dir = new URL('a-busy-page-is-probed/', artifacts);
  const files = await readdir(dir);
  assert.ok(
    files.some((name) => /^stall-1-page-.*\.cpuprofile$/.test(name)),
    files.join(' ')
  );
  assert.match(
    await readFile(new URL('console.log', dir), 'utf8'),
    /^stall-1: page: running, profile /m
  );
});
