import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { commit, commitAll, initFixtureRepo } from '@ai-ecoverse/slicc-shared-web/testing';

const root = fileURLToPath(new URL('../..', import.meta.url));
const text = readFileSync(join(root, '.github/workflows/pipeline.yml'), 'utf8');
const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function job(name) {
  const start = text.indexOf(`\n  ${name}:\n`);
  assert.ok(start >= 0, `no ${name} job`);
  const next = text.slice(start + 1).search(/\n {2}[a-z-]+:\n/);
  return text.slice(start, next < 0 ? undefined : start + 1 + next);
}

function step(jobName, marker) {
  const found = job(jobName)
    .split(/\n(?= {6}- )/)
    .slice(1)
    .find((body) => body.includes(marker));
  assert.ok(found, `no step with ${marker} in ${jobName}`);
  const lines = found.split('\n');
  const at = lines.findIndex((line) => /^ {8}run: /.test(line));
  if (lines[at].trim() !== 'run: |') return lines[at].trim().slice('run: '.length);
  const body = [];
  for (const line of lines.slice(at + 1)) {
    if (line.trim() && !line.startsWith('          ')) break;
    body.push(line.slice(10));
  }
  return body.join('\n');
}

const sh = (script, cwd, env) =>
  new Promise((resolve) => {
    const child = spawn('bash', ['-eo', 'pipefail', '-c', script], { cwd, env });
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
    });
    child.stderr.on('data', (chunk) => {
      out += chunk;
    });
    child.on('close', (status) => resolve({ status, out }));
  });

const base = () => ({
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  GIT_CONFIG_GLOBAL: devNull,
  GIT_CONFIG_NOSYSTEM: '1',
});

let api;
let server;
before(async () => {
  server = createServer((req, res) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const call = {
        method: req.method,
        path: url.pathname,
        query: url.search,
        body: data ? JSON.parse(data) : undefined,
      };
      api.calls.push(call);
      const [status, answer] = api.answer(call);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answer ?? {}));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
});
after(() => server.close());

function github({ issues = [], refuse = false } = {}) {
  const state = {
    issues: issues.map((issue) => ({ labels: [], state: 'open', ...issue })),
    calls: [],
  };
  state.answer = ({ method, path, query, body }) => {
    if (refuse) return [403, { message: 'Resource not accessible by integration' }];
    const issue = /^\/repos\/o\/r\/issues\/(\d+)/.exec(path);
    const found = issue && state.issues.find((entry) => entry.number === Number(issue[1]));
    if (method === 'GET' && path === '/repos/o/r/issues') {
      const open = new URLSearchParams(query).get('state');
      return [
        200,
        state.issues.filter(
          (entry) =>
            entry.state === open && entry.labels.some((label) => label.name === 'flaky-test')
        ),
      ];
    }
    if (method === 'POST' && path === '/repos/o/r/issues') {
      const created = {
        number: 100 + state.issues.length,
        title: body.title,
        body: body.body,
        state: 'open',
        labels: body.labels.map((name) => ({ name })),
      };
      state.issues.push(created);
      return [201, created];
    }
    if (method === 'POST' && path.endsWith('/comments')) return [201, { id: 1 }];
    if (method === 'POST' && path === '/repos/o/r/labels') return [201, {}];
    if (found && method === 'PATCH') {
      Object.assign(found, body);
      return [200, found];
    }
    return [404, { message: 'Not Found' }];
  };
  api = state;
  return state;
}

const url = () => `http://127.0.0.1:${server.address().port}`;
const id = (file, name) =>
  createHash('sha256').update(`${file}\u0000${name}`).digest('hex').slice(0, 16);
const retried = "process.env.SLICC_TEST_RETRY === '1'";
const FIXTURES = {
  flip: `import assert from 'node:assert/strict';\nimport { test } from 'node:test';\ntest('flips on its first try', () => assert.ok(${retried}, 'the first try fails'));\n`,
  steady: "import { test } from 'node:test';\ntest('passes', () => {});\n",
  skips: `import { test } from 'node:test';\ntest('skips on retry', { skip: ${retried} }, () => { throw new Error('first'); });\n`,
  cancels: `import { before, describe, it } from 'node:test';\ndescribe('cancels on retry', () => {\n  before(() => { if (${retried}) throw new Error('hook'); });\n  it('runs', () => { if (!(${retried})) throw new Error('first'); });\n});\n`,
  empty: `import { test } from 'node:test';\nif (!(${retried})) test('registers nothing on retry', () => { throw new Error('first'); });\n`,
  slow: `import { test } from 'node:test';\ntest('hangs on retry', async () => {\n  if (!(${retried})) throw new Error('first');\n  await new Promise((resolve) => setTimeout(resolve, 60000));\n});\n`,
};

