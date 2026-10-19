import assert from 'node:assert/strict';
import { env } from 'node:process';
import { after, test } from 'node:test';
import { EXTENSION_OPT_OUT, launch } from '@ai-ecoverse/slicc-shared-web/harness';

const roots = [['/', 'test/integration/page/']];
const optioned = await launch({ roots, extension: false });
env[EXTENSION_OPT_OUT] = '0';
const environed = await launch({ roots }).finally(() => delete env[EXTENSION_OPT_OUT]);
after(() => Promise.all([optioned.close(), environed.close()]));

async function bare(t, chrome) {
  assert.equal(chrome.extension, null);
  const page = await chrome.page(t);
  const from = chrome.cdp.events.length;
  await page.goto('/plain.html?slicc-extension-frame');
  await page.until(() => document.readyState === 'complete');
  assert.equal(
    await page.evaluate(() => document.documentElement.dataset.sliccHarnessExtension ?? null),
    null
  );
  assert.equal(await page.evaluate(() => document.querySelectorAll('iframe').length), 0);
  const extension = chrome.cdp.events
    .slice(from)
    .filter(({ method }) => method === 'Runtime.executionContextCreated')
    .filter(({ params }) => params.context.origin.startsWith('chrome-extension://'));
  assert.deepEqual(extension, []);
}

test('launch({ extension: false }) leaves the harness extension out', async (t) => {
  await bare(t, optioned);
});

test(`${EXTENSION_OPT_OUT}=0 leaves the harness extension out`, async (t) => {
  await bare(t, environed);
});

test('anything but an explicit opt-out is refused', async () => {
  await assert.rejects(launch({ roots, extension: 'no' }), /launch\(\{ extension \}\) is "no"/);
  env[EXTENSION_OPT_OUT] = 'false';
  try {
    await assert.rejects(launch({ roots }), new RegExp(`${EXTENSION_OPT_OUT} is "false"`));
  } finally {
    delete env[EXTENSION_OPT_OUT];
  }
});
