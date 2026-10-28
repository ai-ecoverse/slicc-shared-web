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

const surrogate = /[\ud800-\udfff]/;
const sha = '0123456789abcdef0123456789abcdef01234567';
const runUrl = 'https://github.test/o/r/actions/runs/1';

let calls;
let server;
before(async () => {
  server = createServer((req, res) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => {
      const path = new URL(req.url, 'http://x').pathname;
      const body = data ? JSON.parse(data) : undefined;
      calls.push({ method: req.method, path, body });
      const send = (status, answer) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(answer));
      };
      if (req.method === 'GET' && /\/(issues|pulls)\/7\/comments$/.test(path)) return send(200, []);
      if (req.method === 'POST' && path === `/repos/o/r/statuses/${sha}`) {
        if (surrogate.test(body.description))
          return send(422, {
            message: "Validation failed: Description doesn't accept 4-byte Unicode",
          });
        return send(201, {});
      }
      if (req.method === 'POST' && path === '/repos/o/r/issues/7/comments')
        return send(201, { id: calls.length });
      send(404, { message: 'Not Found' });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
});
after(() => server.close());

async function post(findings) {
  calls = [];
  const dir = mkdtempSync(join(tmpdir(), 'slicc-status-'));
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
        ISSUES_TOKEN: '',
        R2_BASE: '',
        PR: '7',
        SHA: sha,
        RUN_URL: runUrl,
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

const review = (summary) => ({ verdict: 'approved', summary, comments: [], issues: [] });

test('post drops 4-byte characters from the status description and keeps them in the sticky comment', async () => {
  const edge = `${'a'.repeat(139)}🎉 done ![home](shots/home.png)`;
  const shot = '![home](shots/home.png) looks right 🚀';
  const run = await post({ claude: review(edge), codex: review(shot) });
  assert.equal(run.status, 0, run.log);

  const statuses = calls.filter((call) => call.path === `/repos/o/r/statuses/${sha}`);
  assert.deepEqual(
    statuses.map(({ body }) => [body.context, body.state]),
    [
      ['review / claude', 'success'],
      ['review / codex', 'success'],
    ]
  );
  for (const { body } of statuses) {
    assert.ok(!surrogate.test(body.description), JSON.stringify(body.description));
    assert.ok(Array.from(body.description).length <= 140, body.description);
  }
  assert.equal(statuses[0].body.description, `${'a'.repeat(139)} `);
  assert.equal(
    statuses[1].body.description,
    ` _home_ ([\`home.png\` in findings-codex](${runUrl})) looks right `
  );

  const sticky = calls
    .filter((call) => call.method === 'POST' && call.path === '/repos/o/r/issues/7/comments')
    .map((call) => call.body.body);
  assert.deepEqual(sticky, [
    `<!-- slicc-review:claude -->\n**claude: approved** on 0123456\n\n${'a'.repeat(139)}🎉 done 📷 _home_ ([\`home.png\` in findings-claude](${runUrl}))`,
    `<!-- slicc-review:codex -->\n**codex: approved** on 0123456\n\n📷 _home_ ([\`home.png\` in findings-codex](${runUrl})) looks right 🚀`,
  ]);
});