const testFiles = (dir) =>
  readdirSync(join(dir, 'test/integration'))
    .sort()
    .map((name) => `test/integration/${name}`);

function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), 'slicc-flaky-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'test/integration'), { recursive: true });
  mkdirSync(join(dir, 'node_modules/@ai-ecoverse'), { recursive: true });
  symlinkSync(root, join(dir, 'node_modules/@ai-ecoverse/slicc-shared-web'));
  writeFileSync(join(dir, '.gitignore'), 'node_modules/\njunit/\ntmp/\n');
  for (const [name, fixtureName] of Object.entries(files)) {
    writeFileSync(join(dir, `test/integration/${name}.test.mjs`), FIXTURES[fixtureName]);
  }
  mkdirSync(join(dir, 'tmp'));
  cpSync(join(root, 'bin/slicc-flaky.mjs'), join(dir, 'tmp/slicc-flaky.mjs'));
  initFixtureRepo(dir, { hooks: false });
  commitAll(dir, 'base');
  commit(dir, 'the pull request');
  return dir;
}

async function lint(dir, { event = 'pull_request' } = {}) {
  const head = await sh('git rev-parse HEAD', dir, base());
  const sha = head.out.trim();
  await sh('git remote add origin "$PWD"', dir, base());
  const output = join(dir, 'tmp/output');
  writeFileSync(output, '');
  const run = await sh(step('lint', 'id: flaky'), dir, {
    ...base(),
    GH_TOKEN: 'token',
    GITHUB_API_URL: url(),
    GITHUB_REPOSITORY: 'o/r',
    GITHUB_EVENT_NAME: event,
    GITHUB_SHA: sha,
    SHA: sha,
    GITHUB_OUTPUT: output,
  });
  assert.equal(run.status, 0, run.out);
  const line = readFileSync(output, 'utf8').trim();
  return { flaky: line ? line.slice('flaky='.length) : '', log: run.out, sha };
}

async function shard(
  dir,
  {
    flaky = '',
    retry = 3,
    sha = 'cafe',
    minutes = 20,
    test: command = 'node --test test/integration/*.test.mjs',
  } = {}
) {
  const files = testFiles(dir);
  return sh(step('test', 'name: Integration tests'), dir, {
    ...base(),
    DISPLAY: ':0',
    TEST: command,
    GLOB: 'test/integration/*.test.mjs',
    FILES: files.join('\n'),
    SHARD: '0',
    EXTRA_NODE_OPTIONS: '',
    FLAKY_RETRY: String(retry),
    FLAKY: flaky,
    STRICT: '**/*guard*.test.*\n**/*security*.test.*\n',
    SHA: sha,
    TIMEOUT_MINUTES: String(minutes),
    RUNNER_TEMP: join(dir, 'tmp'),
    RUNNER_NAME: 'fixture-runner',
    GITHUB_RUN_ATTEMPT: '1',
  });
}

async function integration(dir, { flaky = '', sha = 'cafe' } = {}) {
  const work = join(dir, 'tmp/integration');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(join(work, 'junit'), { recursive: true });
  cpSync(join(dir, 'junit'), join(work, 'junit/junit-0'), { recursive: true });
  const env = {
    ...base(),
    RUNNER_TEMP: join(dir, 'tmp'),
    FLAKY: flaky,
    STRICT: '**/*guard*.test.*',
    SHA: sha,
  };
  const verdict = await sh(step('integration', 'name: Flaky verdict'), work, env);
  assert.equal(verdict.status, 0, verdict.out);
  const files = testFiles(dir);
  return sh(step('integration', 'RESULT'), work, {
    ...env,
    RESULT: 'success',
    WINDOWS: 'off',
    REQUIRE: 'true',
    FILES: JSON.stringify(files),
    VERDICT: join(dir, 'tmp/slicc-flaky/verdict.json'),
  });
}

async function report(dir, { flaky = '', event = 'pull_request', branch = 'feature' } = {}) {
  const summary = join(dir, 'tmp/summary.md');
  const run = await sh(step('flaky', 'name: Flaky report'), dir, {
    ...base(),
    RUNNER_TEMP: join(dir, 'tmp'),
    GH_TOKEN: 'token',
    GITHUB_API_URL: url(),
    GITHUB_SERVER_URL: 'https://github.test',
    GITHUB_REPOSITORY: 'o/r',
    GITHUB_RUN_ID: '42',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_EVENT_NAME: event,
    GITHUB_HEAD_REF: branch,
    GITHUB_STEP_SUMMARY: summary,
    FLAKY: flaky,
    STRICT: '**/*guard*.test.*',
    QUIET: 'probe/**',
    CLOSE_AFTER: '20',
    PR: '9',
  });
  assert.equal(run.status, 0, run.out);
  return { log: run.out, summary: readFileSync(summary, 'utf8') };
}

