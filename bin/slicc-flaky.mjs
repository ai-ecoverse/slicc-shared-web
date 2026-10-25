#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  cpSync,
  existsSync,
  globSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, matchesGlob, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

export const LABEL = 'flaky-test';
const LABELS = [
  [LABEL, 'fbca04', 'A test that failed, then passed on a retry'],
  ['new', 'c2e0c6', 'A flaky test seen on one commit so far'],
  ['guard', 'b60205', 'A strict (guard or security) test that flipped'],
];
const CAP = 5;
const ERROR = 3000;
const DAY = 86400000;
const NONE = /\/slicc-shared-web\/unit\/none\.mjs$/;
const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const TAG = /<(\/?)(testsuite|testcase|failure|error|skipped)\b((?:[^>"]|"[^"]*")*)>/g;
const SECRET_SHAPES = [
  /gh[pousr]_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  /ABSK[A-Za-z0-9+/=]{16,}/,
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  /-----BEGIN [A-Z0-9 ]*-----/,
];

export function key({ file, name }) {
  return createHash('sha256').update(`${file}\u0000${name}`).digest('hex').slice(0, 16);
}

export function title({ file, name }) {
  const text = `flaky: ${basename(file)} › ${name}`;
  return text.length > 240 ? `${text.slice(0, 239)}…` : text;
}

function fence(log) {
  const text = (log || 'no error message').slice(0, ERROR);
  return `~~~~\n${text.replaceAll('~~~~', '~ ~ ~ ~')}\n~~~~`;
}

export function carriesSecret(text, secrets = []) {
  const raw = String(text);
  const lower = raw.toLowerCase();
  for (const value of secrets.filter(
    (secret) => typeof secret === 'string' && secret.length >= 8
  )) {
    const bytes = Buffer.from(value);
    const forms = [
      value,
      JSON.stringify(value).slice(1, -1),
      bytes.toString('base64'),
      bytes.toString('base64').replace(/=+$/, ''),
      bytes.toString('base64url'),
      bytes.toString('hex'),
      encodeURIComponent(value),
      value.split('').reverse().join(''),
    ];
    if (forms.some((form) => raw.includes(form) || lower.includes(form.toLowerCase()))) {
      return 'a secret value this run holds';
    }
  }
  const shape = SECRET_SHAPES.find((pattern) => pattern.test(raw));
  return shape ? `a token-shaped string (${shape.source.slice(0, 16)}…)` : '';
}

export function decode(text) {
  return text.replace(/&(?:#x([0-9a-f]+)|#(\d+)|([a-z]+));/gi, (all, hex, dec, named) => {
    if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
    if (dec) return String.fromCodePoint(Number(dec));
    return ENTITIES[named] ?? all;
  });
}

function attribute(attrs, name) {
  const found = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attrs);
  return found ? decode(found[1]) : undefined;
}

export function local(file, root) {
  if (!root || !isAbsolute(file)) return file;
  return relative(root, file).split(sep).join('/');
}

export function statusOf(test) {
  const all = [...test.leaves.values()];
  if (all.includes('fail')) return 'fail';
  return all.includes('pass') ? 'pass' : 'skip';
}

function settle(tests, leaf, root) {
  if (NONE.test(leaf.file)) return;
  const status = leaf.skipped ? 'skip' : leaf.failed ? 'fail' : 'pass';
  const [name] = leaf.path;
  const file = local(leaf.top, root);
  const id = `${file}\u0000${name}`;
  const test = tests.get(id) ?? { file, name, leaves: new Map(), error: '', failed: 0 };
  const path = leaf.path.join(' › ');
  if (test.leaves.get(path) !== 'fail') test.leaves.set(path, status);
  if (status === 'fail') {
    test.failed += 1;
    test.error ||= leaf.error.slice(0, ERROR);
  }
  tests.set(id, test);
}

function suite(state, { close, attrs, single }) {
  if (close) state.stack.pop();
  else if (!single) {
    if (state.stack.length === 0) state.top = undefined;
    state.stack.push(attribute(attrs, 'name') ?? '');
  }
}

function testcase(state, { close, attrs, single }) {
  if (!close) {
    const file = attribute(attrs, 'file') ?? '';
    if (state.stack.length === 0 || state.top === undefined) state.top = file;
    state.leaf = {
      path: [...state.stack, attribute(attrs, 'name') ?? ''],
      file,
      top: state.top,
      error: '',
    };
  }
  if (close || single) {
    if (state.leaf) settle(state.tests, state.leaf, state.root);
    state.leaf = undefined;
  }
}

export function parse(xml, root, tests = new Map()) {
  const state = { stack: [], leaf: undefined, text: undefined, top: undefined, tests, root };
  for (const match of xml.matchAll(TAG)) {
    const [whole, close, tag, rest] = match;
    const single = rest.endsWith('/');
    const part = {
      whole,
      close,
      tag,
      attrs: single ? rest.slice(0, -1) : rest,
      single,
      at: match.index,
    };
    if (tag === 'testsuite') suite(state, part);
    else if (tag === 'testcase') testcase(state, part);
    else if (state.leaf) inside(state, xml, part);
  }
  return tests;
}

function inside(state, xml, { whole, close, tag, attrs, single, at }) {
  if (tag === 'skipped') {
    if (!close) state.leaf.skipped = true;
    return;
  }
  if (!close) {
    state.leaf.failed = true;
    const message = attribute(attrs, 'message') ?? '';
    if (single) state.leaf.error ||= message;
    else state.text = { from: at + whole.length, message };
    return;
  }
  if (state.text) {
    state.leaf.error ||= decode(xml.slice(state.text.from, at)).trim() || state.text.message;
    state.text = undefined;
  }
}

export function load(files, root) {
  const tests = new Map();
  for (const file of files) parse(readFileSync(file, 'utf8'), root, tests);
  return tests;
}

export function firstReports(dir, shard) {
  const own = new RegExp(`^${shard.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(-\\d+)?\\.xml$`);
  return (existsSync(dir) ? readdirSync(dir) : [])
    .filter((name) => own.test(name))
    .sort()
    .map((name) => join(dir, name));
}

export function globs(text) {
  return (text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

export function lint(text) {
  try {
    const parsed = JSON.parse(text || 'null');
    return { known: parsed?.known ?? {}, changed: parsed?.changed ?? [] };
  } catch {
    return { known: {}, changed: [] };
  }
}

export function isKnown(entry, sha) {
  return (
    Boolean(entry) && (entry.commit === null || (Boolean(entry.commit) && entry.commit !== sha))
  );
}

export function listed(text) {
  try {
    const parsed = JSON.parse(text || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function category(test, { known, strict, changed, sha, tests }) {
  if (!tests.includes(test.file)) return 'unattributed';
  if (strict.some((glob) => matchesGlob(test.file, glob))) return 'strict';
  if (changed.includes(test.file)) return 'changed';
  return isKnown(known[key(test)], sha) ? 'known' : 'new';
}

export function problem(rerun, retry) {
  if (!rerun) return 'not rerun';
  if (rerun.timedOut) return 'the rerun timed out';
  if (!retry) return 'the rerun wrote no JUnit report';
  const ran = [...retry.values()].some(
    (test) => statusOf(test) === 'fail' || (statusOf(test) === 'pass' && test.name !== test.file)
  );
  return ran ? '' : 'the rerun ran no test';
}

function recovered(before, after) {
  if (!after || statusOf(after) === 'fail') return false;
  return [...before.leaves].every(
    ([path, status]) => status !== 'fail' || after.leaves.get(path) === 'pass'
  );
}

function row(before, after, broken, rules) {
  const test = before ?? after;
  const base = {
    file: test.file,
    name: test.name,
    key: key(test),
    first: before ? statusOf(before) : 'missing',
    retry: after ? statusOf(after) : 'missing',
    error: (before?.error || after?.error || '').slice(0, ERROR),
    back: false,
    excused: false,
  };
  if (base.first === 'fail') {
    if (broken || !recovered(before, after)) return { ...base, kind: 'failure' };
    const kind = category(test, rules);
    return { ...base, kind, excused: kind === 'known', issue: rules.known[base.key]?.issue };
  }
  if (base.retry !== 'fail') return { ...base, kind: 'pass' };
  if (base.first !== 'pass') return { ...base, kind: 'failure' };
  return { ...base, kind: category(test, rules), back: true };
}

export function judge({ first, retry, rerun, ...rules }) {
  const broken = problem(rerun, retry);
  const files = new Set(rerun?.files ?? []);
  const ids = new Set([...first.keys(), ...(retry?.keys() ?? [])]);
  const rows = [];
  for (const id of ids) {
    const before = first.get(id);
    const failedFirst = before && statusOf(before) === 'fail';
    const after = failedFirst || !broken ? retry?.get(id) : undefined;
    const test = before ?? after;
    if (!test || (!failedFirst && !files.has(test.file))) continue;
    rows.push(row(before, after, broken, rules));
  }
  const failing = rows.filter((entry) => entry.first === 'fail');
  const ok =
    !broken && failing.length > 0 && rows.every((entry) => entry.kind === 'pass' || entry.excused);
  return { rows, ok, broken };
}

function describe(entry, reason) {
  if (entry.kind === 'failure') return reason ? `failed, not rerun: ${reason}` : 'failed twice';
  if (entry.manual) {
    const note =
      { strict: ' (a strict row)', changed: ' (the PR changes this test)' }[entry.kind] ?? '';
    return `failed on attempt ${entry.from}, then passed on attempt ${entry.attempt}${note}`;
  }
  if (entry.back) return 'passed, then failed on retry';
  if (entry.kind === 'known')
    return `known flake${entry.issue ? ` #${entry.issue}` : ''}, passed on retry`;
  if (entry.kind === 'strict')
    return 'strict row flipped: failed, then passed on retry, so it stays red';
  if (entry.kind === 'changed')
    return "this PR's test is nondeterministic: it flipped, and the PR changes its file";
  return 'first flip: failed, then passed on retry, so it stays red until it flips on another commit too';
}

function bounded(command, env, ms) {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-eo', 'pipefail', '-c', command], {
      env,
      stdio: 'inherit',
      detached: true,
    });
    const kill = (signal) => {
      try {
        process.kill(-child.pid, signal);
      } catch {}
    };
    let late = false;
    const timer = setTimeout(() => {
      late = true;
      kill('SIGKILL');
    }, ms);
    child.on('close', (status) => {
      clearTimeout(timer);
      kill('SIGKILL');
      resolve({ status: status ?? 1, late });
    });
  });
}

function move(from, to) {
  if (!existsSync(from)) return;
  cpSync(from, to, { recursive: true });
  rmSync(from, { recursive: true, force: true });
}

async function rerunFiles(files, ms, env, shard) {
  const scratch = join(env.RUNNER_TEMP, 'slicc-flaky', 'retry');
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(scratch, { recursive: true });
  const junit = join(scratch, `${shard}.xml`);
  const options = (env.NODE_OPTIONS ?? '').replace(
    `--test-reporter-destination=${env.SLICC_TEST_JUNIT}`,
    `--test-reporter-destination=${junit}`
  );
  const stash = join(scratch, 'first');
  move('artifacts', join(stash, 'artifacts'));
  move('coverage', join(stash, 'coverage'));
  const started = Date.now();
  const { status, late } = await bounded(
    env.TEST,
    {
      ...env,
      NODE_OPTIONS: options,
      SLICC_TEST_FILES: files.join('\n'),
      SLICC_TEST_SHARD: 'retry',
      SLICC_TEST_JUNIT: junit,
      SLICC_TEST_RETRY: '1',
    },
    ms
  );
  const took = Date.now() - started;
  move('artifacts', join(stash, 'artifacts', 'retry'));
  rmSync('coverage', { recursive: true, force: true });
  move(join(stash, 'artifacts'), 'artifacts');
  move(join(stash, 'coverage'), 'coverage');
  const reports = readdirSync(scratch).filter((name) => name.endsWith('.xml'));
  const inner = reports.map((name) =>
    readFileSync(join(scratch, name), 'utf8')
      .replace(/<\?xml[^>]*\?>/, '')
      .replace(/<\/?testsuites>/g, '')
      .trim()
  );
  if (reports.length > 0) {
    writeFileSync(
      join('junit', `${shard}.retry.xml`),
      `<?xml version="1.0" encoding="utf-8"?>\n<testsuites>\n${inner.join('\n')}\n</testsuites>\n`
    );
  }
  return { files, ms: took, exit: status, timedOut: late };
}

function context(env) {
  return {
    shard: env.SHARD,
    attempt: Number(env.GITHUB_RUN_ATTEMPT || 1),
    sha: env.SHA || env.GITHUB_SHA || '',
    runner: env.RUNNER_NAME || '',
    root: process.cwd(),
  };
}

function rules(env, tests) {
  const { known, changed } = lint(env.FLAKY);
  return {
    known,
    changed,
    strict: globs(env.STRICT),
    sha: env.SHA || env.GITHUB_SHA || '',
    tests,
  };
}

function regular(file, root) {
  try {
    return statSync(join(root, file)).isFile();
  } catch {
    return false;
  }
}

function skipReason({
  reports,
  failing,
  files,
  tests,
  root,
  most,
  elapsed,
  limit,
  budget,
  options,
}) {
  if (reports.length === 0) return 'no JUnit report';
  if (failing.length === 0) return 'no failing test in the JUnit report';
  const nameless = files.find((file) => !tests.includes(file) || !regular(file, root));
  if (nameless !== undefined) return `a failing test names no test file: ${nameless}`;
  if (files.length > most) return `${files.length} files failed, more than flaky-retry (${most})`;
  if (elapsed + limit > budget) return 'past the time budget';
  if (!options) return 'NODE_OPTIONS names no JUnit destination';
  return '';
}

function announce(entries, reason) {
  for (const entry of entries) {
    const line = `${entry.file} › ${entry.name}: ${describe(entry, reason)}`;
    if (entry.kind === 'pass') continue;
    if (entry.excused) console.log(`::notice title=Flaky::${line}`);
    else console.log(`::error title=Flaky::${line}`);
  }
}

export async function retry(env = process.env) {
  const started = Date.now();
  const first = spawnSync('bash', ['-eo', 'pipefail', '-c', env.TEST], { env, stdio: 'inherit' });
  const status = first.status ?? 1;
  const record = { ...context(env), rerun: null, skipped: null, ok: status === 0, rows: [] };
  const shard = record.shard;
  mkdirSync('junit', { recursive: true });
  const save = () =>
    writeFileSync(join('junit', `${shard}.flaky.json`), `${JSON.stringify(record, null, 2)}\n`);
  if (status === 0) {
    save();
    return 0;
  }
  const reports = firstReports('junit', shard);
  const tests = load(reports, record.root);
  const failing = [...tests.values()].filter((test) => statusOf(test) === 'fail');
  const files = [...new Set(failing.map((test) => test.file))];
  const budget = Number(env.TIMEOUT_MINUTES) * 60000;
  const limit = Math.min(15 * 60000, budget / 4);
  const options =
    Boolean(env.SLICC_TEST_JUNIT) &&
    (env.NODE_OPTIONS ?? '').includes(`--test-reporter-destination=${env.SLICC_TEST_JUNIT}`);
  const most = Number(env.FLAKY_RETRY);
  const given = rules(env, globs(env.SLICC_TEST_ALL));
  const skipped = skipReason({
    reports,
    failing,
    files,
    tests: given.tests,
    root: record.root,
    most,
    elapsed: Date.now() - started,
    limit,
    budget,
    options,
  });
  if (skipped) {
    record.skipped = skipped;
    record.rows = judge({ first: tests, retry: undefined, rerun: null, ...given }).rows;
    console.log(`flaky: shard ${shard}: not rerun: ${skipped}`);
  } else {
    console.log(
      `flaky: shard ${shard}: rerunning ${files.join(' ')} (at most ${Math.round(limit / 1000)} s)`
    );
    record.rerun = await rerunFiles(files, limit, env, shard);
    const retried = join('junit', `${shard}.retry.xml`);
    const after = existsSync(retried) ? load([retried], record.root) : undefined;
    const verdict = judge({ first: tests, retry: after, rerun: record.rerun, ...given });
    record.rows = verdict.rows;
    record.ok = verdict.ok;
    if (verdict.broken) console.log(`flaky: shard ${shard}: ${verdict.broken}`);
  }
  announce(record.rows, skipped);
  save();
  const failures = record.rows.filter((entry) => entry.kind === 'failure');
  if (failures.length > 0) {
    const dir = join(env.RUNNER_TEMP, 'slicc-flaky', 'failed');
    mkdirSync(dir, { recursive: true });
    const { rows, rerun, ok, ...rest } = record;
    const failed = failures.map(({ file, name, key: id, error }) => ({
      file,
      name,
      key: id,
      error,
    }));
    writeFileSync(
      join(dir, `failed-${shard}-${record.attempt}.json`),
      `${JSON.stringify({ ...rest, failed }, null, 2)}\n`
    );
  }
  const passed = record.rows.filter((entry) => entry.excused);
  if (record.ok) {
    const issues = passed.map((entry) => (entry.issue ? `#${entry.issue}` : entry.key)).join(', ');
    console.log(
      `flaky: shard ${shard}: PASS, ${passed.length} known flake${passed.length === 1 ? '' : 's'} passed on retry (${issues})`
    );
    return 0;
  }
  console.log(`flaky: shard ${shard}: FAIL`);
  return skipped ? status : 1;
}

export function verdict(env = process.env, dir = 'junit') {
  const given = rules(env, listed(env.FILES));
  const covered = new Set();
  const passed = [];
  let failed = 0;
  for (const json of globSync(`${dir}/**/*.flaky.json`).sort()) {
    const record = JSON.parse(readFileSync(json, 'utf8'));
    const shard = basename(json, '.flaky.json');
    const here = dirname(json);
    const reports = firstReports(here, shard);
    for (const report of reports) covered.add(report);
    const first = load(reports, record.root);
    const retried = join(here, `${shard}.retry.xml`);
    const after = existsSync(retried) ? load([retried], record.root) : undefined;
    const result = judge({ first, retry: after, rerun: record.rerun, ...given });
    const excused = new Set(
      result.ok ? result.rows.filter((entry) => entry.excused).map((entry) => entry.key) : []
    );
    for (const test of first.values()) if (!excused.has(key(test))) failed += test.failed;
    passed.push(...result.rows.filter((entry) => excused.has(entry.key)));
  }
  for (const report of globSync(`${dir}/**/*.xml`).sort()) {
    if (covered.has(report) || report.endsWith('.retry.xml')) continue;
    for (const test of load([report]).values()) failed += test.failed;
  }
  const known = passed.map((entry) => (entry.issue ? `#${entry.issue}` : entry.key));
  const out = join(env.RUNNER_TEMP, 'slicc-flaky');
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'verdict.json'), `${JSON.stringify({ failed, known })}\n`);
  console.log(
    `flaky: verdict: ${failed} failing tests left, ${known.length} known flakes passed on retry${known.length ? ` (${known.join(', ')})` : ''}`
  );
  return 0;
}

