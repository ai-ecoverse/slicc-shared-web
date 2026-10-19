import assert from 'node:assert/strict';
import { env } from 'node:process';
import { after, test } from 'node:test';
import { EXTENSION_ID, EXTENSION_OPT_OUT, launch } from '@ai-ecoverse/slicc-shared-web/harness';
import { unpacked } from '../../harness/extensions.mjs';

const fixture = 'test/integration/port-extension/';
const [caller] = (await unpacked([fixture])).keys();
const options = { roots: [['/', 'test/integration/page/']], extensions: [fixture] };
const builtin = await launch(options);
env[EXTENSION_OPT_OUT] = '0';
const bare = await launch(options).finally(() => delete env[EXTENSION_OPT_OUT]);
after(() => Promise.all([builtin.close(), bare.close()]));

async function once(t, chrome, expected) {
  const page = await chrome.page(t);
  await page.goto('/plain.html');
  assert.equal(await page.until(() => document.documentElement.dataset.port), 'pong ping');
  const { targetInfos } = await chrome.cdp.send('Target.getTargets');
  const extension = targetInfos.filter(({ url }) => url.startsWith('chrome-extension://'));
  const hosts = new Set(extension.map(({ url }) => new URL(url).host));
  assert.deepEqual(
    [...hosts].filter((host) => !expected.includes(host)),
    []
  );
  const workers = extension.filter(({ type }) => type === 'service_worker');
  assert.deepEqual(
    workers.map(({ url }) => url),
    [`chrome-extension://${caller}/background.js`]
  );
  assert.deepEqual(page.errors, []);
}

test('a caller extension loads once and its first port answers with the harness extension', async (t) => {
  assert.equal(builtin.extension.id, EXTENSION_ID);
  await once(t, builtin, [EXTENSION_ID, caller]);
});

test(`a caller extension loads once and its first port answers with ${EXTENSION_OPT_OUT}=0`, async (t) => {
  assert.equal(bare.extension, null);
  await once(t, bare, [caller]);
});