const record = (dir) => JSON.parse(readFileSync(join(dir, 'junit/0.flaky.json'), 'utf8'));
const posted = (state, method, path) =>
  state.calls.filter((call) => call.method === method && call.path === path);

test('a first flip of an unknown, non-strict test stays red and is filed as new', async () => {
  const dir = fixture({ flip: 'flip', steady: 'steady' });
  const state = github();
  const { flaky, sha } = await lint(dir);
  const run = await shard(dir, { flaky, sha });
  assert.equal(run.status, 1, run.out);
  assert.match(run.out, /flaky: shard 0: rerunning test\/integration\/flip\.test\.mjs/);
  assert.match(
    run.out,
    /::error title=Flaky::test\/integration\/flip\.test\.mjs › flips on its first try: first flip/
  );
  assert.ok(existsSync(join(dir, 'junit/0.retry.xml')));
  assert.equal(record(dir).rows[0].kind, 'new');
  const gate = await integration(dir, { flaky, sha });
  assert.equal(gate.status, 1, gate.out);
  assert.match(gate.out, /integration: FAIL 1 of 2 tests failed/);
  const { summary } = await report(dir, { flaky });
  const [created] = posted(state, 'POST', '/repos/o/r/issues');
  assert.equal(created.body.title, 'flaky: flip.test.mjs › flips on its first try');
  assert.deepEqual(created.body.labels, ['flaky-test', 'new']);
  const marker = id('test/integration/flip.test.mjs', 'flips on its first try');
  assert.ok(created.body.body.includes(`Key: \`${marker}\``), created.body.body);
  assert.match(created.body.body, /the first try fails/);
  assert.match(created.body.body, new RegExp(`- Commit: ${sha}`));
  assert.match(
    summary,
    /\| `test\/integration\/flip\.test\.mjs` › flips on its first try \| 0 \| first flip.* \| #100 \(new\) \|/
  );
});

