import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

test('only release runs on ubuntu-latest and windows on windows-latest; every other job runs on the pool, a fork on ubuntu-latest', () => {
  const all = jobs();
  assert.ok(Object.keys(all).length >= 8, Object.keys(all).join());
  const hosted = { release: 'ubuntu-latest', windows: 'windows-latest' };
  for (const [name, lines] of Object.entries(all)) {
    assert.equal(value(lines, 'runs-on'), hosted[name] ?? pool, name);
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
  assert.match(lint, /id: split\n {8}if: [^\n]+\n {8}shell: bash\n/);
  const test = jobs().test.join('\n');
  assert.doesNotMatch(test, /action-download-artifact|split-tests-by-timings/);
  assert.match(test, /FILES: \$\{\{ fromJSON\(needs\.lint\.outputs\.split\)\[matrix\.shard\] \}\}/);
});

test('integration fails when a test-glob file ran on no shard or on two', () => {
  const integration = jobs().integration.join('\n');
  assert.match(integration, /needs: \[lint, test, windows\]/);
  assert.match(integration, /FILES: \$\{\{ needs\.lint\.outputs\.files \}\}/);
  assert.match(integration, /ran on no shard/);
  assert.match(integration, /ran on more than one shard/);
  assert.match(integration, /of \$\{files\.length\} test-glob files on exactly one shard/);
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

test('post downloads each reviewer findings by name, so one missing reviewer does not hide the other', () => {
  const post = jobs().post.join('\n');
  for (const agent of ['claude', 'codex']) {
    assert.match(
      post,
      new RegExp(`name: findings-${agent}\\n {10}path: findings/findings-${agent}`)
    );
  }
  assert.doesNotMatch(post, /pattern: findings-/);
});

function steps(lines) {
  const found = [];
  for (const line of lines) {
    if (/^ {6}- /.test(line)) found.push([]);
    if (found.length) found.at(-1).push(line);
  }
  return found;
}

const field = (step, key) =>
  step.map((line) => new RegExp(`^ {10}${key}:\\s*(.+?)\\s*$`).exec(line)?.[1]).find(Boolean);

function gate(uploaded) {
  const all = steps(jobs().review);
  const dir = mkdtempSync(`${tmpdir()}/review-gate-`);
  try {
    for (const step of all.filter((s) => s.some((l) => l.includes('actions/download-artifact@')))) {
      const path = field(step, 'path');
      const name = field(step, 'name');
      const pattern = field(step, 'pattern');
      const glob = pattern && new RegExp(`^${pattern.replaceAll('*', '.*')}$`);
      const matches = Object.keys(uploaded).filter((key) => (name ? key === name : glob.test(key)));
      for (const match of matches) {
        const to = name || matches.length === 1 ? `${dir}/${path}` : `${dir}/${path}/${match}`;
        mkdirSync(to, { recursive: true });
        writeFileSync(`${to}/findings.json`, JSON.stringify({ verdict: uploaded[match] }));
      }
    }
    const run = all.find((s) => s.some((l) => l.includes('for agent in claude codex')));
    const script = run
      .slice(run.findIndex((l) => /^ {8}run: \|$/.test(l)) + 1)
      .map((l) => l.slice(10))
      .join('\n');
    return spawnSync('bash', ['-e', '-c', script], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        EVENT: 'pull_request',
        REVIEW: 'true',
        BEDROCK: 'true',
        FORK: 'false',
      },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the review gate reads the surviving verdict when only one reviewer uploaded findings', () => {
  const cases = [
    [{ 'findings-codex': 'approved' }, 'claude: no findings\ncodex: approved\n', 1],
    [{ 'findings-claude': 'approved' }, 'claude: approved\ncodex: no findings\n', 1],
    [
      { 'findings-claude': 'approved', 'findings-codex': 'changes_requested' },
      'claude: approved\ncodex: changes_requested\n',
      1,
    ],
    [
      { 'findings-claude': 'approved', 'findings-codex': 'approved' },
      'claude: approved\ncodex: approved\n',
      0,
    ],
  ];
  for (const [uploaded, stdout, status] of cases) {
    const result = gate(uploaded);
    assert.equal(result.stdout, stdout, result.stderr);
    assert.equal(result.status, status);
  }
  assert.doesNotMatch(jobs().review.join('\n'), /pattern: findings-/);
});

test('the Claude reviewer runs Claude Code installed from npm, not from the rate-limited installer', () => {
  const reviewer = jobs().reviewer.join('\n');
  assert.match(
    reviewer,
    /npm install --prefix "\$RUNNER_TEMP\/claude-code"[^\n]*@anthropic-ai\/claude-code@\$CLAUDE_CODE/
  );
  assert.match(
    reviewer,
    /path_to_claude_code_executable: \$\{\{ steps\.claude-code\.outputs\.path \}\}/
  );
});

test('release gets only the secrets release-secrets names, and attests the attest files after a release', () => {
  const release = jobs().release.join('\n');
  assert.match(release, /permissions:\n(?: {6}[a-z-]+: \w+\n)* {6}attestations: write/);
  const own = /const own = new Set\(\[([^\]]*)\]\)/.exec(release)[1];
  for (const name of ['AWS_BEARER_TOKEN_BEDROCK', 'SLICC_ISSUES_TOKEN', 'CLOUDFLARE_API_TOKEN'])
    assert.match(own, new RegExp(`'${name}'`));
  assert.match(release, /if \(!own\.has\(key\) && only\.has\(key\)\)/);
  assert.match(
    release,
    /if: \$\{\{ !cancelled\(\) && inputs\.attest != '' && steps\.released\.outputs\.tag != '' \}\}\n {8}uses: actions\/attest-build-provenance@\w+\n {8}with:\n {10}subject-path: \$\{\{ inputs\.attest \}\}/
  );
});

test("the README's caller grants every permission the pipeline's jobs ask for", () => {
  const readme = readFileSync(`${root}/README.md`, 'utf8');
  const granted = /\npermissions:\n((?: {2}[a-z-]+: \w+\n)+)/.exec(readme)[1];
  const asked = new Set([...text.matchAll(/^ {6}([a-z-]+): write$/gm)].map((m) => m[1]));
  for (const name of asked) assert.match(granted, new RegExp(`^ {2}${name}: write$`, 'm'), name);
});

test('a release that tagged but failed to publish still gets its attestation', () => {
  const release = jobs().release.join('\n');
  assert.match(release, /id: released\n {8}if: \$\{\{ !cancelled\(\) && inputs\.attest != '' \}\}/);
});

function stepScript(job, marker) {
  const step = steps(jobs()[job]).find((s) => s.some((l) => l.includes(marker)));
  return step
    .slice(step.findIndex((l) => /^ {6}(- | {2})run: \|$/.test(l)) + 1)
    .map((l) => l.slice(10))
    .join('\n');
}

function reviewBase(base) {
  const dir = mkdtempSync(`${tmpdir()}/review-base-`);
  try {
    const workspace = `${dir}/workspace`;
    const temp = `${dir}/temp`;
    const bin = `${dir}/bin`;
    const script = {
      'review:browser': 'echo "$SLICC_REVIEW_SIDE $SLICC_REVIEW_LINK" >> "$RUNNER_TEMP/hooked"',
    };
    const pkg = JSON.stringify({ name: 'fixture', version: '1.0.0', scripts: script });
    const lock = JSON.stringify({
      name: 'fixture',
      version: '1.0.0',
      lockfileVersion: 3,
      requires: true,
      packages: { '': { name: 'fixture', version: '1.0.0' } },
    });
    mkdirSync(`${workspace}/base`, { recursive: true });
    mkdirSync(`${workspace}/harness/extension`, { recursive: true });
    mkdirSync(`${temp}/review`, { recursive: true });
    mkdirSync(bin);
    writeFileSync(`${workspace}/package.json`, pkg);
    writeFileSync(`${workspace}/package-lock.json`, lock);
    writeFileSync(`${workspace}/harness/extension/manifest.json`, '{}');
    if (base.pkg) writeFileSync(`${workspace}/base/package.json`, pkg);
    if (base.lock) writeFileSync(`${workspace}/base/package-lock.json`, lock);
    writeFileSync(`${bin}/chrome`, '#!/bin/sh\n', { mode: 0o755 });
    writeFileSync(`${bin}/curl`, '#!/bin/sh\n', { mode: 0o755 });
    writeFileSync(
      `${bin}/npx`,
      `#!/bin/sh\ncase " $* " in *" find-browser "*) echo "${bin}/chrome" ;; esac\n`,
      { mode: 0o755 }
    );
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      DISPLAY: ':0',
      GITHUB_WORKSPACE: workspace,
      GITHUB_ENV: `${temp}/env`,
      RUNNER_TEMP: temp,
      REVIEW_BROWSER: /review-browser:\n {8}type: string\n {8}default: (.+)/.exec(text)[1],
      npm_config_audit: 'false',
      npm_config_fund: 'false',
      npm_config_offline: 'true',
    };
    for (const marker of ['mv base "$RUNNER_TEMP/base"', 'name: Four browsers']) {
      const run = spawnSync('bash', ['-eo', 'pipefail', '-c', stepScript('reviewer', marker)], {
        cwd: workspace,
        encoding: 'utf8',
        env,
      });
      assert.equal(run.status, 0, `${marker}\n${run.stdout}\n${run.stderr}`);
    }
    const read = (path) => readFileSync(`${temp}/${path}`, 'utf8');
    return { hooked: read('hooked'), browsers: JSON.parse(read('review/browsers.json')) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a base without a lockfile, or without a package.json, still gets both reviewers their four browsers', () => {
  const cases = [
    [{}, 'head extension\nhead cli\n'],
    [{ pkg: true }, 'head extension\nhead cli\n'],
    [{ pkg: true, lock: true }, 'head extension\nhead cli\nbase extension\nbase cli\n'],
  ];
  for (const [base, hooked] of cases) {
    const review = reviewBase(base);
    assert.equal(review.hooked, hooked, JSON.stringify(base));
    assert.deepEqual(
      review.browsers.map((b) => `${b.side} ${b.link}`),
      ['head extension', 'head cli', 'base extension', 'base cli']
    );
  }
});

test('reviewers deny only for likely, confirmed problems and comment on narrow races', () => {
  const reviewer = jobs().reviewer.join('\n');
  assert.match(
    reviewer,
    /Deny only for a problem you confirmed that users or operators are likely to hit/
  );
  assert.match(reviewer, /doesn't block: approve, describe the scenario in a comment/);
  assert.match(reviewer, /don't move from one narrow case to the next/);
});

test('the split weighs each file by its own wall time when shard.cjs recorded one', () => {
  const lint = jobs().lint.join('\n');
  assert.match(lint, /junit-download\/\*\*\/\*\.times/);
  assert.match(lint, /for \(const \[file, wall\] of walls\) seconds\.set\(file, wall\);/);
});

test('deploy runs pull request code, so it gets no secret unless deploy-secrets names it', () => {
  const deploy = jobs().deploy.join('\n');
  assert.match(
    deploy,
    /- name: Secrets as environment variables\n {8}if: inputs\.deploy-secrets != ''/
  );
  assert.match(deploy, /if \(!own\.has\(key\) && only\.has\(key\)\)/);
  assert.doesNotMatch(deploy, /only\.size === 0/);
});

test('this repo releases through its own pipeline: ci.yml runs it on pushes too, and there is no release.yml', () => {
  const ci = readFileSync(`${root}/.github/workflows/ci.yml`, 'utf8');
  assert.doesNotMatch(ci, /event_name != 'push'/);
  assert.equal(existsSync(`${root}/.github/workflows/release.yml`), false);
  const pkg = JSON.parse(readFileSync(`${root}/package.json`, 'utf8'));
  assert.equal(pkg.fledgling.workflow, 'ci.yml');
});
