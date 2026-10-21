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
  for (const { env } of [one, two]) assert.ok(Number(env.DISPLAY.slice(1)) >= 1000, env.DISPLAY);
  assert.ok(existsSync(socket(one.env.DISPLAY)), one.env.DISPLAY);
  await Promise.all([one.close(), two.close()]);
  assert.ok(await gone(socket(one.env.DISPLAY)), one.env.DISPLAY);
  assert.ok(await gone(socket(two.env.DISPLAY)), two.env.DISPLAY);
});

const isolated = xvfb && wantsOwnDisplay({ headed: true });

test('headed browsers launched side by side each run on a display of their own', {
  skip: !isolated && 'needs Linux with Xvfb, on CI or without DISPLAY',
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

test('a display that fails to start leaves no server or directory behind', {
  skip: platform !== 'linux' && 'needs Linux',
}, async () => {
  const { chmod, mkdtemp, readdir, rm, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFile } = await import('node:child_process');
  const bin = await mkdtemp(join(tmpdir(), 'slicc-fake-xvfb-'));
  const temp = await mkdtemp(join(tmpdir(), 'slicc-fake-xvfb-tmp-'));
  try {
    await writeFile(join(bin, 'Xvfb'), '#!/bin/sh\nexit 1\n');
    await chmod(join(bin, 'Xvfb'), 0o755);
    const harness = new URL('../../harness/index.mjs', import.meta.url).href;
    const script = `const { launch } = await import(${JSON.stringify(harness)});
      await launch({ roots: [['/', 'test/integration/page/']], headless: false, coverage: [] }).then(
        () => { console.log('launched'); process.exit(2); },
        (error) => { console.log(error.message.split('\\n')[0]); }
      );`;
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CI: 'true', TMPDIR: temp };
    delete env.DISPLAY;
    delete env.NODE_TEST_CONTEXT;
    const out = await new Promise((resolve, reject) => {
      execFile(
        process.execPath,
        ['--input-type=module', '-e', script],
        { env, timeout: 20000 },
        (error, stdout) => (error ? reject(Object.assign(error, { stdout })) : resolve(stdout))
      );
    });
    assert.match(out, /Xvfb exited with 1/);
    assert.deepEqual(await readdir(temp), []);
  } finally {
    await rm(bin, { recursive: true, force: true });
    await rm(temp, { recursive: true, force: true });
  }
});
