import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const action = fileURLToPath(
  new URL('../../.github/actions/cert-self-guard/guard.mjs', import.meta.url)
);
const repository = 'fixture/lane';
const headDate = '2026-10-16T12:00:00Z';
const afterHead = '2026-10-16T12:01:00Z';
const beforeHead = '2026-10-16T11:59:00Z';
const selfPass =
  'name: cert-review-pr\non: pull_request\njobs:\n  pass:\n    runs-on: ubuntu-latest\n    steps:\n      - run: exit 0\n';

function fixture(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'slicc-self-guard-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '--quiet', '--initial-branch=main');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  const write = (file, body) => {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), body);
  };
  const commit = (date = headDate) => {
    git('add', '.');
    execFileSync('git', ['commit', '--quiet', '-m', 'fixture change'], {
      cwd: dir,
      env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    });
    return git('rev-parse', 'HEAD');
  };
  write('README.md', 'base\n');
  write(
    '.github/workflows/cert-review-pr.yml',
    'uses: fixture/action@1111111111111111111111111111111111111111\n'
  );
  write('scripts/cert/check.mjs', 'process.exitCode = 1;\n');
  const base = commit('2026-10-16T11:00:00Z');
  return { dir, git, write, commit, base };
}

function pull(number, head, base) {
  return {
    number,
    state: 'open',
    head: { sha: head, repo: { full_name: repository } },
    base: { sha: base, ref: 'main', repo: { full_name: repository } },
    labels: [{ name: 'cert-review-approved' }],
  };
}

async function apiServer(t, pulls, options = {}) {
  const calls = [];
  const server = createServer((req, res) => {
    calls.push({ method: req.method, path: req.url });
    const route = new URL(req.url, 'http://fixture').pathname.replace(`/repos/${repository}/`, '');
    const send = (body, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json', connection: 'close' });
      res.end(JSON.stringify(body));
    };
    if (options.fail) return send({ error: 'unavailable' }, 503);
    const number = Number(route.split('/')[1]);
    if (/^pulls\/\d+$/.test(route)) return send(pulls[number]);
    if (/^issues\/\d+\/labels\//.test(route) && req.method === 'DELETE') {
      pulls[number].labels = [];
      return send(null, options.deleteStatus ?? 204);
    }
    if (/^issues\/\d+\/timeline$/.test(route))
      return send(
        options.timelines?.[number] ?? [
          {
            id: number * 10,
            event: 'labeled',
            label: { name: 'cert-review-approved' },
            actor: { login: 'coordinator' },
            created_at: options.date ?? afterHead,
          },
        ]
      );
    if (route === 'collaborators/coordinator/permission')
      return send({
        permission: options.permission ?? 'admin',
        role_name: options.role ?? options.permission ?? 'admin',
      });
    if (/^commits\/[a-f0-9]+\/pulls$/.test(route))
      return send(Object.values(pulls).filter((entry) => entry.head.sha === route.split('/')[1]));
    return send({ error: `unexpected ${route}` }, 404);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      })
  );
  return { origin: `http://127.0.0.1:${server.address().port}`, calls };
}

