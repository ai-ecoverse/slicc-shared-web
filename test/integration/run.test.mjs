import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, test } from 'node:test';
import { launch } from '@ai-ecoverse/slicc-shared-web/harness';

const chrome = await launch({ roots: [['/', 'test/integration/page/']], timeout: 3000 });
const silent = createServer(() => undefined);
await new Promise((done) => silent.listen(0, '127.0.0.1', done));
const never = `http://127.0.0.1:${silent.address().port}/never`;
after(async () => {
  await chrome.close();
  silent.closeAllConnections();
  await new Promise((done) => silent.close(done));
});

const quick = { everyMs: 200, quietMs: 1500, maxMs: 60000 };

test('page.run outlives page.evaluate: a job longer than its timeout resolves with its value', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  await assert.rejects(
    page.evaluate(() => new Promise((done) => setTimeout(done, 4500, 'late'))),
    /no answer in 3000 ms/
  );
  const job = (ms) => new Promise((done) => setTimeout(done, ms, { ok: true, ms }));
  assert.deepEqual(await page.run(job, 4500), { ok: true, ms: 4500 });
});

test('a job that stops making progress fails after the quiet window, with what was in flight', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  const hang = (url) => {
    window.ticks = 0;
    void fetch(url);
    return new Promise(() => undefined);
  };
  await assert.rejects(
    page.run({ ...quick, marker: () => window.ticks, label: 'hang' }, hang, never),
    (error) => {
      assert.match(error.message, /^hang: no progress for [12] s after [12] s\nlast marker: 0\n/);
      assert.match(error.message, new RegExp(`pending GET ${never} \\(Fetch\\)`));
      return true;
    }
  );
});

test('a slow job that keeps moving its marker runs past the quiet window', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  const slow = () =>
    new Promise((done) => {
      window.ticks = 0;
      const timer = setInterval(() => {
        window.ticks += 1;
        if (window.ticks === 15) {
          clearInterval(timer);
          done(window.ticks);
        }
      }, 300);
    });
  assert.equal(await page.run({ ...quick, marker: () => window.ticks }, slow), 15);
});

test('the caller can pass its own progress probe instead of a page marker', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  let calls = 0;
  const wait = () => new Promise((done) => setTimeout(done, 4500, 'probed'));
  assert.equal(await page.run({ ...quick, progress: () => ++calls }, wait), 'probed');
  assert.ok(calls >= 10, `the probe ran ${calls} times`);
  await assert.rejects(
    page.run(
      { ...quick, progress: () => 'stuck', label: 'stuck' },
      () => new Promise(() => undefined)
    ),
    /^Error: stuck: no progress for [12] s after [12] s\nlast progress: "stuck"\nnothing in flight$/
  );
});

test('a job that keeps moving but never ends fails at the outer bound, and a job that throws rejects with its error', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  const forever = () => {
    window.ticks = 0;
    setInterval(() => (window.ticks += 1), 100);
    return new Promise(() => undefined);
  };
  await assert.rejects(
    page.run({ ...quick, maxMs: 2500, marker: () => window.ticks, label: 'forever' }, forever),
    /^Error: forever: still running after 3 s, the outer bound\nlast marker: \d+\n/
  );
  await assert.rejects(
    page.run(() => Promise.reject(new Error('boom'))),
    /Error: boom/
  );
});
