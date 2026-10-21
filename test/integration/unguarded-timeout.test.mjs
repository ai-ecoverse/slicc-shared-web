import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { connect } from '../../harness/cdp.mjs';
import { launch, unguarded } from '../../harness/chrome.mjs';

const chrome = await launch({ roots: [['/', 'test/integration/page/']] });
after(() => chrome.close());

const silent = () => ({ send: () => undefined, close: () => undefined, listen: () => undefined });

test('a short caller timeout cuts a send to a target that never answers', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  const { targetInfos } = await chrome.cdp.send('Target.getTargets');
  const { targetId } = targetInfos.find(
    ({ type, url }) => type === 'page' && url.startsWith(chrome.url)
  );
  const { sessionId } = await chrome.cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const started = Date.now();
  const params = { expression: 'new Promise(() => {})', awaitPromise: true };
  await assert.rejects(
    chrome.cdp.send('Runtime.evaluate', params, sessionId, 300),
    /^Error: Runtime\.evaluate: no answer in 300 ms$/
  );
  assert.ok(Date.now() - started < 10000);
});

test('a long caller timeout outlasts the 60 s default, which still applies without one', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const cdp = unguarded(await connect(silent()));
  const outcome = (promise) =>
    promise.then(
      () => 'answered',
      (error) => error.message
    );
  const long = outcome(cdp.send('Runtime.evaluate', {}, 'session', 90000));
  const plain = outcome(cdp.send('Runtime.evaluate'));
  const settled = async (promise) => {
    await new Promise((resolve) => setImmediate(resolve));
    return Promise.race([promise, 'pending']);
  };
  t.mock.timers.tick(60000);
  assert.equal(await settled(plain), 'Runtime.evaluate: no answer in 60000 ms');
  assert.equal(await settled(long), 'pending');
  t.mock.timers.tick(30000);
  assert.equal(await settled(long), 'Runtime.evaluate: no answer in 90000 ms');
});
