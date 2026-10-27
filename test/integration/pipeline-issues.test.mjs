import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

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
  const at = lines.findIndex((line) => /^ {8}run: \|$/.test(line));
  const body = [];
  for (const line of lines.slice(at + 1)) {
    if (line.trim() && !line.startsWith('          ')) break;
    body.push(line.slice(10));
  }
  return body.join('\n');
}

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
        token: req.headers.authorization,
        raw: data,
        body: data ? JSON.parse(data) : undefined,
      };
      api.calls.push(call);
      const [status, answer] = api.answer(call);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answer));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
});
after(() => server.close());

function github({ open = {}, writable = {} } = {}) {
  const state = { calls: [], created: [] };
  state.answer = ({ method, path, query, token, body }) => {
    const repo = /^\/repos\/([^/]+\/[^/]+)\/issues$/.exec(path)?.[1];
    if (method === 'GET' && /\/(issues|pulls)\/7\/comments$/.test(path)) return [200, []];
    if (method === 'GET' && repo) {
      assert.equal(new URLSearchParams(query).get('state'), 'open');
      return [200, open[repo] ?? []];
    }
    if (method === 'POST' && repo) {
      if (token !== `Bearer ${writable[repo] ?? 'job-token'}`) return [403, { message: 'refused' }];
      state.created.push({ repo, token, ...body });
      return [201, { html_url: `https://github.test/${repo}/issues/${state.created.length}` }];
    }
    if (method === 'POST' && path.startsWith('/repos/o/r/statuses/')) return [201, {}];
    if (method === 'POST' && /^\/repos\/o\/r\/(issues|pulls)\/7\/comments$/.test(path))
      return [201, { id: state.calls.length }];
    return [404, { message: 'Not Found' }];
  };
  api = state;
  return state;
}