test('the same flip passes when an open issue knows the test from another commit, and comments on it', async () => {
  const dir = fixture({ flip: 'flip', steady: 'steady' });
  const marker = id('test/integration/flip.test.mjs', 'flips on its first try');
  const state = github({
    issues: [
      {
        number: 7,
        body: `flipped\n\n- Commit: 0ld\n\nKey: \`${marker}\``,
        labels: [{ name: 'flaky-test' }, { name: 'new' }],
      },
    ],
  });
  const { flaky, sha, log } = await lint(dir);
  const run = await shard(dir, { flaky, sha });
  assert.equal(run.status, 0, `${flaky}\n${log}`);
  assert.match(run.out, /flaky: shard 0: PASS, 1 known flake passed on retry \(#7\)/);
  const gate = await integration(dir, { flaky, sha });
  assert.equal(gate.status, 0, gate.out);
  assert.match(
    gate.out,
    /integration: PASS 2 tests in 1 JUnit reports, 2 of 2 test-glob files on exactly one shard, 1 known flake passed on retry \(#7\)/
  );
  await report(dir, { flaky });
  assert.equal(posted(state, 'POST', '/repos/o/r/issues').length, 0);
  const [note] = posted(state, 'POST', '/repos/o/r/issues/7/comments');
  assert.match(
    note.body.body,
    /- Run: https:\/\/github\.test\/o\/r\/actions\/runs\/42\/attempts\/1/
  );
  assert.match(note.body.body, /the first try fails/);
  assert.equal(posted(state, 'DELETE', '/repos/o/r/issues/7/labels/new').length, 1);
});

test("a strict row's flip stays red even when known, and its issue is terse with the guard label", async () => {
  const dir = fixture({ 'guard-flip': 'flip', steady: 'steady' });
  const state = github();
  const marker = id('test/integration/guard-flip.test.mjs', 'flips on its first try');
  const flaky = JSON.stringify({ known: { [marker]: { issue: 3, commit: null } }, changed: [] });
  const run = await shard(dir, { flaky });
  assert.equal(run.status, 1, run.out);
  assert.equal(record(dir).rows[0].kind, 'strict');
  assert.equal((await integration(dir, { flaky })).status, 1);
  await report(dir, { flaky });
  const [created] = posted(state, 'POST', '/repos/o/r/issues');
  assert.deepEqual(created.body.labels, ['flaky-test', 'new', 'guard']);
  assert.doesNotMatch(created.body.body, /the first try fails|~~~~/);
  assert.ok(created.body.body.includes(`Key: \`${marker}\``));
});

test('a flip of a test the PR changes stays red and files no issue', async () => {
  const dir = fixture({ steady: 'steady' });
  writeFileSync(join(dir, 'test/integration/flip.test.mjs'), FIXTURES.flip);
  commitAll(dir, 'the PR adds a racy test');
  const marker = id('test/integration/flip.test.mjs', 'flips on its first try');
  const state = github({
    issues: [{ number: 5, body: `Key: \`${marker}\``, labels: [{ name: 'flaky-test' }] }],
  });
  const { flaky, sha } = await lint(dir);
  assert.deepEqual(JSON.parse(flaky).changed, ['test/integration/flip.test.mjs']);
  const run = await shard(dir, { flaky, sha });
  assert.equal(run.status, 1, run.out);
  assert.match(run.out, /this PR's test is nondeterministic/);
  const { summary } = await report(dir, { flaky });
  assert.equal(posted(state, 'POST', '/repos/o/r/issues').length, 0);
  assert.equal(posted(state, 'POST', '/repos/o/r/issues/5/comments').length, 0);
  assert.match(summary, /not filed: the PR changes this test/);
});

test('a rerun that skips, cancels, runs no test, writes no JUnit or times out is red', async () => {
  const known = (file, name) => ({
    [id(`test/integration/${file}.test.mjs`, name)]: { issue: 1, commit: null },
  });
  const cases = [
    ['skips', 'skips on retry', {}, 'failure'],
    ['cancels', 'cancels on retry', {}, 'failure'],
    ['empty', 'registers nothing on retry', {}, 'the rerun ran no test'],
    [
      'flip',
      'flips on its first try',
      {
        test: `if [ "\${SLICC_TEST_RETRY:-}" = 1 ]; then exit 0; fi; node --test test/integration/*.test.mjs`,
      },
      'the rerun wrote no JUnit report',
    ],
    ['slow', 'hangs on retry', { minutes: 0.1 }, 'the rerun timed out'],
  ];
  for (const [file, name, options, why] of cases) {
    const dir = fixture({ [file]: file });
    const flaky = JSON.stringify({ known: known(file, name), changed: [] });
    const run = await shard(dir, { flaky, ...options });
    assert.equal(run.status, 1, `${file}: ${run.out}`);
    assert.ok(existsSync(join(dir, 'junit/0.flaky.json')), `${file}: ${run.out}`);
    assert.ok(run.out.includes(why) || record(dir).rows[0].kind === why, `${file}: ${run.out}`);
    assert.equal(record(dir).rows[0].excused, false, file);
    assert.equal((await integration(dir, { flaky })).status, 1, file);
  }
});

test('more failing files than flaky-retry are not rerun', async () => {
  const dir = fixture({ flip: 'flip', skips: 'skips' });
  const run = await shard(dir, { retry: 1 });
  assert.equal(run.status, 1, run.out);
  assert.match(run.out, /not rerun: 2 files failed, more than flaky-retry \(1\)/);
  assert.ok(!existsSync(join(dir, 'junit/0.retry.xml')));
  assert.equal(record(dir).rerun, null);
});

test('flaky-retry defaults to 0, which runs the tests once as before', async () => {
  assert.match(text, /\n {6}flaky-retry:\n {8}type: number\n {8}default: 0\n/);
  const dir = fixture({ flip: 'flip', steady: 'steady' });
  const run = await shard(dir, { retry: 0 });
  assert.equal(run.status, 1, run.out);
  assert.equal(run.out.match(/ℹ tests \d+/g).length, 1, run.out);
  assert.doesNotMatch(run.out, /flaky: /);
  assert.ok(!existsSync(join(dir, 'junit/0.flaky.json')));
  assert.ok(!existsSync(join(dir, 'junit/0.retry.xml')));
  assert.ok(!existsSync(join(dir, 'tmp/slicc-flaky')));
});

test("when lint can't read the issues, every flip stays red", async () => {
  const dir = fixture({ flip: 'flip', steady: 'steady' });
  github({ refuse: true });
  const { flaky, log, sha } = await lint(dir);
  assert.equal(flaky, '');
  assert.match(
    log,
    /::warning title=Flaky::no known flakes \(the open flaky-test issues: 403\), so every flip stays red/
  );
  const run = await shard(dir, { flaky, sha });
  assert.equal(run.status, 1, run.out);
  assert.equal(record(dir).rows[0].kind, 'new');
  assert.equal((await integration(dir, { flaky, sha })).status, 1);
});
