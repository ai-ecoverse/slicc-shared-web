import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { launch } from '@ai-ecoverse/slicc-shared-web/harness';

const roots = [['/', 'test/integration/update/']];
const chrome = await launch({ roots, coverage: [], profile: false });
after(() => chrome.close());

const BUSY = 8000;
const worker = await readFile(new URL('update/sw.js', import.meta.url), 'utf8');

function busy(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end);
}

function blockOnNextWorker() {
  let blocked = null;
  const attached = [];
  const stop = chrome.cdp.on(({ method, params, sessionId }) => {
    const type = params?.targetInfo?.type;
    if (method === 'Target.attachedToTarget' && !sessionId && type === 'service_worker')
      attached.push(params.waitingForDebugger);
    if (method !== 'Target.targetCreated' || type !== 'service_worker' || blocked) return;
    blocked = Date.now();
    busy(BUSY);
  });
  return { stop, attached, at: () => blocked };
}

test('with nothing collected, an updated service worker activates and answers the next navigation while the harness is too busy to answer the browser', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  await page.evaluate(async () => {
    await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
  });
  await page.until(() => !!navigator.serviceWorker.controller);
  chrome.overrides.set('/sw.js', worker.replace("'version 1'", "'version 2'"));
  const block = blockOnNextWorker();
  t.after(block.stop);
  await page.evaluate(() => {
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      location.href = '/next';
    });
    navigator.serviceWorker.getRegistration().then((registration) => registration.update());
  });
  assert.equal(
    await page.until(() => document.title.startsWith('version') && document.title),
    'version 2'
  );
  const answered = Number(await page.evaluate(() => sessionStorage.answered));
  const blocked = block.at();
  assert.ok(blocked, 'the updated worker never showed up as a target');
  assert.ok(
    answered < blocked + BUSY,
    `the navigation got its answer ${answered - blocked} ms after the harness went busy for ${BUSY} ms`
  );
  await page.until(() => !!navigator.serviceWorker.controller);
  assert.deepEqual(block.attached, [false]);
  assert.deepEqual(page.errors, []);
});