function runUrl(ctx, attempt) {
  return `${ctx.server}/${ctx.repo}/actions/runs/${ctx.run}/attempts/${attempt}`;
}

function lead(flip) {
  if (flip.manual) return `Attempt ${flip.from} failed with:`;
  return flip.back ? 'The retry failed with:' : 'The first run failed with:';
}

export function occurrence(flip, ctx) {
  return [
    `- Run: ${runUrl(ctx, flip.attempt)}`,
    `- Event: ${ctx.event}${ctx.pr ? `, PR #${ctx.pr}` : ''}, shard ${flip.shard}`,
    `- Runner: ${flip.runner || 'unknown'}`,
    `- Commit: ${flip.sha || 'unknown'}`,
    '',
    lead(flip),
    '',
    fence(flip.error),
  ].join('\n');
}

function sentence(flip) {
  const test = `\`${flip.file}\` › ${flip.name}`;
  if (flip.manual) {
    return `${test} failed on attempt ${flip.from} of a run, then passed on attempt ${flip.attempt} of it, on the same commit.`;
  }
  if (flip.back)
    return `${test} passed, then failed when its shard ran the file again on the same commit.`;
  return `${test} failed, then passed when its shard ran the file again on the same commit.`;
}

export function body(flip, ctx) {
  const marker = `Every later flip of this test adds a comment here. Key: \`${key(flip)}\``;
  if (flip.strict) {
    return [
      `\`${flip.file}\` › ${flip.name} flipped. It is a strict row, so the details stay in the run.`,
      '',
      `- Run: ${runUrl(ctx, flip.attempt)}`,
      `- Commit: ${flip.sha || 'unknown'}`,
      '',
      marker,
    ].join('\n');
  }
  return [sentence(flip), '', occurrence(flip, ctx), '', marker].join('\n');
}

