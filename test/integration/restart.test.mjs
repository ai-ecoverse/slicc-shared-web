import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { launch } from '@ai-ecoverse/slicc-shared-web/harness';

const roots = [['/', 'test/integration/restart/']];
const quiet = await launch({ roots, coverage: [], profile: false });
const counted = await launch({ roots });
after(() => Promise.all([quiet.close(), counted.close()]));

async function controlled(chrome, t) {
  const page = await chrome.page(t);
  await page.goto('/');
  await page.evaluate(async () => {
    await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
  });
  await page.until(() => !!navigator.serviceWorker.controller);
  return page;
}

const answered = (page) =>
  page.evaluate(() =>
    Promise.race([
      fetch('/answer').then((response) => response.text()),
      new Promise((resolve) => setTimeout(() => resolve('no answer in 10 s'), 10000)),
    ])
  );

for (const [name, chrome] of [
  ['with nothing collected', quiet],
  ['with coverage on', counted],
]) {
  test(`${name}, a service worker that stops and starts again answers its next fetch and isn't left crashed`, async (t) => {
    const seen = [];
    const workers = [];
    const off = chrome.cdp.on(({ method, params, sessionId }) => {
      if (/ReloadedAfterCrash/.test(method)) seen.push(method);
      if (method === 'Target.attachedToTarget' && params.targetInfo.type === 'service_worker')
        workers.push(params.sessionId);
    });
    t.after(off);
    const page = await controlled(chrome, t);
    assert.equal(await answered(page), 'from the worker');
    await page.send('ServiceWorker.enable');
    await page.send('ServiceWorker.stopAllWorkers');
    await sleep(500);
    assert.equal(await answered(page), 'from the worker');
    assert.ok(seen.includes('Inspector.targetReloadedAfterCrash'), seen.join());
    const { result } = await chrome.cdp.send(
      'Runtime.evaluate',
      { expression: 'typeof clients', returnByValue: true },
      workers[0]
    );
    assert.equal(result.value, 'object');
    assert.deepEqual(page.errors, []);
  });

  test(`${name}, a worker held at its start by a session the test attached stays held until the test runs it`, async (t) => {
    const page = await chrome.page(t);
    await page.goto('/');
    const { targetInfo } = await page.send('Target.getTargetInfo');
    const { sessionId } = await chrome.cdp.send('Target.attachToTarget', {
      targetId: targetInfo.targetId,
      flatten: true,
    });
    t.after(() => chrome.cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {}));
    const held = new Promise((resolve) => {
      const stop = chrome.cdp.on(({ method, params, sessionId: from }) => {
        if (from !== sessionId || method !== 'Target.attachedToTarget') return;
        stop();
        resolve(params);
      });
    });
    await chrome.cdp.send(
      'Target.setAutoAttach',
      { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
      sessionId
    );
    await page.evaluate(() => {
      window.started = [];
      const worker = new Worker('/started.js');
      worker.addEventListener('message', ({ data }) => window.started.push(data));
    });
    const worker = await held;
    assert.equal(worker.waitingForDebugger, true);
    await sleep(1500);
    assert.deepEqual(await page.evaluate(() => window.started), []);
    await chrome.cdp.send('Runtime.runIfWaitingForDebugger', {}, worker.sessionId);
    await page.until(() => window.started.length === 1);
    assert.deepEqual(page.errors, []);
  });
}
