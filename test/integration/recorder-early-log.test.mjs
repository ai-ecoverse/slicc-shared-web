import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { recorder } from '../../harness/recorder.mjs';

const dirs = [];
after(() => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))));

function fake() {
  const listeners = [];
  return {
    on: (listener) => listeners.push(listener),
    send: async () => ({}),
    emit: async (event) => {
      for (const listener of listeners) await listener(event);
    },
  };
}

const worker = {
  sessionId: 'sw',
  waitingForDebugger: false,
  targetInfo: {
    targetId: 'sw-target',
    type: 'service_worker',
    url: 'chrome-extension://abc/background.js',
    browserContextId: 'default',
  },
};

const logged = (text) => ({
  method: 'Runtime.consoleAPICalled',
  sessionId: 'sw',
  params: { type: 'log', args: [{ value: text }] },
});

async function consoleOf(events) {
  const dir = await mkdtemp(join(tmpdir(), 'slicc-recorder-'));
  dirs.push(dir);
  const cdp = fake();
  const record = recorder(cdp, { source: () => null }, { coverage: [], profiling: false });
  await cdp.emit({ method: 'Target.attachedToTarget', params: worker });
  await events(cdp, (name) => record.begin(undefined, pathToFileURL(`${dir}/`), name));
  await record.end();
  return readFile(join(dir, 'console.log'), 'utf8');
}

test('a shared run keeps a service worker line logged before its first page attaches', async () => {
  const text = await consoleOf(async (cdp, begin) => {
    begin('shared-before-page');
    await cdp.emit(logged('background 2584'));
  });
  assert.match(text, /background: log background 2584/);
});

test('a line logged before the run starts still goes into the first run', async () => {
  const text = await consoleOf(async (cdp, begin) => {
    await cdp.emit(logged('background early'));
    begin('shared-early');
  });
  assert.match(text, /background: log background early/);
});
