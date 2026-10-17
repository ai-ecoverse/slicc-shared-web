import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { launch } from '@ai-ecoverse/slicc-shared-web/harness';
import { raw } from '../../harness/util.mjs';

const roots = [['/', 'test/integration/page/']];
const exits = { '/exit.js': [/self\.close\(\)/] };
const quiet = await launch({ roots, exits, coverage: [], profile: false });
const counted = await launch({ roots, exits });
after(() => Promise.all([quiet.close(), counted.close()]));

const median = (list) => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)];
const workers = async (chrome, t, n) => {
  const page = await chrome.page(t);
  await page.goto('/plain.html');
  await page.evaluate(() => import('/many.js'));
  const times = await page.evaluate((k) => window.many(k), n);
  assert.deepEqual(page.errors, []);
  return times;
};
const rawOf = async (name) =>
  JSON.parse(await readFile(new URL(`recorder-${name}.json`, raw), 'utf8'));

test('with nothing collected, many workers start and exit without pauses, and their time stays flat', async (t) => {
  const seen = [];
  const off = quiet.cdp.on(({ method }) => {
    if (/^(Debugger|Profiler)\./.test(method)) seen.push(method);
  });
  const times = await workers(quiet, t, 150);
  off();
  assert.deepEqual(seen, []);
  const first = median(times.slice(0, 30));
  const last = median(times.slice(-30));
  assert.ok(last < first * 3 + 20, `first ${first.toFixed(1)} ms, last ${last.toFixed(1)} ms`);
});

test('with nothing collected, no coverage is kept', async () => {
  assert.deepEqual(
    await rawOf(
      'with-nothing-collected-many-workers-start-and-exit-without-pauses-and-their-time-stays-flat'
    ),
    []
  );
});

test('with coverage on, each worker exit dumps its coverage', async (t) => {
  let pauses = 0;
  const off = counted.cdp.on(({ method }) => {
    if (method === 'Debugger.paused') pauses += 1;
  });
  assert.equal((await workers(counted, t, 40)).length, 40);
  off();
  assert.ok(pauses >= 40, `${pauses} exit pauses`);
});

test('with coverage on, one entry per script holds the sum of every worker', async () => {
  const entries = await rawOf('with-coverage-on-each-worker-exit-dumps-its-coverage');
  const exit = entries.filter(({ url }) => url.endsWith('/page/exit.js'));
  assert.equal(exit.length, 1);
  const last = exit[0].functions.find(({ functionName }) => functionName === 'last');
  assert.equal(last.ranges[0].count, 40 * (2 * 233 - 1));
  assert.equal(new Set(entries.map(({ url }) => url)).size, entries.length);
});
