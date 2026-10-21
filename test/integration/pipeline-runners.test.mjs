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

test('tests run on pull requests and in the merge queue, and a release only on a push to main', () => {
  const both = "(github.event_name == 'pull_request' || github.event_name == 'merge_group')";
  for (const name of ['test', 'integration', 'review']) {
    assert.ok(value(jobs()[name], 'if').startsWith(both), name);
  }
  assert.equal(
    value(jobs().release, 'if'),
    "github.event_name == 'push' && github.ref == 'refs/heads/main'"
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

test('every review browser runs the harness extension', () => {
  const reviewer = jobs().reviewer.join('\n');
  assert.match(reviewer, /--load-extension="\$extension"/);
  assert.match(reviewer, /slicc-shared-web\/harness\/extension/);
});

test('deploy exports none of the secrets the pipeline declares for its own jobs', () => {
  const declared = [
    ...text
      .slice(text.indexOf('    secrets:\n'), text.indexOf('\npermissions:'))
      .matchAll(/^ {6}([A-Z_]+):$/gm),
  ].map((m) => m[1]);
  assert.ok(declared.includes('CLOUDFLARE_API_TOKEN'), declared.join());
  const own = /const own = new Set\(\[([^\]]*)\]\)/.exec(jobs().deploy.join('\n'))[1];
  for (const name of declared) assert.match(own, new RegExp(`'${name}'`), name);
});

test('a review gets review-timeout-minutes and review-screenshots, 60 and 30 by default', () => {
  assert.equal(value(jobs().reviewer, 'timeout-minutes'), '${{ inputs.review-timeout-minutes }}');
  assert.match(text, /review-timeout-minutes:\n {8}type: number\n {8}default: 60/);
  assert.match(text, /review-screenshots:\n {8}type: number\n {8}default: 30/);
  assert.match(jobs().reviewer.join('\n'), /at most \$SHOTS files/);
});

test('context takes the diff from git and survives an API quota running out', () => {
  const context = jobs().context.join('\n');
  assert.match(context, /git diff "\$BASE\.\.\.\$HEAD"/);
  assert.doesNotMatch(context, /gh (pr|issue) /);
  assert.match(context, /missing\.txt/);
  assert.doesNotMatch(text, /search_artifacts: true/);
});

test('lint plans the split once from the latest merge queue run, else the latest pull request run', () => {
  const lint = jobs().lint.join('\n');
  assert.match(lint, /id: queued[\s\S]*?event: merge_group/);
  assert.match(
    lint,
    /if: [^\n]*steps\.queued\.outputs\.found_artifact != 'true'[\s\S]*?event: pull_request/
  );
  assert.match(lint, /split: \$\{\{ steps\.split\.outputs\.split \}\}/);
  const test = jobs().test.join('\n');
  assert.doesNotMatch(test, /action-download-artifact|split-tests-by-timings/);
  assert.match(test, /FILES: \$\{\{ fromJSON\(needs\.lint\.outputs\.split\)\[matrix\.shard\] \}\}/);
});

test('integration fails when a test-glob file ran on no shard or on two', () => {
  const integration = jobs().integration.join('\n');
  assert.match(integration, /needs: \[lint, test\]/);
  assert.match(integration, /FILES: \$\{\{ needs\.lint\.outputs\.files \}\}/);
  assert.match(integration, /ran on no shard/);
  assert.match(integration, /ran on more than one shard/);
});

test("an issue post can't open in another repo becomes a pull request comment", () => {
  const post = jobs().post.join('\n');
  assert.match(post, /if \(target === repo\) \{\s*failed = true;/);
  assert.match(post, /wanted to open an issue in \$\{target\} but couldn't/);
});

test('reviewers get the head with full history and keep their files outside the checkout', () => {
  const reviewer = jobs().reviewer.join('\n');
  assert.match(reviewer, /uses: actions\/checkout@\S+\n\s+with:\n\s+fetch-depth: 0/);
  assert.doesNotMatch(reviewer, /(^|[\s"'(])review\/(?!name)/m);
  assert.match(reviewer, /--add-dir \$\{\{ runner\.temp \}\}\/review/);
});
