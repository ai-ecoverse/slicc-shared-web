import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { api, git, globs, matchesAny, output, sha, summary } from './lib.mjs';

const env = process.env;
const repo = env.GITHUB_REPOSITORY;
const gh = api(repo);
const origin = env.GITHUB_API_URL ?? 'https://api.github.com';
const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
const pull = event.pull_request;
const n = pull.number;
const head = sha(pull.head.sha);
const base = sha(pull.base.sha);
const file = env.CERT_EVIDENCE_WORKFLOW ?? '';
const names = globs(env.CERT_EVIDENCE_ARTIFACTS ?? '');
const waitMs = Math.min(Number(env.CERT_EVIDENCE_WAIT ?? 120), 200) * 60000;
const pollMs = Number(env.CERT_EVIDENCE_POLL_SECONDS ?? 30) * 1000;
const budget = Number(env.CERT_EVIDENCE_MAX_MB ?? 200) * 1024 * 1024;
const out = env.CERT_EVIDENCE_DIR;

function stop(reason) {
  console.log(`cert-review evidence: INCOMPLETE ${reason}`);
  output({ reason: reason.slice(0, 300) });
  summary(`cert-review evidence: INCOMPLETE ${reason}`);
  process.exit(1);
}

if (!out) stop('CERT_EVIDENCE_DIR is not set');
if (!/^[\w.-]+\.ya?ml$/.test(file))
  stop(`evidence-workflow ${JSON.stringify(file)} is not a workflow file name`);
if (!names.length) stop('evidence-artifacts names no artifact');
const path = `.github/workflows/${file}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runs(query) {
  const data = await gh.call(`actions/workflows/${file}/runs?${query}&per_page=50`);
  return (data.workflow_runs ?? [])
    .filter((r) => r.path === path && r.head_repository?.full_name === repo)
    .sort((a, b) => b.id - a.id);
}

async function headRun() {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const found = (await runs(`event=pull_request&head_sha=${head}`)).filter(
      (r) =>
        r.event === 'pull_request' &&
        r.head_sha === head &&
        (!r.pull_requests?.length || r.pull_requests.some((p) => p.number === n))
    );
    const newest = found[0];
    if (newest?.status === 'completed') return newest;
    if (Date.now() >= deadline)
      stop(
        newest
          ? `${file} run ${newest.id} on the head ${head.slice(0, 12)} is still ${newest.status} after ${waitMs / 60000} minutes`
          : `no ${file} pull_request run on the head ${head.slice(0, 12)} after ${waitMs / 60000} minutes`
      );
    console.log(
      `${file} on ${head.slice(0, 12)}: ${newest ? `run ${newest.id} ${newest.status}` : 'not started'}`
    );
    await sleep(pollMs);
  }
}

function behind(commit) {
  if (commit === base) return true;
  try {
    git('merge-base', '--is-ancestor', sha(commit), base);
    return true;
  } catch {
    return false;
  }
}

async function baseRun() {
  const ref = encodeURIComponent(pull.base.ref);
  return (await runs(`event=push&branch=${ref}&status=completed`)).find(
    (r) =>
      r.event === 'push' &&
      r.status === 'completed' &&
      ['success', 'failure'].includes(r.conclusion) &&
      behind(r.head_sha)
  );
}

async function artifactsOf(run) {
  const all = [];
  for (let page = 1; page <= 10; page++) {
    const data = await gh.call(`actions/runs/${run.id}/artifacts?per_page=100&page=${page}`);
    all.push(...(data.artifacts ?? []));
    if ((data.artifacts ?? []).length < 100) break;
  }
  return all.filter((a) => matchesAny(a.name, names)).sort((a, b) => a.name.localeCompare(b.name));
}

function unlinkLinks(dir) {
  let files = 0;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = lstatSync(p);
    if (s.isDirectory()) files += unlinkLinks(p);
    else if (s.isFile()) files++;
    else rmSync(p, { force: true });
  }
  return files;
}

let used = 0;
async function fetchSide(side, run, required) {
  const dir = join(out, side);
  mkdirSync(dir, { recursive: true });
  const record = {
    run: run.id,
    attempt: run.run_attempt,
    url: run.html_url,
    sha: run.head_sha,
    event: run.event,
    conclusion: run.conclusion,
    artifacts: [],
    skipped: [],
  };
  for (const a of await artifactsOf(run)) {
    if (a.expired) {
      record.skipped.push({ name: a.name, why: 'expired' });
      continue;
    }
    if (used + a.size_in_bytes > budget) {
      record.skipped.push({ name: a.name, why: `over the ${budget / 1048576} MB evidence budget` });
      continue;
    }
    const digest = String(a.digest ?? '').replace(/^sha256:/, '');
    if (!/^[0-9a-f]{64}$/.test(digest))
      stop(`${side} artifact ${a.name} (${a.id}) has no sha256 digest`);
    const r = await fetch(`${origin}/repos/${repo}/actions/artifacts/${a.id}/zip`, {
      headers: { authorization: `Bearer ${env.GH_TOKEN}`, 'x-github-api-version': '2022-11-28' },
      signal: AbortSignal.timeout(600000),
    });
    if (!r.ok) stop(`${side} artifact ${a.name} (${a.id}): download HTTP ${r.status}`);
    const bytes = Buffer.from(await r.arrayBuffer());
    const got = createHash('sha256').update(bytes).digest('hex');
    if (got !== digest)
      stop(`${side} artifact ${a.name} (${a.id}): digest ${got} is not ${digest}`);
    used += bytes.length;
    const zip = join(out, `.${side}-${a.id}.zip`);
    writeFileSync(zip, bytes);
    const listed = execFileSync('unzip', ['-Zt', zip], { encoding: 'utf8' });
    const size = Number(/([\d]+) bytes uncompressed/.exec(listed)?.[1] ?? Number.POSITIVE_INFINITY);
    if (size > budget * 4)
      stop(`${side} artifact ${a.name} unpacks to ${size} bytes, over the budget`);
    const dest = join(dir, a.name.replace(/[^\w.-]/g, '_'));
    mkdirSync(dest, { recursive: true });
    execFileSync('unzip', ['-qq', '-o', zip, '-d', dest], { timeout: 600000 });
    rmSync(zip, { force: true });
    const files = unlinkLinks(dest);
    record.artifacts.push({
      name: a.name,
      id: a.id,
      digest: `sha256:${digest}`,
      bytes: bytes.length,
      files,
    });
  }
  if (required && !record.artifacts.length)
    stop(`${file} run ${run.id} on the head has none of the artifacts ${names.join(', ')}`);
  return record;
}

mkdirSync(out, { recursive: true });
const h = await headRun();
const b = await baseRun();
const manifest = {
  schema: 'cert-review-evidence/v1',
  pr: n,
  workflow: path,
  head: await fetchSide('head', h, true),
  base: b
    ? await fetchSide('base', b, false)
    : { none: `no finished push run of ${file} on ${pull.base.ref} at or behind the base` },
};
writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
const line = `cert-review evidence: PASS head run ${h.id} (${h.conclusion}, ${manifest.head.artifacts.length} artifacts), base ${b ? `run ${b.id} at ${b.head_sha.slice(0, 12)} (${b.conclusion}, ${manifest.base.artifacts.length} artifacts)` : 'none'}`;
console.log(line);
summary(line);
output({ reason: '' });