async function run(f, api, event, extra = {}) {
  const file = path.join(f.dir, 'event.json');
  const output = path.join(f.dir, 'output');
  writeFileSync(file, JSON.stringify({ repository: { full_name: repository }, ...event }));
  writeFileSync(output, '');
  const child = spawn(process.execPath, [action], {
    cwd: f.dir,
    env: {
      ...process.env,
      GH_TOKEN: '',
      GITHUB_API_URL: api.origin,
      GITHUB_EVENT_NAME: event.merge_group ? 'merge_group' : 'pull_request',
      GITHUB_EVENT_PATH: file,
      GITHUB_REPOSITORY: repository,
      GITHUB_OUTPUT: output,
      GITHUB_STEP_SUMMARY: path.join(f.dir, 'summary'),
      ...extra,
    },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const exit = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  const receipt = JSON.parse(stdout.trim());
  assert.ok(readFileSync(output, 'utf8').includes(`status=${receipt.status}`));
  return { exit, receipt, stderr };
}

for (const scenario of [
  {
    name: 'untouched documentation needs no approval',
    file: 'README.md',
    labels: false,
    pass: true,
  },
  { name: 'cert tool edit without approval is red', file: 'scripts/cert/check.mjs', labels: false },
  {
    name: 'workflow rewritten to self-pass is red',
    file: '.github/workflows/cert-review-pr.yml',
    body: selfPass,
    labels: false,
  },
  {
    name: 'guard uses pin change is guarded by defaults',
    file: '.github/workflows/cert-review-pr.yml',
    body: 'uses: fixture/action@2222222222222222222222222222222222222222\n',
    labels: false,
  },
  {
    name: 'admin approval after head clears self-passing workflow edit',
    file: '.github/workflows/cert-review-pr.yml',
    body: selfPass,
    pass: true,
  },
  {
    name: 'maintain role with write permission clears cert-path edit',
    file: 'scripts/cert/check.mjs',
    permission: 'write',
    role: 'maintain',
    pass: true,
  },
  { name: 'write permission cannot approve', file: 'scripts/cert/check.mjs', permission: 'write' },
  { name: 'read permission cannot approve', file: 'scripts/cert/check.mjs', permission: 'read' },
  { name: 'approval before head cannot approve', file: 'scripts/cert/check.mjs', date: beforeHead },
  { name: 'approval exactly at head is not newer', file: 'scripts/cert/check.mjs', date: headDate },
]) {
  test(`cert self-guard: ${scenario.name}`, async (t) => {
    const f = fixture(t);
    f.write(scenario.file, scenario.body ?? 'new contents\n');
    const head = f.commit();
    const pr = pull(1, head, f.base);
    if (scenario.labels === false) pr.labels = [];
    const api = await apiServer(t, { 1: pr }, scenario);
    const result = await run(f, api, { action: 'labeled', pull_request: pr });
    assert.equal(result.exit, scenario.pass ? 0 : 1, result.stderr);
    assert.equal(result.receipt.status, scenario.pass ? 'PASS' : 'FAIL');
    if (!scenario.pass) assert.match(result.stderr, /cert-review: needs coordinator review/);
    assert.equal(
      result.receipt.residual,
      'self-guard catches accidental cert-path edits; not enforced against a deliberate rewrite of the workflow'
    );
  });
}

test('cert self-guard includes both paths when a cert tool is renamed out of the guarded tree', async (t) => {
  const f = fixture(t);
  f.git('mv', 'scripts/cert/check.mjs', 'ordinary.mjs');
  const head = f.commit();
  const pr = pull(1, head, f.base);
  pr.labels = [];
  const api = await apiServer(t, { 1: pr });
  const result = await run(f, api, { pull_request: pr });
  assert.equal(result.receipt.status, 'FAIL');
  assert.deepEqual(result.receipt.members[0].paths.sort(), [
    'ordinary.mjs',
    'scripts/cert/check.mjs',
  ]);
});

test('cert self-guard approve then push removes approval and re-blocks, even if the old label is still present', async (t) => {
  const f = fixture(t);
  f.write('scripts/cert/check.mjs', 'first change\n');
  const head = f.commit();
  const pr = pull(1, head, f.base);
  const api = await apiServer(t, { 1: pr });
  assert.equal((await run(f, api, { action: 'labeled', pull_request: pr })).receipt.status, 'PASS');
  f.write('scripts/cert/check.mjs', 'later change\n');
  pr.head.sha = f.commit('2026-10-16T12:02:00Z');
  const result = await run(f, api, { action: 'synchronize', pull_request: pr });
  assert.equal(result.receipt.status, 'FAIL');
  assert.deepEqual(pr.labels, []);
  assert.ok(
    api.calls.some(
      (call) => call.method === 'DELETE' && call.path.endsWith('/labels/cert-review-approved')
    )
  );
});

test('cert self-guard removed approval and failed automatic removal cannot pass', async (t) => {
  const f = fixture(t);
  f.write('scripts/cert/check.mjs', 'change\n');
  const head = f.commit();
  const pr = pull(1, head, f.base);
  const removed = await apiServer(
    t,
    { 1: pr },
    { timelines: { 1: [{ id: 11, event: 'unlabeled', label: { name: 'cert-review-approved' } }] } }
  );
  assert.equal((await run(f, removed, { pull_request: pr })).receipt.status, 'FAIL');
  const denied = await apiServer(t, { 1: pr }, { deleteStatus: 403 });
  assert.equal(
    (await run(f, denied, { action: 'synchronize', pull_request: pr })).receipt.status,
    'INCOMPLETE'
  );
});

test('cert self-guard refuses unavailable API evidence and stale PR heads', async (t) => {
  const f = fixture(t);
  f.write('scripts/cert/check.mjs', 'change\n');
  const head = f.commit();
  const pr = pull(1, head, f.base);
  const api = await apiServer(t, { 1: pr }, { fail: true });
  assert.equal((await run(f, api, { pull_request: pr })).receipt.status, 'INCOMPLETE');
  const stale = await apiServer(t, { 1: { ...pr, head: { sha: f.base } } });
  assert.equal((await run(f, stale, { pull_request: pr })).receipt.status, 'INCOMPLETE');
});

test('cert self-guard merge group binds actual ancestry heads and fails one unapproved cert-path PR', async (t) => {
  const f = fixture(t);
  const members = [];
  for (const [number, file] of [
    [1, 'scripts/cert/check.mjs'],
    [2, '.github/workflows/cert-review-pr.yml'],
  ]) {
    f.git('checkout', '--quiet', '-b', `pr-${number}`, f.base);
    f.write(file, `change ${number}\n`);
    const head = f.commit();
    f.git('checkout', '--quiet', 'main');
    f.git('merge', '--quiet', '--no-ff', `pr-${number}`, '-m', `Merge pull request #${number}`);
    members.push(pull(number, head, f.base));
  }
  const head = f.git('rev-parse', 'HEAD');
  members[1].labels = [];
  const api = await apiServer(t, { 1: members[0], 2: members[1] });
  const event = { merge_group: { base_sha: f.base, head_sha: head } };
  const result = await run(f, api, event);
  assert.equal(result.receipt.status, 'FAIL');
  assert.deepEqual(
    result.receipt.members.map((member) => [member.pr, member.head, member.status]),
    [
      [1, members[0].head.sha, 'PASS'],
      [2, members[1].head.sha, 'FAIL'],
    ]
  );
  members[1].labels = [{ name: 'cert-review-approved' }];
  assert.equal((await run(f, api, event)).receipt.status, 'PASS');
  members[1].head.sha = f.base;
  assert.equal((await run(f, api, event)).receipt.status, 'INCOMPLETE');
});

test('cert self-guard merge group refuses non-merge unexplained commits', async (t) => {
  const f = fixture(t);
  f.write('README.md', 'ordinary commit\n');
  const head = f.commit();
  const api = await apiServer(t, {});
  const result = await run(f, api, { merge_group: { base_sha: f.base, head_sha: head } });
  assert.equal(result.receipt.status, 'INCOMPLETE');
  assert.match(result.receipt.reason, /unexplained merge group commit/);
});
