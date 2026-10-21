import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { platform } from 'node:process';
import { test } from 'node:test';
import { launch } from '@ai-ecoverse/slicc-shared-web/harness';
import { ownDisplay, wantsOwnDisplay } from '../../harness/display.mjs';
import { sleep } from '../../harness/util.mjs';

const xvfb =
  platform === 'linux' &&
  spawnSync('sh', ['-c', 'command -v Xvfb'], { stdio: 'ignore' }).status === 0;
const yes = () => true;

test('a headed Chrome gets its own display on Linux on CI or without a display, nowhere else', () => {
  const linux = { platform: 'linux', has: yes };
  assert.equal(wantsOwnDisplay({ headed: false, env: { CI: 'true' }, ...linux }), false);
  assert.equal(
    wantsOwnDisplay({ headed: true, env: { CI: 'true' }, platform: 'darwin', has: yes }),
    false
  );
  assert.equal(
    wantsOwnDisplay({ headed: true, env: { CI: 'true', DISPLAY: ':99' }, ...linux }),
    true
  );
  assert.equal(wantsOwnDisplay({ headed: true, env: {}, ...linux }), true);
  assert.equal(wantsOwnDisplay({ headed: true, env: { DISPLAY: ':0' }, ...linux }), false);
  assert.equal(
    wantsOwnDisplay({ headed: true, env: { CI: 'true' }, platform: 'linux', has: () => false }),
    false
  );
});

const socket = (display) => `/tmp/.X11-unix/X${display.slice(1)}`;

async function gone(path, ms = 5000) {
  for (const deadline = Date.now() + ms; existsSync(path) && Date.now() < deadline; ) {
    await sleep(100);
  }
  return !existsSync(path);
}

test('two displays get their own numbers and close with their Xvfb', {
  skip: !xvfb && 'needs Linux with Xvfb',
}, async () => {
  const [one, two] = await Promise.all([ownDisplay({}), ownDisplay({})]);
  assert.notEqual(one.env.DISPLAY, two.env.DISPLAY);
  assert.ok(existsSync(socket(one.env.DISPLAY)), one.env.DISPLAY);
  await Promise.all([one.close(), two.close()]);
  assert.ok(await gone(socket(one.env.DISPLAY)), one.env.DISPLAY);
  assert.ok(await gone(socket(two.env.DISPLAY)), two.env.DISPLAY);
});

test('headed browsers launched side by side each run on a display of their own', {
  skip: !xvfb && 'needs Linux with Xvfb',
}, async () => {
  const roots = [['/', 'test/integration/page/']];
  const browsers = await Promise.all([
    launch({ roots, headless: false, coverage: [] }),
    launch({ roots, headless: false, coverage: [] }),
  ]);
  const displays = browsers.map(({ pid }) => {
    const environ = readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
    return environ.find((line) => line.startsWith('DISPLAY='))?.slice('DISPLAY='.length);
  });
  await Promise.all(browsers.map((chrome) => chrome.close()));
  assert.ok(displays.every(Boolean), String(displays));
  assert.notEqual(displays[0], displays[1]);
  assert.ok(!displays.includes(process.env.DISPLAY), `${displays} vs ${process.env.DISPLAY}`);
  for (const display of displays) assert.ok(await gone(socket(display)), display);
});