async function post(findings, { issuesToken = '' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'slicc-post-'));
  dirs.push(dir);
  for (const [agent, found] of Object.entries(findings)) {
    mkdirSync(join(dir, `findings/findings-${agent}`), { recursive: true });
    writeFileSync(join(dir, `findings/findings-${agent}/findings.json`), JSON.stringify(found));
  }
  const script = step('post', 'for (const issue of findings.issues)');
  return new Promise((resolve) => {
    const child = spawn('bash', ['-eo', 'pipefail', '-c', script], {
      cwd: dir,
      timeout: 60000,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`,
        GITHUB_REPOSITORY: 'o/r',
        GH_TOKEN: 'job-token',
        ISSUES_TOKEN: issuesToken,
        R2_BASE: '',
        PR: '7',
        SHA: '0123456789abcdef0123456789abcdef01234567',
        RUN_URL: 'https://github.test/o/r/actions/runs/1',
      },
    });
    let log = '';
    child.stdout.on('data', (chunk) => {
      log += chunk;
    });
    child.stderr.on('data', (chunk) => {
      log += chunk;
    });
    child.on('close', (status) => resolve({ status, log }));
  });
}

const review = (issues) => ({ verdict: 'approved', summary: 'fine', comments: [], issues });

const secret = (n, repo) => ({
  repo,
  title: `hidden title ${n}`,
  body: `hidden body ${n}`,
  security: true,
});

function leaks(github, log, issues) {
  for (const { title, body } of issues) {
    for (const call of github.calls) {
      assert.ok(!call.raw.includes(title) && !call.raw.includes(body), JSON.stringify(call));
    }
    assert.ok(!log.includes(title) && !log.includes(body), log);
  }
}

test('post never files, posts or logs an issue whose security is true, in this repo, the org or outside it', async () => {
  const fake = github();
  const claude = [secret(1, 'o/r'), secret(2, 'o/other'), secret(3, 'elsewhere/x')];
  const codex = [secret(4, '')];
  const run = await post({ claude: review(claude), codex: review(codex) });
  assert.equal(run.status, 0, run.log);
  assert.deepEqual(fake.created, []);
  leaks(fake, run.log, [...claude, ...codex]);
  const kept = run.log.split('\n').filter((line) => line.startsWith('kept '));
  assert.deepEqual(kept, [
    ...Array(3).fill('kept a security finding out of the issue tracker (claude)'),
    'kept a security finding out of the issue tracker (codex)',
  ]);
});

test('post files an issue whose security is false as before, with the same dedupe and tokens, beside a security finding it keeps', async () => {
  const fake = github({
    open: { 'o/r': [{ title: 'Already Here ', html_url: 'https://github.test/o/r/issues/1' }] },
    writable: { 'o/other': 'issues-token' },
  });
  const run = await post(
    {
      claude: review([
        { repo: 'o/r', title: 'plain', body: 'a plain issue', security: false },
        secret(5, 'o/r'),
        { repo: 'o/r', title: 'already here', body: 'a duplicate', security: false },
        { repo: '', title: 'no repo', body: 'this repo', security: false },
      ]),
      codex: review([
        { repo: 'o/other', title: 'elsewhere', body: 'in the org', security: false },
        secret(6, 'o/other'),
      ]),
    },
    { issuesToken: 'issues-token' }
  );
  assert.equal(run.status, 0, run.log);
  assert.deepEqual(fake.created, [
    {
      repo: 'o/r',
      token: 'Bearer job-token',
      title: 'plain',
      body: "a plain issue\n\nFrom claude's review of o/r#7.",
    },
    {
      repo: 'o/r',
      token: 'Bearer job-token',
      title: 'no repo',
      body: "this repo\n\nFrom claude's review of o/r#7.",
    },
    {
      repo: 'o/other',
      token: 'Bearer issues-token',
      title: 'elsewhere',
      body: "in the org\n\nFrom codex's review of o/r#7.",
    },
  ]);
  assert.match(run.log, /already open: https:\/\/github\.test\/o\/r\/issues\/1\n/);
  leaks(fake, run.log, [secret(5), secret(6)]);
});

test('post still turns a refused cross-repo issue whose security is false into a pull request comment', async () => {
  const fake = github({ writable: { 'o/other': 'issues-token' } });
  const run = await post({
    claude: review([
      { repo: 'o/other', title: 'refused', body: 'no token', security: false },
      secret(7, 'o/other'),
    ]),
  });
  assert.equal(run.status, 0, run.log);
  assert.deepEqual(fake.created, []);
  const notes = fake.calls.filter(
    (call) => call.method === 'POST' && call.path === '/repos/o/r/issues/7/comments'
  );
  assert.deepEqual(
    notes.map((call) => call.body.body).filter((body) => !body.startsWith('<!-- slicc-review:')),
    [
      "**claude** wanted to open an issue in o/other but couldn't (no SLICC_ISSUES_TOKEN):\n\n### refused\n\nno token",
    ]
  );
  leaks(fake, run.log, [secret(7)]);
});

test('post files nothing for an issue without a boolean security, as older or malformed output has', async () => {
  const fake = github({ writable: { 'o/other': 'issues-token' } });
  const odd = [
    { repo: 'o/r', title: 'hidden title 8', body: 'hidden body 8' },
    { repo: 'o/r', title: 'hidden title 9', body: 'hidden body 9', security: 'false' },
    { repo: 'o/other', title: 'hidden title 10', body: 'hidden body 10', security: null },
    { repo: 'o/r', title: 'hidden title 11', body: 'hidden body 11', security: 0 },
  ];
  const run = await post({ claude: review(odd) });
  assert.equal(run.status, 0, run.log);
  assert.deepEqual(fake.created, []);
  leaks(fake, run.log, odd);
  const kept = run.log.split('\n').filter((line) => line.startsWith('kept '));
  assert.deepEqual(
    kept,
    Array(4).fill(
      'kept an issue without a boolean security field out of the issue tracker (claude)'
    )
  );
});

test('the findings schema requires a boolean security on each issue', () => {
  const schema = JSON.parse(/\n {2}FINDINGS_SCHEMA: >-\n {4}(.+)\n/.exec(text)[1]);
  const issue = schema.properties.issues.items;
  assert.deepEqual(issue.properties.security, { type: 'boolean' });
  assert.ok(issue.required.includes('security'), issue.required);
  assert.deepEqual([...issue.required].sort(), Object.keys(issue.properties).sort());
  assert.equal(issue.additionalProperties, false);
});

test('the prompt asks for security on each issue and keeps security findings in the review', () => {
  const prompt = step('reviewer', 'name: Prompt');
  assert.match(prompt, /- issues: [^\n]*, a title, a body and security\.\n/);
  assert.match(
    prompt,
    /\n {2}security is true for anything about a security or secret exposure, a guard bypass, or protected data reaching where it shouldn't, and false for everything else\.\n/
  );
  assert.match(
    prompt,
    /\n {2}Put a security finding in the summary or a line comment of this review, never as an issue/
  );
});
