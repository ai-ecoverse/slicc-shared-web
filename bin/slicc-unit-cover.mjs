#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { code, ParseError, select } from '../unit/graph.mjs';
import { inject } from '../unit/inject.mjs';
import { inSources } from '../unit/sources.mjs';

const root = process.cwd();
const say = (line) => process.stderr.write(`slicc-unit-cover: ${line}\n`);
const verdict = (ok, line) => {
  process.stdout.write(`slicc-unit-cover: ${ok ? 'PASS' : 'FAIL'} ${line}\n`);
  process.exit(ok ? 0 : 1);
};

function git(...args) {
  const run = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  return run.status === 0 ? run.stdout : undefined;
}

function run(command, args, env) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function bounded(command, args, env, ms) {
  const child = spawn(command, args, { cwd: root, env, stdio: 'inherit', detached: true });
  const kill = (signal) => {
    try {
      process.kill(-child.pid, signal);
    } catch {}
  };
  const forward = (signal) => () => kill(signal);
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'].map((name) => [name, forward(name)]);
  for (const [name, handler] of signals) process.on(name, handler);
  return new Promise((resolve, reject) => {
    let late = false;
    const timer =
      ms > 0
        ? setTimeout(() => {
            late = true;
            kill('SIGKILL');
          }, ms)
        : undefined;
    child.on('error', reject);
    child.on('close', (status) => {
      clearTimeout(timer);
      for (const [name, handler] of signals) process.off(name, handler);
      if (late) kill('SIGKILL');
      resolve({ status: status ?? 1, late });
    });
  });
}

function selection(staged) {
  if (process.env.SLICC_UNIT_ALL === '1') return undefined;
  try {
    const { tests, elsewhere, total } = select({ root, changed: staged });
    if (elsewhere.length > 0) {
      say(
        `skipping ${elsewhere.length} that import a module this tree lacks: ${elsewhere.join(' ')}`
      );
    }
    say(`running ${tests.length} of ${total} unit test files`);
    return tests;
  } catch (error) {
    if (!(error instanceof ParseError)) throw error;
    say(
      `could not build the import graph (${error.message.split('\n')[0]}), running every unit test`
    );
    return undefined;
  }
}

const staged = (git('diff', '--cached', '--name-only', '--relative', '--no-renames', '-z') ?? '')
  .split('\0')
  .filter(Boolean);
if (
  process.env.SLICC_UNIT_ALL !== '1' &&
  !staged.some((file) => code.test(file) && inSources(file, root))
) {
  say('no code staged, skipping unit tests and diff coverage');
  verdict(true, 'no code staged');
}
const measured = staged.filter(
  (file) => code.test(file) && inSources(file, root) && existsSync(join(root, file))
);
const jsx = measured.filter((file) => /x$/.test(file));
if (jsx.length > 0) {
  verdict(false, `coverage cannot be measured for JSX, which is not transformed: ${jsx.join(' ')}`);
}

const size = Number(process.env.SLICC_UNIT_BATCH ?? 60);
const tests = selection(staged);
const batches = [];
if (tests === undefined || !(size > 0) || tests.length <= size) batches.push(tests);
else for (let at = 0; at < tests.length; at += size) batches.push(tests.slice(at, at + size));
const reports = [];
const scratch = mkdtempSync(join(tmpdir(), 'slicc-unit-cover-'));
const report = join(scratch, 'report');
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }));
const why = () => {
  const lines = existsSync(report) ? readFileSync(report, 'utf8').trim().split('\n') : [];
  return lines.length > 0 ? `: ${lines.join('; ')}` : '';
};
for (const [index, batch] of batches.entries()) {
  const env = {
    ...process.env,
    SLICC_UNIT_TIMEOUT: process.env.SLICC_UNIT_TIMEOUT ?? '60000',
    SLICC_UNIT_REPORT: report,
  };
  if (batch === undefined) delete env.SLICC_UNIT_TESTS;
  else {
    env.SLICC_UNIT_TESTS = batch.join('\n');
    env.NODE_OPTIONS = inject(env.NODE_OPTIONS ?? '');
  }
  if (batches.length > 1) {
    env.SLICC_UNIT_COVERAGE_DIR = join('coverage', 'unit', `batch-${index + 1}`);
    reports.push(join(env.SLICC_UNIT_COVERAGE_DIR, 'lcov.info'));
    say(`batch ${index + 1} of ${batches.length}: ${batch.length} files`);
  }
  const limit = Number(process.env.SLICC_UNIT_BATCH_TIMEOUT ?? 600000);
  const { status, late } = await bounded('npm', ['run', '--silent', 'test:unit'], env, limit);
  const which = batches.length > 1 ? `batch ${index + 1} of ${batches.length}` : 'the unit tests';
  if (late) {
    const named = batch === undefined ? 'every unit test file' : batch.join(' ');
    verdict(
      false,
      `${which} ran past ${limit}ms and ${batches.length > 1 ? 'was' : 'were'} killed (${named})${why()}`
    );
  }
  if (status !== 0) {
    verdict(false, `${which} failed (status ${status})${why()}`);
  }
}
const local = join(root, 'node_modules', '.bin', 'slicc-diff-cover');
const cover = existsSync(local)
  ? local
  : fileURLToPath(new URL('slicc-diff-cover.sh', import.meta.url));
const files = tests === undefined ? 'every unit test file' : `${tests.length} unit test files`;
const counted = `${batches.length} ${batches.length === 1 ? 'batch' : 'batches'}`;
const lcov = (reports.length > 0 ? reports : [join('coverage', 'unit', 'lcov.info')])
  .map((report) => {
    try {
      return readFileSync(join(root, report), 'utf8');
    } catch {
      return '';
    }
  })
  .join('\n');
const seen = new Set(lcov.match(/^SF:.*$/gm)?.map((line) => line.slice(3)) ?? []);
const missing = measured.filter((file) => !seen.has(file));
if (missing.length > 0) verdict(false, `no coverage was collected for ${missing.join(' ')}`);
const covered = run(cover, reports, process.env);
if (covered !== 0) verdict(false, `diff coverage is not 100% (${files} in ${counted})`);
verdict(true, `${files} in ${counted}, diff coverage 100%`);
