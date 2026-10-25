import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { launch } from '@ai-ecoverse/slicc-shared-web/harness';

const chrome = await launch({
  roots: [['/', 'test/integration/page/']],
  args: ['--host-resolver-rules=MAP fixture.test 127.0.0.1'],
  persistent: true,
});
after(() => chrome.close());

const elsewhere = Object.assign(new URL(chrome.url), { hostname: 'fixture.test' }).href;
let popupDir;

const stored = () =>
  navigator.storage
    .getDirectory()
    .then((root) => root.getFileHandle('kept.txt'))
    .then((handle) => handle.getFile())
    .then((file) => file.text())
    .catch((error) => error.name);

test('keeps OPFS on disk in the default context across reloads, and a popup stores elsewhere', async (t) => {
  const page = await chrome.page(t);
  popupDir = page.dir;
  await page.goto('/');
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle('kept.txt', { create: true });
    const writable = await handle.createWritable();
    await writable.write('persistent');
    await writable.close();
    localStorage.setItem('kept', 'yes');
  });
  await page.reload();
  assert.equal(await page.evaluate(stored), 'persistent');
  assert.equal(await page.evaluate(() => localStorage.getItem('kept')), 'yes');
  chrome.overrides.set(
    '/popup.html',
    '<script>console.log("popup loaded", location.href, Boolean(opener)); localStorage.setItem("popup", "yes"); console.log("popup stored"); opener.postMessage("stored", "*");</script>'
  );
  await page.evaluate((href) => {
    addEventListener('message', ({ data }) => {
      console.log('popup message', data);
      document.documentElement.dataset.popup = data;
    });
    console.log('popup input ready', document.hasFocus(), document.visibilityState);
    addEventListener(
      'keydown',
      (event) => {
        console.log(
          'popup keydown',
          event.key,
          event.isTrusted,
          navigator.userActivation.isActive,
          document.hasFocus()
        );
        console.log('popup opened', Boolean(window.open(href)));
      },
      { once: true }
    );
  }, `${elsewhere}popup.html`);
  await page.enter();
  await page.until(() => document.documentElement.dataset.popup === 'stored');
  const profile = await readdir(join(chrome.profile, 'Default'));
  assert.ok(profile.includes('File System'), profile.join());
});

test('records the popup attachment, held-start resume and navigation in its target timeline', async () => {
  const events = (await readFile(new URL('targets.log', popupDir), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const attachment = events.find(
    ({ method, params }) =>
      method === 'Target.attachedToTarget' &&
      params.targetInfo.type === 'page' &&
      params.targetInfo.openerId
  );
  assert.ok(attachment, JSON.stringify(events));
  assert.equal(attachment.params.waitingForDebugger, true);
  const resume = events.filter(
    ({ method, sessionId }) =>
      method === 'Runtime.runIfWaitingForDebugger' && sessionId === attachment.params.sessionId
  );
  assert.deepEqual(
    resume.map(({ state }) => state),
    ['sent', 'answered']
  );
  assert.ok(resume.every(({ at }) => Number.isFinite(Date.parse(at))));
  assert.ok(events.some(({ method }) => method === 'Page.windowOpen'));
  assert.ok(
    events.some(
      ({ method, params }) =>
        method === 'Page.frameNavigated' && params.frame.url === `${elsewhere}popup.html`
    )
  );
  const log = await readFile(new URL('console.log', popupDir), 'utf8');
  for (const marker of [
    'popup input ready',
    'popup keydown Enter true true',
    'popup opened true',
    'popup loaded',
    'popup stored',
    'popup message stored',
  ]) {
    assert.ok(log.includes(marker), log);
  }
});

test('clears the storage of every origin the last test visited', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  assert.equal(await page.evaluate(stored), 'NotFoundError');
  assert.equal(await page.evaluate(() => localStorage.getItem('kept')), null);
  await page.goto(elsewhere);
  assert.equal(await page.evaluate(() => localStorage.getItem('popup')), null);
});
