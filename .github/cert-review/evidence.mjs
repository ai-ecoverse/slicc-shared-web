import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  api,
  git,
  globs,
  injectionOf,
  matchesAny,
  ourRun,
  output,
  sha,
  shownPath,
  summary,
  UNSAFE_NAME,
} from './lib.mjs';

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
  const data = await gh.call(`actions/runs?${query}&per_page=100`);
  return (data.workflow_runs ?? [])
    .filter((r) => ourRun(r, repo, path) && r.head_repository?.full_name === repo)
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
  const newest = new Map();
  for (const a of all.filter((x) => matchesAny(x.name, names)))
    if (!newest.has(a.name) || newest.get(a.name).id < a.id) newest.set(a.name, a);
  return {
    picked: [...newest.values()].sort((a, b) => a.id - b.id),
    older: all.length - newest.size,
  };
}

const IMAGE = /\.(?:png|jpe?g|gif|webp)$/i;
const hits = [];
let hitCount = 0;
let unpacked = 0;

function tidy(dir, root, side, record) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const rel = p.slice(root.length + 1);
    const s = lstatSync(p);
    if (s.isDirectory()) {
      tidy(p, root, side, record);
      continue;
    }
    if (!s.isFile()) {
      rmSync(p, { force: true });
      record.dropped.push({ path: shownPath(rel), why: 'not a regular file' });
      continue;
    }
    unpacked += s.size;
    if (unpacked > budget * 4)
      stop(`the evidence unpacks to more than ${(budget * 4) / 1048576} MB`);
    const hit = (line, why) => {
      hitCount++;
      if (hits.length < 50) hits.push({ path: `${side}/${shownPath(rel)}`, line, why });
    };
    if (UNSAFE_NAME.test(rel) || injectionOf(rel).startsWith('fail')) hit(0, 'its name');
    if (IMAGE.test(name) && side !== 'head') {
      record.files++;
      continue;
    }
    if (IMAGE.test(name)) {
      rmSync(p, { force: true });
      record.dropped.push({
        path: shownPath(rel),
        why: 'an image the pull request made (no code can scan its text)',
      });
      continue;
    }
    const bytes = readFileSync(p);
    if (bytes.includes(0)) {
      rmSync(p, { force: true });
      record.dropped.push({ path: shownPath(rel), why: 'binary' });
      continue;
    }
    record.files++;
    if (side !== 'head') continue;
    bytes
      .toString('utf8')
      .split('\n')
      .forEach((l, i) => {
        const kind = injectionOf(l);
        if (kind.startsWith('fail'))
          hit(
            i + 1,
            kind === 'fail-control' ? 'a bidi or zero-width control' : 'text aimed at the certifier'
          );
      });
  }
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
    dropped: [],
    files: 0,
  };
  const { picked, older } = await artifactsOf(run);
  record.older = older;
  const attemptStart = Date.parse(run.run_started_at ?? '');
  for (const a of picked) {
    if (!Number.isFinite(attemptStart) || !(Date.parse(a.created_at ?? '') >= attemptStart)) {
      record.skipped.push({
        name: JSON.stringify(a.name),
        why: `not from attempt ${run.run_attempt}`,
      });
      continue;
    }
    if (!/^[\w.-]+$/.test(a.name) || /^\.+$/.test(a.name)) {
      record.skipped.push({ name: JSON.stringify(a.name), why: 'an unsafe name' });
      continue;
    }
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
    if (unpacked + size > budget * 4)
      stop(
        `${side} artifact ${a.name} would take the evidence over ${(budget * 4) / 1048576} MB unpacked`
      );
    const dest = join(dir, String(a.id));
    mkdirSync(dest, { recursive: true });
    execFileSync(
      'bash',
      [
        '-c',
        'ulimit -f "$1"; exec unzip -qq -o "$2" -d "$3"',
        'unzip',
        String(Math.ceil((budget * 4) / 512)),
        zip,
        dest,
      ],
      { timeout: 600000 }
    );
    rmSync(zip, { force: true });
    const before = record.files;
    tidy(dest, dir, side, record);
    record.artifacts.push({
      name: a.name,
      id: a.id,
      dir: `${side}/${a.id}`,
      digest: `sha256:${digest}`,
      bytes: bytes.length,
      files: record.files - before,
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
manifest.injections = { count: hitCount, first: hits };
writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
const line = `cert-review evidence: PASS head run ${h.id} (${h.conclusion}, ${manifest.head.artifacts.length} artifacts), base ${b ? `run ${b.id} at ${b.head_sha.slice(0, 12)} (${b.conclusion}, ${manifest.base.artifacts.length} artifacts)` : 'none'}`;
console.log(line);
summary(line);
output({ reason: '', hits: JSON.stringify({ count: hitCount, first: hits.slice(0, 20) }) });
