import assert from 'node:assert/strict';
import { env } from 'node:process';
import { after, test } from 'node:test';
import { EXTENSION_OPT_OUT, launch } from '@ai-ecoverse/slicc-shared-web/harness';

const options = {
  roots: [['/', 'test/integration/page/']],
  extensions: ['test/integration/port-extension/'],
};
const builtin = await launch(options);
env[EXTENSION_OPT_OUT] = '0';
const bare = await launch(options).finally(() => delete env[EXTENSION_OPT_OUT]);
after(() => Promise.all([builtin.close(), bare.close()]));

async function workers(chrome) {
  const { targetInfos } = await chrome.cdp.send('Target.getTargets');
  return targetInfos.filter(
    (info) => info.type === 'service_worker' && info.url.startsWith('chrome-extension://')
  );
}

async function once(t, chrome) {
  const page = await chrome.page(t);
  await page.goto('/plain.html');
  assert.equal(await page.until(() => document.documentElement.dataset.port), 'pong ping');
  const running = await workers(chrome);
  assert.equal(running.length, 1, JSON.stringify(running));
  assert.match(running[0].url, /\/background\.js$/);
  assert.deepEqual(page.errors, []);
}

test('a caller extension loads once and its first port answers with the harness extension', async (t) => {
  assert.notEqual(builtin.extension, null);
  await once(t, builtin);
});

test(`a caller extension loads once and its first port answers with ${EXTENSION_OPT_OUT}=0`, async (t) => {
  assert.equal(bare.extension, null);
  await once(t, bare);
});
