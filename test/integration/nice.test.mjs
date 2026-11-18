import assert from 'node:assert/strict';
import { getPriority } from 'node:os';
import { after, test } from 'node:test';
import { launch, niceByDefault } from '@ai-ecoverse/slicc-shared-web/harness';
import { lower, NICE } from '../../harness/chrome.mjs';

const nice = await launch({ roots: [['/', 'test/integration/page/']], nice: true });
const plain = await launch({ roots: [['/', 'test/integration/page/']], nice: false });
after(() => Promise.all([nice.close(), plain.close()]));

test('Chrome runs at a lower priority on a developer machine and at normal priority on CI', () => {
  assert.equal(niceByDefault({}), true);
  assert.equal(niceByDefault({ CI: 'true' }), false);
  assert.equal(niceByDefault({ CI: 'false' }), true);
});

test('SLICC_NICE overrides the default either way', () => {
  assert.equal(niceByDefault({ CI: 'true', SLICC_NICE: '1' }), true);
  assert.equal(niceByDefault({ SLICC_NICE: '0' }), false);
});

test('a nice launch lowers Chrome and the tabs it starts later, a plain one leaves it alone', async (t) => {
  const own = getPriority();
  assert.equal(getPriority(nice.pid), Math.max(own, NICE));
  assert.equal(getPriority(plain.pid), own);
  const page = await nice.page(t);
  await page.goto('/');
  const { processInfo } = await nice.cdp.send('SystemInfo.getProcessInfo');
  const renderers = processInfo.filter(({ type }) => type === 'renderer');
  assert.ok(renderers.length > 0, 'chrome reports its renderers');
  for (const { id } of renderers)
    assert.equal(getPriority(id), Math.max(own, NICE), `renderer ${id}`);
});

test('lowering a process that is gone reports false instead of throwing', () => {
  assert.equal(lower(2 ** 22 + 12345), false);
});
