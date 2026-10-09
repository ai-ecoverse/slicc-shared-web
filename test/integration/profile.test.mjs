import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { launch } from '@ai-ecoverse/slicc-shared-web/harness';
import { table } from '../../harness/global.mjs';

const chrome = await launch({ roots: [['/', 'test/integration/page/']], profile: false });
after(() => chrome.close());

test('without profiling, a test keeps its coverage and writes no CPU profile', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  assert.equal(await page.until(() => document.title), 'harness fixture');
  t.after(async () => {
    const files = await readdir(page.dir);
    assert.deepEqual(
      files.filter((file) => file.endsWith('.cpuprofile')),
      []
    );
    const cache = new URL('../../node_modules/.cache/slicc-harness/coverage/', import.meta.url);
    const name = 'profile-without-profiling-a-test-keeps-its-coverage-and-writes-no-cpu-profile';
    const scripts = JSON.parse(await readFile(new URL(`${name}.json`, cache), 'utf8'));
    assert.ok(scripts.some((script) => script.url.endsWith('/page/page.js')));
  });
});

test('hotspots says so when no test recorded a profile', () => {
  assert.match(table([{ profiles: 0, self: {} }]), /CPU profiling is off\. Set SLICC_PROFILE=1/);
});