export function comment(flip, ctx) {
  if (flip.strict)
    return `\`${flip.file}\` › ${flip.name} flipped again: ${runUrl(ctx, flip.attempt)}`;
  return occurrence(flip, ctx);
}

export function clean(text) {
  const found = /<!-- clean: (\d+) since (\S+) -->/.exec(text ?? '');
  return found ? { count: Number(found[1]), since: found[2] } : { count: 0, since: undefined };
}

export function withClean(text, count, since) {
  const stripped = (text ?? '').replace(/\n*<!-- clean: \d+ since \S+ -->/, '');
  return count > 0 ? `${stripped}\n\n<!-- clean: ${count} since ${since} -->` : stripped;
}

export function unzip(zip) {
  const entries = [];
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  for (let at = zip.readUInt32LE(end + 16), left = zip.readUInt16LE(end + 10); left > 0; left--) {
    const size = zip.readUInt32LE(at + 20);
    const named = zip.readUInt16LE(at + 28);
    const name = zip.toString('utf8', at + 46, at + 46 + named);
    const start = zip.readUInt32LE(at + 42);
    const from = start + 30 + zip.readUInt16LE(start + 26) + zip.readUInt16LE(start + 28);
    const data = zip.subarray(from, from + size);
    entries.push([name, String(zip.readUInt16LE(at + 10) === 8 ? inflateRawSync(data) : data)]);
    at += 46 + named + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
  }
  return entries;
}

