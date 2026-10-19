import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { launch } from '@ai-ecoverse/slicc-shared-web/harness';
import { raw } from '../../harness/util.mjs';

const roots = [['/', 'test/integration/page/']];
const exits = { '/exit.js': [/self\.close\(\)/] };
const quiet = await launch({ roots, exits, coverage: [], profile: false });
const counted = await launch({ roots, exits });
after(() => Promise.all([quiet.close(), counted.close()]));

async function hold(chrome, t) {
  const page = await chrome.page(t);
  await page.goto('/plain.html');
  const { targetInfo } = await page.send('Target.getTargetInfo');
  const { sessionId } = await chrome.cdp.send('Target.attachToTarget', {
    targetId: targetInfo.targetId,
    flatten: true,
  });
  const seen = [];
  const off = chrome.cdp.on((event) => {
    if (event.sessionId === sessionId && /^Debugger\.(paused|resumed)$/.test(event.method)) {
      seen.push(event.method);
    }
  });
  const send = (method, params) => chrome.cdp.send(method, params, sessionId);
  try {
    await send('Debugger.enable');
    const paused = new Promise((resolve) => {
      const stop = chrome.cdp.on((event) => {
        if (event.sessionId !== sessionId || event.method !== 'Debugger.paused') return;
        stop();
        resolve(event.params);
      });
    });
    await send('Runtime.evaluate', { expression: 'setTimeout(() => { debugger; }, 0)' });
    const { callFrames } = await paused;
    await sleep(1500);
    assert.deepEqual(seen, ['Debugger.paused']);
    const { result } = await send('Debugger.evaluateOnCallFrame', {
      callFrameId: callFrames[0].callFrameId,
      expression: '6 * 7',
      returnByValue: true,
    });
    assert.equal(result.value, 42);
    await send('Debugger.resume');
    await send('Debugger.disable');
  } finally {
    off();
    await chrome.cdp.send('Target.detachFromTarget', { sessionId });
  }
  return page;
}

test('with nothing collected, a pause in a session the test attached stays held', async (t) => {
  const page = await hold(quiet, t);
  assert.deepEqual(page.errors, []);
});

test('with coverage on, a pause in a session the test attached stays held while the harness covers its own', async (t) => {
  const page = await hold(counted, t);
  await page.goto('/index.html');
  await page.goto('/plain.html');
  await page.evaluate(() => import('/many.js'));
  assert.equal((await page.evaluate((n) => window.many(n), 5)).length, 5);
  assert.deepEqual(page.errors, []);
});

test('with coverage on, the harness still counts its own workers after a held pause', async () => {
  const name =
    'with-coverage-on-a-pause-in-a-session-the-test-attached-stays-held-while-the-harness-covers-its-own';
  const entries = JSON.parse(
    await readFile(new URL(`recorder-held-pause-${name}.json`, raw), 'utf8')
  );
  const exit = entries.find(({ url }) => url.endsWith('/page/exit.js'));
  const last = exit.functions.find(({ functionName }) => functionName === 'last');
  assert.equal(last.ranges[0].count, 5 * (2 * 233 - 1));
});
