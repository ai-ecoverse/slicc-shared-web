import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from '@ai-ecoverse/slicc-shared-web/harness';

const chrome = await launch({ roots: [['/', 'test/integration/page/']], stallAfter: 300 });
after(() => chrome.close());

test('the test server keeps answering while the harness summarizes a busy page’s stall trace', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  const worst = async () => {
    const channel = new MessageChannel();
    const start = Date.now();
    let sent = 0;
    let spinning = true;
    const next = () => {
      if (!spinning) return;
      if (sent < (Date.now() - start) * 8) {
        sent += 1;
        channel.port2.postMessage(0);
      } else {
        setTimeout(next, 1);
      }
    };
    channel.port1.onmessage = next;
    next();
    let slowest = 0;
    const end = Date.now() + 24000;
    while (Date.now() < end) {
      const asked = Date.now();
      await (await fetch(`/?${asked}`, { cache: 'no-store' })).text();
      slowest = Math.max(slowest, Date.now() - asked);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    spinning = false;
    return { slowest, sent };
  };
  const { slowest, sent } = await page.evaluate(worst);
  assert.ok(sent > 40000, `the page ran ${sent} tasks`);
  assert.ok(slowest < 3000, `the slowest fetch took ${slowest} ms`);
});
