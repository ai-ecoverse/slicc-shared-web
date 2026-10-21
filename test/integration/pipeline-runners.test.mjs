import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const text = readFileSync(`${root}/.github/workflows/pipeline.yml`, 'utf8');
const fork =
  "github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name != github.repository && 'ubuntu-latest'";
const pool = `\${{ ${fork} || inputs.runs-on }}`;

function jobs() {
  const body = text.slice(text.indexOf('\njobs:\n'));
  const found = {};
  let current;
  for (const line of body.split('\n')) {
    const job = /^ {2}([a-z-]+):\s*$/.exec(line);
    if (job) {
      current = job[1];
      found[current] = [];
    } else if (current) {
      found[current].push(line);
    }
  }
  return found;
}

const value = (lines, key) =>
  lines.map((line) => new RegExp(`^ {4}${key}:\\s*(.+?)\\s*$`).exec(line)?.[1]).find(Boolean);

test('only release runs on ubuntu-latest; every other job runs on the pool, a fork on ubuntu-latest', () => {
  const all = jobs();
  assert.ok(Object.keys(all).length >= 8, Object.keys(all).join());
  for (const [name, lines] of Object.entries(all)) {
    assert.equal(value(lines, 'runs-on'), name === 'release' ? 'ubuntu-latest' : pool, name);
  }
  assert.match(text, /runs-on:\n {8}type: string\n {8}default: cloud-run-job/);
});

test('deploy runs on pull requests only, with an OIDC token', () => {
  const deploy = jobs().deploy.join('\n');
  assert.match(deploy, /if: inputs\.deploy != '' && github\.event_name == 'pull_request'/);
  assert.match(deploy, /permissions:\n {6}contents: read\n {6}id-token: write/);
});

test('reviewers start only when the repo can read the Bedrock secret', () => {
  assert.match(jobs().reviewer.join('\n'), /needs\.lint\.outputs\.bedrock == 'true'/);
  assert.match(jobs().review.join('\n'), /AWS_BEARER_TOKEN_BEDROCK isn't available to this repo/);
});

test("this repo's own CI is only the pipeline caller, so a fork's pull request stays off the pool", () => {
  const ci = readFileSync(`${root}/.github/workflows/ci.yml`, 'utf8');
  assert.doesNotMatch(ci, /^ {4}runs-on:/m);
  assert.match(ci, /uses: \.\/\.github\/workflows\/pipeline\.yml/);
});

test('release runs in release-environment, and after-release only when a new tag points at the commit', () => {
  const release = jobs().release.join('\n');
  assert.match(release, /environment: \$\{\{ inputs\.release-environment \}\}/);
  assert.match(release, /RELEASE_VERSION=\$\(git tag --points-at HEAD --list 'v\*'/);
  assert.match(release, /if \[ -z "\$RELEASE_VERSION" \]; then[\s\S]*?exit 0/);
});

test("a caller's command fails on its first failing line, pipes included", () => {
  const calls = [
    ...text.matchAll(/bash (?:[-\w]+ )*?-c "\$(LINT|DEPLOY|TEST|REVIEW_BROWSER|AFTER_RELEASE)"/g),
  ];
  assert.equal(calls.length, 5, calls.map((m) => m[0]).join());
  for (const [call] of calls) assert.match(call, /^bash -eo pipefail -c /, call);
});

test('tests run on pull requests and in the merge queue; a release also runs on workflow_dispatch', () => {
  const both = "(github.event_name == 'pull_request' || github.event_name == 'merge_group')";
  for (const name of ['test', 'integration', 'review']) {
    assert.ok(value(jobs()[name], 'if').startsWith(both), name);
  }
  assert.match(
    value(jobs().release, 'if'),
    /^\(github\.event_name == 'push' \|\| github\.event_name == 'workflow_dispatch'\) && github\.ref == 'refs\/heads\/main'$/
  );
});

test('integration needs a test in the JUnit reports, and node-options adds to the shard preload', () => {
  const integration = jobs().integration.join('\n');
  assert.match(integration, /pattern: junit-\*/);
  assert.match(integration, /integration: FAIL/);
  assert.match(text, /SLICC_TEST_NODE_OPTIONS="\$\{NODE_OPTIONS:-\} \$EXTRA_NODE_OPTIONS"/);
});

test('only post gets the Cloudflare token, for the reviewers screenshots', () => {
  const holders = Object.entries(jobs())
    .filter(([, lines]) => lines.some((line) => line.includes('secrets.CLOUDFLARE_API_TOKEN')))
    .map(([name]) => name);
  assert.deepEqual(holders, ['post']);
});
