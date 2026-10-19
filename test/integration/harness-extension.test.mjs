import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { EXTENSION_ID, launch } from '@ai-ecoverse/slicc-shared-web/harness';

const chrome = await launch({ roots: [['/', 'test/integration/page/']] });
after(() => chrome.close());
const { events } = chrome.cdp;

const origin = `chrome-extension://${EXTENSION_ID}`;
const contexts = (from) =>
  events
    .slice(from)
    .filter(({ method }) => method === 'Runtime.executionContextCreated')
    .map(({ params, sessionId }) => ({ ...params.context, sessionId }));

test('every page gets the extension isolated world and its data attribute', async (t) => {
  assert.equal(chrome.extension.id, EXTENSION_ID);
  assert.match(chrome.extension.path, /harness[/\\]extension$/);
  const page = await chrome.page(t);
  const from = events.length;
  await page.goto('/plain.html');
  assert.equal(
    await page.until(() => document.documentElement.dataset.sliccHarnessExtension),
    EXTENSION_ID
  );
  const isolated = contexts(from).filter((context) => context.origin === origin);
  assert.ok(isolated.length > 0, 'no chrome-extension:// execution context');
  for (const context of isolated) {
    assert.equal(context.auxData.isDefault, false);
    assert.equal(context.auxData.type, 'isolated');
  }
  assert.deepEqual(page.errors, []);
});

async function eventually(fn, ms = 10000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value || Date.now() > deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

test('a page that opts in with ?slicc-extension-frame gets an extension-origin iframe', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/plain.html?slicc-extension-frame');
  const src = await page.until(() => document.querySelector('iframe')?.src);
  assert.equal(src, `${origin}/frame.html`);
  const frame = await eventually(async () => {
    const { targetInfos } = await chrome.cdp.send('Target.getTargets');
    return targetInfos.find((info) => info.type === 'iframe' && info.url === src);
  });
  assert.ok(frame, 'no chrome-extension:// iframe target');
  const attached = events.find(
    ({ method, params }) =>
      method === 'Target.attachedToTarget' && params.targetInfo.targetId === frame.targetId
  );
  assert.ok(attached, 'the harness never attached to the extension iframe');
  const { sessionId } = attached.params;
  const before = events.length;
  await chrome.cdp.send('Runtime.enable', {}, sessionId);
  const framed = contexts(before).find(
    (context) =>
      context.sessionId === sessionId && context.origin === origin && context.auxData.isDefault
  );
  assert.ok(framed, 'no default execution context with the extension origin');
  assert.deepEqual(page.errors, []);
});

test('a page without the flag gets no iframe', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/plain.html');
  await page.until(() => document.documentElement.dataset.sliccHarnessExtension);
  assert.equal(await page.evaluate(() => document.querySelectorAll('iframe').length), 0);
});
