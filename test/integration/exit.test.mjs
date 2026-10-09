import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { after, test } from 'node:test';
import { prune } from '../../harness/chrome.mjs';
import { sleep } from '../../harness/util.mjs';

const harness = new URL('../../harness/index.mjs', import.meta.url).href;
const dirs = [];
after(() => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))));

const script = `
const { launch } = await import(process.env.HARNESS);
const chrome = await launch({ roots: [['/', 'test/integration/page/']] });
console.log(JSON.stringify({ pid: chrome.pid, profile: chrome.profile }));
if (process.env.END === 'exit') process.exit(3);
setInterval(() => {}, 60000);
`;

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

async function gone(pid, ms = 10000) {
  const deadline = Date.now() + ms;
  while (alive(pid) && Date.now() < deadline) await sleep(100);
  return !alive(pid);
}

async function leftovers(dir) {
  return (await readdir(dir)).filter((name) => name.startsWith('slicc-'));
}

async function orphan(end) {
  const dir = await mkdtemp(join(tmpdir(), 'slicc-exit-'));
  dirs.push(dir);
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, HARNESS: harness, END: end, TMPDIR: dir },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const exited = new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  const line = await new Promise((resolve, reject) => {
    createInterface({ input: child.stdout }).once('line', resolve);
    void exited.then(({ code, signal }) => reject(new Error(`exited with ${signal ?? code}`)));
  });
  const { pid, profile } = JSON.parse(line);
  assert.ok(alive(pid), 'chrome runs');
  assert.ok(existsSync(profile), 'profile exists');
  if (end !== 'exit') child.kill(end);
  return { dir, pid, profile, exit: await exited };
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  test(`${signal} before close() stops chrome and removes its profile`, async () => {
    const { dir, pid, exit } = await orphan(signal);
    assert.deepEqual(exit, { code: null, signal });
    assert.ok(await gone(pid), `chrome ${pid} still runs`);
    assert.deepEqual(await leftovers(dir), []);
  });
}

test('process.exit() before close() stops chrome and removes its profile', async () => {
  const { dir, pid, exit } = await orphan('exit');
  assert.deepEqual(exit, { code: 3, signal: null });
  assert.ok(await gone(pid), `chrome ${pid} still runs`);
  assert.deepEqual(await leftovers(dir), []);
});

test('SIGKILL before close() stops chrome, and the next launch removes its profile', async () => {
  const { dir, pid, profile, exit } = await orphan('SIGKILL');
  assert.deepEqual(exit, { code: null, signal: 'SIGKILL' });
  assert.ok(await gone(pid), `chrome ${pid} still runs`);
  assert.ok(existsSync(profile), 'profile survives SIGKILL');
  await prune(dir, 0);
  assert.ok(!existsSync(profile), 'prune removes the profile');
});

test('prune keeps a profile a running chrome uses, even in a path with spaces', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'slicc exit '));
  dirs.push(dir);
  const profile = await mkdtemp(join(dir, 'slicc-harness-'));
  const holder = spawn(process.execPath, [
    '-e',
    'setInterval(() => {}, 60000)',
    '--',
    `--user-data-dir=${profile}`,
  ]);
  try {
    await prune(dir, 0);
    assert.ok(existsSync(profile), 'profile in use is kept');
  } finally {
    holder.kill('SIGKILL');
  }
});