function client(ctx) {
  return async (method, path, payload) => {
    const response = await fetch(`${ctx.api}/${path}`, {
      method,
      headers: {
        authorization: `Bearer ${ctx.token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        ...(payload ? { 'content-type': 'application/json' } : {}),
      },
      body: payload ? JSON.stringify(payload) : undefined,
      signal: AbortSignal.timeout(60000),
    });
    if (!response.ok) {
      const error = new Error(
        `${method} ${path}: ${response.status} ${(await response.text()).slice(0, 200)}`
      );
      error.status = response.status;
      throw error;
    }
    if (response.status === 204) return null;
    return path.endsWith('/zip') ? Buffer.from(await response.arrayBuffer()) : response.json();
  };
}

async function pages(call, path) {
  const found = [];
  for (let page = 1; page <= 10; page++) {
    const batch = await call(
      'GET',
      `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`
    );
    const items = Array.isArray(batch) ? batch : (batch.artifacts ?? []);
    found.push(...items);
    if (items.length < 100) break;
  }
  return found;
}

function shards(dir) {
  return globSync(`${dir}/**/*.flaky.json`)
    .sort()
    .map((json) => {
      const record = JSON.parse(readFileSync(json, 'utf8'));
      const first = load(firstReports(dirname(json), basename(json, '.flaky.json')), record.root);
      return { record, first };
    });
}

async function failedBefore(call, ctx) {
  const artifacts = await pages(call, `repos/${ctx.repo}/actions/runs/${ctx.run}/artifacts`);
  const failed = new Map();
  for (const artifact of artifacts) {
    const attempt = Number(/^failed-.+-(\d+)$/.exec(artifact.name)?.[1]);
    if (artifact.expired || !(attempt < ctx.attempt)) continue;
    const zip = await call('GET', `repos/${ctx.repo}/actions/artifacts/${artifact.id}/zip`);
    for (const [, text] of unzip(zip)) {
      const list = JSON.parse(text);
      for (const test of list.failed) {
        if ((failed.get(test.key)?.from ?? 0) < list.attempt)
          failed.set(test.key, { ...test, from: list.attempt });
      }
    }
  }
  return failed;
}

async function earlier(call, ctx, found, given) {
  if (ctx.attempt <= 1) return [];
  const failed = await failedBefore(call, ctx);
  const flips = [];
  for (const { record, first } of found) {
    for (const test of first.values()) {
      const before = failed.get(key(test));
      if (!before || statusOf(test) !== 'pass' || record.attempt <= before.from) continue;
      const kind = category(test, given);
      flips.push({
        ...before,
        kind: kind === 'strict' || kind === 'changed' ? kind : 'manual',
        manual: true,
        attempt: record.attempt,
        shard: record.shard,
        runner: record.runner,
        sha: record.sha,
      });
    }
  }
  return flips;
}

function quietReason(ctx, found) {
  const glob = ctx.quiet.find((pattern) => matchesGlob(ctx.branch, pattern));
  if (glob) return `quiet branch (${glob})`;
  const broken = found.some(
    ({ record }) => record.skipped || record.rows.some((entry) => entry.kind === 'failure')
  );
  if (ctx.event === 'pull_request' && broken) return 'the run also has real failures';
  return '';
}

async function labels(call, ctx) {
  for (const [name, color, description] of LABELS) {
    await call('POST', `repos/${ctx.repo}/labels`, { name, color, description }).catch((error) => {
      if (error.status !== 422) throw error;
    });
  }
}

function keyOf(issue) {
  return /Key: `([0-9a-f]{16})`/.exec(issue.body ?? '')?.[1];
}

async function recur(call, ctx, flip, issue, closed) {
  const text = comment(flip, ctx);
  const secret = carriesSecret(text, [ctx.token]);
  if (secret) return `not posted: it carries ${secret}`;
  const path = `repos/${ctx.repo}/issues/${issue.number}`;
  const names = issue.labels.map((label) => (typeof label === 'string' ? label : label.name));
  const reset = withClean(issue.body, 0);
  if (closed || reset !== (issue.body ?? '')) {
    await call('PATCH', path, { ...(closed ? { state: 'open' } : {}), body: reset });
  }
  await call('POST', `${path}/comments`, { body: text });
  const commit = /^- Commit: (\S+)/m.exec(issue.body ?? '')?.[1];
  if (names.includes('new') && commit && commit !== flip.sha) {
    await call('DELETE', `${path}/labels/new`).catch((error) => {
      if (error.status !== 404) throw error;
    });
  }
  if (flip.strict && !names.includes('guard'))
    await call('POST', `${path}/labels`, { labels: ['guard'] });
  return `#${issue.number}${closed ? ' (reopened)' : ''}`;
}

async function create(call, ctx, flip) {
  const name = title(flip);
  const text = body(flip, ctx);
  const secret = carriesSecret(`${name}\n${text}`, [ctx.token]);
  if (secret) return `not posted: it carries ${secret}`;
  const created = await call('POST', `repos/${ctx.repo}/issues`, {
    title: name,
    body: text,
    labels: [LABEL, 'new', ...(flip.strict ? ['guard'] : [])],
  });
  return `#${created.number} (new)`;
}

async function sweep(call, ctx, open, touched, passing) {
  const today = new Date(ctx.now).toISOString().slice(0, 10);
  for (const issue of open) {
    const id = keyOf(issue);
    if (!id || touched.has(issue.number) || !passing.has(id)) continue;
    const { count, since = today } = clean(issue.body);
    const next = withClean(issue.body, count + 1, since);
    const path = `repos/${ctx.repo}/issues/${issue.number}`;
    if (count + 1 < ctx.closeAfter) {
      await call('PATCH', path, { body: next });
      continue;
    }
    await call('POST', `${path}/comments`, {
      body: `no flip in ${ctx.closeAfter} clean merge-group runs since ${since}; a new flip reopens it`,
    });
    await call('PATCH', path, { body: next, state: 'closed', state_reason: 'completed' });
    console.log(`flaky: closed #${issue.number} after ${ctx.closeAfter} clean merge-group runs`);
  }
}

async function file(call, ctx, flips, passing) {
  const notes = new Map();
  const listed = (state) =>
    pages(
      call,
      `repos/${ctx.repo}/issues?labels=${LABEL}&state=${state}${state === 'closed' ? `&since=${new Date(ctx.now - 30 * DAY).toISOString()}` : ''}`
    );
  const open = (await listed('open')).filter((issue) => !issue.pull_request);
  const cutoff = ctx.now - 30 * DAY;
  const closed = (await listed('closed')).filter(
    (issue) => !issue.pull_request && Date.parse(issue.closed_at) >= cutoff
  );
  const find = (list, id) => list.find((issue) => keyOf(issue) === id);
  const plan = flips.map((flip) => ({
    flip,
    open: find(open, flip.key),
    closed: find(closed, flip.key),
  }));
  const fresh = plan.filter((entry) => !entry.open && !entry.closed).length;
  if (fresh > CAP) {
    const line = `flaky: ${flips.length} flips in one run, not filing (infrastructure?)`;
    console.log(line);
    for (const flip of flips) notes.set(flip.key, 'not filed: too many flips in one run');
    return { notes, line };
  }
  if (fresh > 0) await labels(call, ctx);
  const touched = new Set();
  for (const entry of plan) {
    const issue = entry.open ?? entry.closed;
    if (issue) touched.add(issue.number);
    const note = issue
      ? await recur(call, ctx, entry.flip, issue, !entry.open)
      : await create(call, ctx, entry.flip);
    notes.set(entry.flip.key, note);
    console.log(`flaky: ${title(entry.flip)}: ${note}`);
  }
  if (ctx.event === 'merge_group') await sweep(call, ctx, open, touched, passing);
  return { notes, line: '' };
}

function cell(text) {
  return String(text)
    .replace(/\|/g, '\\|')
    .replace(/\s*\n\s*/g, ' ');
}

export function table(entries, notes, lines) {
  const head = ['### Flaky tests', '', ...lines.filter(Boolean).flatMap((line) => [line, ''])];
  if (entries.length === 0) return [...head, 'No flips or failures.', ''].join('\n');
  return [
    ...head,
    '| Test | Shard | Outcome | Issue |',
    '|---|---|---|---|',
    ...entries.map(
      (entry) =>
        `| ${cell(`\`${entry.file}\` › ${entry.name}`)} | ${cell(entry.shard)} | ${cell(describe(entry, entry.reason))} | ${cell(notes.get(entry.key) ?? '')} |`
    ),
    '',
  ].join('\n');
}

function reportContext(env) {
  const ref = env.GITHUB_REF_NAME ?? '';
  return {
    api: env.GITHUB_API_URL || 'https://api.github.com',
    server: env.GITHUB_SERVER_URL || 'https://github.com',
    repo: env.GITHUB_REPOSITORY,
    run: env.GITHUB_RUN_ID,
    attempt: Number(env.GITHUB_RUN_ATTEMPT || 1),
    event: env.GITHUB_EVENT_NAME,
    branch: env.GITHUB_HEAD_REF || ref,
    pr: env.PR || /\/pr-(\d+)-/.exec(ref)?.[1] || '',
    token: env.GH_TOKEN ?? '',
    quiet: globs(env.QUIET),
    closeAfter: Number(env.CLOSE_AFTER || 20),
    now: Date.now(),
  };
}

function named(entry, tests) {
  if (entry.kind === 'failure' || tests.includes(entry.file)) return true;
  console.log(`flaky: ${entry.file} › ${entry.name}: not filed: it names no test file`);
  return false;
}

function collect(found, ctx, tests) {
  const entries = [];
  const passing = new Set();
  for (const { record, first } of found) {
    for (const test of first.values()) if (statusOf(test) === 'pass') passing.add(key(test));
    if (record.attempt !== ctx.attempt) continue;
    for (const entry of record.rows) {
      if (entry.kind === 'pass') continue;
      entries.push({
        ...entry,
        shard: record.shard,
        attempt: record.attempt,
        runner: record.runner,
        sha: record.sha,
        reason: record.skipped,
        strict: entry.kind === 'strict',
      });
    }
  }
  for (const entry of entries) if (entry.kind !== 'failure') passing.delete(entry.key);
  return { entries: entries.filter((entry) => named(entry, tests)), passing };
}

export async function report(env = process.env, dir = 'junit') {
  const ctx = reportContext(env);
  const given = rules(env, listed(env.FILES));
  const found = shards(dir);
  const { entries, passing } = collect(found, ctx, given.tests);
  const call = client(ctx);
  const lines = [];
  let notes = new Map();
  try {
    const seen = new Set(entries.map((entry) => entry.key));
    for (const flip of ctx.token ? await earlier(call, ctx, found, given) : []) {
      if (seen.has(flip.key) || !named(flip, given.tests)) continue;
      seen.add(flip.key);
      entries.push({ ...flip, strict: flip.kind === 'strict' });
      passing.delete(flip.key);
    }
    const flips = entries.filter((entry) => entry.kind !== 'failure');
    const reportable = flips.filter((entry) => entry.kind !== 'changed');
    for (const entry of flips)
      if (entry.kind === 'changed') notes.set(entry.key, 'not filed: the PR changes this test');
    const quiet = quietReason(ctx, found);
    if (!ctx.token) lines.push('flaky: no token, nothing filed');
    else if (quiet) {
      lines.push(`flaky: not filing: ${quiet}`);
      for (const flip of reportable) notes.set(flip.key, `not filed: ${quiet}`);
    } else if (reportable.length > 0 || ctx.event === 'merge_group') {
      const filed = await file(call, ctx, reportable, passing);
      notes = new Map([...notes, ...filed.notes]);
      lines.push(filed.line);
    }
  } catch (error) {
    const line =
      error.status === 403
        ? 'flaky: no issues: write, so nothing more was filed'
        : `flaky: GitHub API failed, so nothing more was filed (${error.message.split('\n')[0]})`;
    lines.push(line);
    console.log(`::warning title=Flaky::${line}`);
  }
  const text = table(entries, notes, lines);
  console.log(text);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, text);
  return 0;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const [mode] = argv;
  if (mode === 'retry') return retry(env);
  if (mode === 'verdict') return verdict(env);
  if (mode === 'report') return report(env);
  console.error('usage: slicc-flaky retry|verdict|report');
  return 2;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
