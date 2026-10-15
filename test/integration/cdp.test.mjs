import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { fixtureServer } from '@ai-ecoverse/slicc-browsers/fixture';
import { run } from '@ai-ecoverse/slicc-browsers/guard-runner';
import set from '@ai-ecoverse/slicc-browsers/guard-vectors.json' with { type: 'json' };
import { launch } from '@ai-ecoverse/slicc-shared-web/harness';

const fixture = await fixtureServer();
const resolved = ['*.sliccy.ai', 'sliccy.ai', '*.example.test'].map(
  (host) => `MAP ${host} 127.0.0.1:${fixture.port}`
);
const chrome = await launch({
  roots: [['/', 'test/integration/page/']],
  args: [
    `--host-resolver-rules=${resolved.join(', ')}`,
    '--disable-features=HttpsUpgrades,HttpsFirstBalancedModeAutoEnable,LocalNetworkAccessChecks',
  ],
});
after(async () => {
  await chrome.close();
  await fixture.close();
});

const origin = (host) => `http://${host}:${fixture.port}`;
const targets = {
  ordinary: origin('ordinary.example.test'),
  'ordinary-same-site': origin('ordinary.sliccy.ai'),
  plain: origin('ordinary.example.test'),
  cross: origin('cross.example.test'),
  seven: origin('seven.sliccy.ai'),
  vault: origin('vault.sliccy.ai'),
  'vault-x': origin('vault-x.sliccy.ai'),
  apex: origin('sliccy.ai'),
  own: origin('client.example.test'),
  client: origin('client.example.test'),
  log: origin('log.example.test'),
};

test('the raw pipe sees every target and session and answers browser-level calls', async (t) => {
  const seen = [];
  const listener = (message) => seen.push(message);
  chrome.cdp.on(listener);
  const page = await chrome.page(t);
  const plain = new URL('/plain.html', chrome.url).href;
  const navigated = chrome.cdp.waitEvent(
    'Page.frameNavigated',
    ({ params }) => params.frame.url === plain,
    30000
  );
  await page.goto('/plain.html');
  const { sessionId } = await navigated;
  chrome.cdp.off(listener);
  const created = seen.find(
    ({ method, params }) => method === 'Target.targetCreated' && params.targetInfo.type === 'page'
  );
  assert.ok(created, seen.map(({ method }) => method).join());
  assert.ok(sessionId);
  assert.ok(
    seen.some(
      (event) =>
        event.method === 'Page.frameNavigated' &&
        event.sessionId === sessionId &&
        event.params.frame.url === plain
    )
  );
  const { targetInfos } = await chrome.cdp.send('Target.getTargets');
  const tab = targetInfos.find(({ targetId }) => targetId === created.params.targetInfo.targetId);
  assert.equal(tab?.url, plain);
  const { result } = await chrome.cdp.send(
    'Runtime.evaluate',
    { expression: 'document.title', returnByValue: true },
    sessionId
  );
  assert.equal(result.value, 'plain');
  const count = seen.length;
  await page.reload();
  assert.equal(seen.length, count);
  await assert.rejects(chrome.cdp.send('No.such'), (error) => error.cdp?.code === -32601);
  await assert.rejects(
    chrome.cdp.waitEvent(() => false, 50),
    /no event in 50 ms/
  );
});

test('plugs into the guard runner as its unguarded observer', async () => {
  const vector = { ...set.vectors.find(({ id }) => id === 'C6.getCookies'), targets: ['seven'] };
  const options = {
    client: chrome.cdp,
    targets,
    fixture,
    capabilities: { autoAttach: true, browserSession: true, browserContexts: true },
    variant: 'prompt',
  };
  const single = { ...set, vectors: [vector] };
  const [bare] = (await run(single, options)).results;
  assert.equal(bare.reason, 'not-supported:unguarded-observer');
  assert.equal(bare.guarded, 'skip');
  const [observed] = (await run(single, { ...options, unguarded: chrome.cdp })).results;
  assert.equal(observed.reason, undefined);
  assert.deepEqual(observed.errors, []);
  assert.equal(observed.control, 'pass');
  assert.equal(observed.guarded, 'fail');
  assert.equal(observed.observations.guarded.leaked, true);
});
