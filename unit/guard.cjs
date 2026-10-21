'use strict';
const { appendFileSync } = require('node:fs');
const { relative } = require('node:path');

const report = process.env.SLICC_UNIT_REPORT;
const runner = 'SLICC_UNIT_RUNNER';
const ms = Number(process.env.SLICC_UNIT_TIMEOUT);
const grace = 3000;
const stall = ms + 5000;

const watchdog = `const { appendFileSync } = require('node:fs');
const { workerData: { beat, stall, report, line } } = require('node:worker_threads');
let last = Atomics.load(beat, 0);
while (Atomics.wait(beat, 0, last, stall) !== 'timed-out') last = Atomics.load(beat, 0);
appendFileSync(report, line);
process.kill(process.pid, 'SIGKILL');`;

if (report && process.execArgv.includes('--test') && !process.env.NODE_TEST_CONTEXT) {
  process.env[runner] = String(process.pid);
  if (ms > 0) process.execArgv.push(`--test-timeout=${ms}`);
} else if (
  report &&
  process.env.NODE_TEST_CONTEXT &&
  require('node:worker_threads').isMainThread &&
  process.ppid === Number(process.env[runner])
) {
  const file = relative(process.cwd(), process.argv[1] ?? '');
  const note = (line) => appendFileSync(report, `${file}${line}\n`);
  const beat = new Int32Array(new SharedArrayBuffer(4));
  const alive = () => Atomics.notify(beat, 0, Atomics.add(beat, 0, 1) + 1);
  if (ms > 0) {
    const { Worker } = require('node:worker_threads');
    const line = `${file} was killed after ${stall}ms without a test starting or ending (a hang outside any test, or a blocked event loop)\n`;
    new Worker(watchdog, { eval: true, workerData: { beat, stall, report, line } }).unref();
  }
  const { after, afterEach, beforeEach } = require('node:test');
  beforeEach(alive);
  afterEach((t) => {
    alive();
    if (t.error?.failureType === 'testTimeoutFailure') note(`: "${t.fullName}" ${t.error.message}`);
  });
  after(() => {
    alive();
    setTimeout(() => {
      let stdio = 3;
      const open = process
        .getActiveResourcesInfo()
        .filter((name) => !(/^(Pipe|TTY)Wrap$/.test(name) && stdio-- > 0));
      note(
        ` was still running ${grace}ms after its tests, open handles kept it alive (${open.join(', ')})`
      );
      process.exit(1);
    }, grace).unref();
  });
}
