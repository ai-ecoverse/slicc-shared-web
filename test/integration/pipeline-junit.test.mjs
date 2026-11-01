import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const text = readFileSync(`${root}/.github/workflows/pipeline.yml`, 'utf8');

function job(name) {
  const start = text.indexOf(`\n  ${name}:\n`);
  assert.ok(start > 0, name);
  const next = text.slice(start + 1).search(/\n {2}[a-z-]+:\n/);
  return text.slice(start, next < 0 ? undefined : start + 1 + next);
}

function verdict(reports) {
  const lines = job('integration').split('\n');
  const start = lines.findIndex((line) => line.includes("node --input-type=module <<'EOF'"));
  const end = lines.findIndex((line, i) => i > start && /^ {10}EOF$/.test(line));
  const script = lines
    .slice(start, end + 1)
    .map((line) => line.slice(10))
    .join('\n');
  const dir = mkdtempSync(join(tmpdir(), 'junit-verdict-'));
  try {
    reports.forEach((xml, i) => {
      mkdirSync(join(dir, `junit/junit-${i}`), { recursive: true });
      writeFileSync(join(dir, `junit/junit-${i}/${i}.xml`), xml);
    });
    return spawnSync('bash', ['-eo', 'pipefail', '-c', script], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, RESULT: 'success', WINDOWS: 'off', REQUIRE: 'true', FILES: '[]' },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const row = (name, inner = '', extra = '') =>
  inner
    ? `\t<testcase name="${name}" time="0.1" classname="test" file="/w/test/integration/a.test.mjs"${extra}>\n${inner}\n\t</testcase>`
    : `\t<testcase name="${name}" time="0.1" classname="test" file="/w/test/integration/a.test.mjs"${extra}/>`;
const skip = '\t\t<skipped type="skipped" message="true"/>';
const fail =
  '\t\t<failure type="testCodeFailure" message="x > y">\n[Error [ERR_TEST_FAILURE]: x > y]\n    at TestContext.&lt;anonymous> (file:///w/test/integration/a.test.mjs:6:41)\n\t\t</failure>';
const report = (rows) =>
  `<?xml version="1.0" encoding="utf-8"?>\n<testsuites>\n${rows.join('\n')}\n</testsuites>\n`;

test('rows whose name or failure has an unescaped > are each counted once, as Node writes them', () => {
  const first = report([
    row('plain'),
    row('skip me', skip),
    row(
      "a frame at data:text/html,&lt;h1>x&lt;/h1> keeps the lock, because its origin isn't known"
    ),
    row('plain after it'),
    row('skipped too', skip),
    row('fails with a > b', fail, ' failure="x > y"'),
    row('reaches a kernel server as &lt;port>.kernel.localhost'),
    row('skipped when a > b', skip),
    row('last'),
  ]);
  const second = report([
    `\t<testsuite name="suite &lt;b>bold&lt;/b>" time="0.2" disabled="0" errors="0" tests="2" failures="0" skipped="1" hostname="h">`,
    row('&lt;h1>x&lt;/h1> in a suite'),
    row('then &lt;i>skipped&lt;/i>', skip),
    row('then plain'),
    '\t</testsuite>',
  ]);
  const run = verdict([first, second]);
  assert.equal(
    run.stdout,
    'integration: FAIL 1 of 8 tests failed (8 tests (4 skipped) in 2 JUnit reports)\n',
    run.stderr
  );
  assert.equal(run.status, 1);
});

test('with no failing row, the same names pass with the exact count', () => {
  const run = verdict([
    report([
      row('skip me', skip),
      row('a frame at data:text/html,&lt;h1>x&lt;/h1> keeps the lock'),
      row('plain'),
      row('reaches a kernel server as &lt;port>.kernel.localhost'),
      row('skipped when a > b', skip),
    ]),
  ]);
  assert.equal(
    run.stdout,
    'integration: PASS 3 tests (2 skipped) in 1 JUnit reports\n',
    run.stderr
  );
  assert.equal(run.status, 0);
});
