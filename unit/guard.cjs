'use strict';
const { appendFileSync } = require('node:fs');
const { relative } = require('node:path');

const report = process.env.SLICC_UNIT_REPORT;
const runner = 'SLICC_UNIT_RUNNER';

if (report && process.execArgv.includes('--test') && !process.env.NODE_TEST_CONTEXT) {
  process.env[runner] = String(process.pid);
  const ms = Number(process.env.SLICC_UNIT_TIMEOUT);
  if (ms > 0) process.execArgv.push(`--test-timeout=${ms}`);
  process.execArgv.push('--test-force-exit');
} else if (
  report &&
  process.env.NODE_TEST_CONTEXT &&
  process.ppid === Number(process.env[runner])
) {
  const file = relative(process.cwd(), process.argv[1] ?? '');
  const note = (line) => appendFileSync(report, `${file}${line}\n`);
  require('node:test').afterEach((t) => {
    if (t.error?.failureType === 'testTimeoutFailure') note(`: "${t.fullName}" ${t.error.message}`);
  });
  process.on('exit', () => {
    let stdio = 3;
    const open = process
      .getActiveResourcesInfo()
      .filter((name) => !(/^(Pipe|TTY)Wrap$/.test(name) && stdio-- > 0));
    if (open.length === 0) return;
    note(` was force-exited after its tests, open handles kept it alive (${open.join(', ')})`);
    process.exitCode = 1;
  });
}
