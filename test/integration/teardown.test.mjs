import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { launch } from '@ai-ecoverse/slicc-shared-web/harness';
import { stop } from '../../harness/chrome.mjs';

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

function fake({ exitCode = null, answers = false } = {}) {
  const child = Object.assign(new EventEmitter(), {
    pid: 0,
    exitCode,
    signalCode: null,
    killed: [],
    kill: (signal) => child.killed.push(signal),
  });
  const cdp = {
    send: () => (answers ? Promise.resolve({}) : new Promise(() => {})),
    close: () => {},
  };
  return { child, cdp };
}

test('close() finishes when chrome ignores Browser.close', async () => {
  const chrome = await launch({ roots: [['/', 'test/integration/page/']] });
  process.kill(chrome.pid, 'SIGSTOP');
  try {
    const started = Date.now();
    await chrome.close();
    assert.ok(Date.now() - started < 40000, `${Date.now() - started} ms`);
    assert.ok(!alive(chrome.pid), `chrome ${chrome.pid} still runs`);
  } finally {
    if (alive(chrome.pid)) process.kill(chrome.pid, 'SIGKILL');
  }
});

test('stop() moves on when chrome survives SIGKILL', async () => {
  const { child, cdp } = fake();
  await stop(cdp, child, { close: 100, exit: 100, kill: 100 });
  assert.deepEqual(child.killed, ['SIGKILL']);
});

test('stop() does not wait for an exit that happened before it was called', async () => {
  const { child, cdp } = fake({ exitCode: 0, answers: true });
  const started = Date.now();
  await stop(cdp, child);
  assert.ok(Date.now() - started < 1000, `${Date.now() - started} ms`);
  assert.deepEqual(child.killed, []);
});
