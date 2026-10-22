import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { launch } from '@ai-ecoverse/slicc-shared-web/harness';

const roots = [['/', 'test/integration/update/']];
const chrome = await launch({ roots, coverage: [], profile: false });
after(() => chrome.close());

const BUSY = 8000;
const workers = new Set(['service_worker', 'shared_worker', 'worker']);
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
    if (method === 'Target.attachedToTarget' && workers.has(type))
      attached.push(`${sessionId ? 'nested' : 'root'} ${type} held ${params.waitingForDebugger}`);
    if (method !== 'Target.targetCreated' || type !== 'service_worker' || blocked) return;
    blocked = Date.now();
    busy(BUSY);
  });
  return { stop, attached, at: () => blocked };
}

test('with nothing collected, an updated service worker activates and answers the next navigation while the harness is too busy to answer the browser, and only a shared worker that appears meanwhile is held at its start', async (t) => {
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
  await page.until(() => window.started?.length === 2);
  assert.ok(block.attached.includes('root service_worker held false'), block.attached.join('\n'));
  assert.ok(block.attached.includes('root shared_worker held true'), block.attached.join('\n'));
  assert.ok(block.attached.includes('nested worker held false'), block.attached.join('\n'));
  assert.deepEqual(
    block.attached.filter((line) => line.endsWith('held true')),
    ['root shared_worker held true'],
    'a service or dedicated worker that appeared mid-update was held at its start'
  );
  assert.deepEqual(page.errors, []);
});

test('with nothing collected, shared workers started and torn down in quick succession leave Chrome running', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  for (let round = 0; round < 40; round += 1) {
    await page.evaluate(async () => {
      const shared = new SharedWorker(`/shared.js?${Math.random()}`);
      await new Promise((resolve) => {
        shared.port.addEventListener('message', resolve, { once: true });
        shared.port.start();
      });
      shared.port.close();
    });
    await page.goto(`/?${round}`);
  }
  assert.equal(await page.evaluate(() => 1 + 1), 2);
  assert.deepEqual(page.errors, []);
});
