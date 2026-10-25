import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

const download = (path) =>
  new RegExp(
    `- if: inputs\\.artifacts != ''\\n {8}uses: actions/download-artifact@[0-9a-f]{40}\\n {8}with:\\n {10}pattern: \\$\\{\\{ inputs\\.artifacts \\}\\}\\n {10}path: \\$\\{\\{ runner\\.temp \\}\\}/${path}\\n`
  );

test('artifacts is an optional input, empty by default', () => {
  assert.match(text, /\n {6}artifacts:\n {8}type: string\n {8}default: ''\n/);
});

test('each test shard gets the caller artifacts before its tests, as SLICC_ARTIFACTS', () => {
  const shard = job('test');
  assert.match(shard, download('artifacts'));
  assert.ok(shard.search(download('artifacts')) < shard.indexOf('- name: Integration tests'));
  assert.match(
    shard,
    /SLICC_ARTIFACTS: \$\{\{ inputs\.artifacts != '' && format\('\{0\}\/artifacts', runner\.temp\) \|\| '' \}\}/
  );
});

test('each reviewer gets the caller artifacts before the review-browser hook runs, and the prompt names them', () => {
  const reviewer = job('reviewer');
  assert.match(reviewer, download('review/artifacts'));
  assert.ok(
    reviewer.search(download('review/artifacts')) < reviewer.indexOf('- name: Four browsers')
  );
  assert.match(
    reviewer,
    /SLICC_ARTIFACTS: \$\{\{ inputs\.artifacts != '' && format\('\{0\}\/review\/artifacts', runner\.temp\) \|\| '' \}\}/
  );
  assert.match(reviewer, /ARTIFACTS: \$\{\{ inputs\.artifacts \}\}/);
  assert.match(reviewer, /\$\{ARTIFACTS:\+- \$RUNNER_TEMP\/review\/artifacts\/:/);
});

test('every upload replaces its earlier attempt, so a rerun leaves one artifact per name', () => {
  const steps = text
    .split(/\n(?= +- )/)
    .filter((step) => /^ +- (?:[a-z-]+: .*\n +)*uses: actions\/upload-artifact@/.test(step));
  assert.equal(steps.length, 6);
  for (const step of steps) assert.match(step, /\n {10}overwrite: true\n/, step);
});
