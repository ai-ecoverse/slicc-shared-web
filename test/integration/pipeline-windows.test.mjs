import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

const windowsResult =
  /\n {10}WINDOWS: \$\{\{ inputs\.windows-test != '' && needs\.windows\.result \|\| 'off' \}\}\n/;

function gate(input, result) {
  const integration = job('integration');
  assert.match(integration, windowsResult);
  const lines = integration.split('\n');
  const start = lines.findIndex((line) => line.includes("node --input-type=module <<'EOF'"));
  const end = lines.findIndex((line, i) => i > start && /^ {10}EOF$/.test(line));
  const script = lines
    .slice(start, end + 1)
    .map((line) => line.slice(10))
    .join('\n');
  const dir = mkdtempSync(`${tmpdir()}/windows-gate-`);
  try {
    mkdirSync(`${dir}/junit/junit-0`, { recursive: true });
    writeFileSync(
      `${dir}/junit/junit-0/0.xml`,
      '<testsuites><testsuite><testcase name="a" file="test/a.test.mjs" time="1"/></testsuite></testsuites>'
    );
    return spawnSync('bash', ['-eo', 'pipefail', '-c', script], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        RESULT: 'success',
        WINDOWS: (input !== '' && result) || 'off',
        REQUIRE: 'true',
        FILES: '[]',
      },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('windows-test is an optional input, empty by default', () => {
  assert.match(text, /\n {6}windows-test:\n {8}type: string\n {8}default: ''\n/);
});

test('the windows job runs only with windows-test set, on windows-latest, read-only, on pull requests and in the merge queue', () => {
  const windows = job('windows');
  assert.match(windows, /\n {4}needs: lint\n/);
  assert.match(
    windows,
    /\n {4}if: inputs\.windows-test != '' && \(github\.event_name == 'pull_request' \|\| github\.event_name == 'merge_group'\)\n/
  );
  assert.match(windows, /\n {4}runs-on: windows-latest\n/);
  assert.match(windows, /\n {4}permissions:\n {6}contents: read\n {4}defaults:/);
  assert.match(windows, /\n {4}defaults:\n {6}run:\n {8}shell: pwsh\n/);
  assert.doesNotMatch(windows, /secrets\./);
  assert.match(windows, /persist-credentials: false/);
  assert.match(windows, /node-version: \$\{\{ inputs\.node-version \}\}/);
  assert.ok(windows.indexOf('- run: npm ci') < windows.indexOf('- name: Windows tests'));
});

test('the windows job runs windows-test as a PowerShell command that stops at a failing program', () => {
  const windows = job('windows');
  assert.match(windows, /WINDOWS_TEST: \$\{\{ inputs\.windows-test \}\}/);
  assert.match(
    windows,
    /run: \|\n {10}\$PSNativeCommandUseErrorActionPreference = \$true\n {10}Invoke-Expression \$env:WINDOWS_TEST\n/
  );
});

test('integration waits for the windows job and fails unless it passed, or was off', () => {
  assert.match(job('integration'), /\n {4}needs: \[lint, test, windows\]\n/);
  const cases = [
    ['', 'skipped', 0, 'integration: PASS 1 tests in 1 JUnit reports\n'],
    [
      'npm run test:windows',
      'success',
      0,
      'integration: PASS 1 tests in 1 JUnit reports, windows passed\n',
    ],
    [
      'npm run test:windows',
      'failure',
      1,
      'integration: FAIL the windows job ended with failure (1 tests in 1 JUnit reports)\n',
    ],
    [
      'npm run test:windows',
      'skipped',
      1,
      'integration: FAIL the windows job ended with skipped (1 tests in 1 JUnit reports)\n',
    ],
    [
      'npm run test:windows',
      'cancelled',
      1,
      'integration: FAIL the windows job ended with cancelled (1 tests in 1 JUnit reports)\n',
    ],
  ];
  for (const [input, result, status, stdout] of cases) {
    const run = gate(input, result);
    assert.equal(run.stdout, stdout, `${input} ${result}\n${run.stderr}`);
    assert.equal(run.status, status, `${input} ${result}`);
  }
});

test("this repo's own CI runs the windows job only on a pull request labelled windows", () => {
  const ci = readFileSync(`${root}/.github/workflows/ci.yml`, 'utf8');
  assert.match(
    ci,
    /\n {6}windows-test: \$\{\{ contains\(github\.event\.pull_request\.labels\.\*\.name, 'windows'\) && 'node -e "process\.platform===''win32''\|\|process\.exit\(1\)"' \|\| '' \}\}\n/
  );
});

test('the README documents windows-test with a caller', () => {
  const readme = readFileSync(`${root}/README.md`, 'utf8');
  assert.match(readme, /\n\| `windows-test` \| none \| /);
  assert.match(readme, /```yaml\n {4}with:\n {6}windows-test: npm run test:windows\n```/);
});
