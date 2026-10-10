import assert from 'node:assert/strict';
import { env } from 'node:process';
import { after, test } from 'node:test';
import { launch } from '@ai-ecoverse/slicc-shared-web/harness';

const headed = Boolean(env.DISPLAY);
const chrome = headed
  ? await launch({ roots: [['/', 'test/integration/page/']], realistic: true })
  : null;
after(() => chrome?.close());

test('a realistic browser hides and throttles a tab behind another', {
  skip: !headed && 'needs a display (xvfb-run)',
}, async (t) => {
  const back = await chrome.page(t);
  await back.goto('/');
  const front = await back.tab();
  await front.goto('/');
  await front.send('Page.bringToFront');
  assert.equal(await back.until(() => document.visibilityState === 'hidden'), true);
  await back.evaluate(() => {
    window.ticks = 0;
    setInterval(() => {
      window.ticks += 1;
    }, 10);
  });
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const ticks = await back.evaluate(() => window.ticks);
  assert.ok(ticks <= 6, `a hidden tab ran a 10 ms interval ${ticks} times in 3 s`);
  await back.send('Page.bringToFront');
  assert.equal(await back.until(() => document.visibilityState === 'visible'), true);
  assert.deepEqual(back.errors, []);
  assert.deepEqual(front.errors, []);
});
