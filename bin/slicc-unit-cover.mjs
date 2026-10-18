#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { code, ParseError, select } from '../unit/graph.mjs';
import { inject } from '../unit/inject.mjs';

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
if (process.env.SLICC_UNIT_ALL !== '1' && !staged.some((file) => code.test(file))) {
  say('no code staged, skipping unit tests and diff coverage');
  verdict(true, 'no code staged');
}

const size = Number(process.env.SLICC_UNIT_BATCH ?? 60);
const tests = selection(staged);
const batches = [];
if (tests === undefined || !(size > 0) || tests.length <= size) batches.push(tests);
else for (let at = 0; at < tests.length; at += size) batches.push(tests.slice(at, at + size));
const reports = [];
for (const [index, batch] of batches.entries()) {
  const env = { ...process.env };
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
  const status = run('npm', ['run', '--silent', 'test:unit'], env);
  if (status !== 0) {
    const which = batches.length > 1 ? `batch ${index + 1} of ${batches.length}` : 'the unit tests';
    verdict(false, `${which} failed (status ${status})`);
  }
}
const local = join(root, 'node_modules', '.bin', 'slicc-diff-cover');
const cover = existsSync(local)
  ? local
  : fileURLToPath(new URL('slicc-diff-cover.sh', import.meta.url));
const files = tests === undefined ? 'every unit test file' : `${tests.length} unit test files`;
const counted = `${batches.length} ${batches.length === 1 ? 'batch' : 'batches'}`;
const covered = run(cover, reports, process.env);
if (covered !== 0) verdict(false, `diff coverage is not 100% (${files} in ${counted})`);
verdict(true, `${files} in ${counted}, diff coverage 100%`);
