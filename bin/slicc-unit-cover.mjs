#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { code, ParseError, select } from '../unit/graph.mjs';
import { inject } from '../unit/inject.mjs';

const root = process.cwd();
const say = (line) => process.stderr.write(`slicc-unit-cover: ${line}\n`);

function git(...args) {
  const run = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  return run.status === 0 ? run.stdout : undefined;
}

function since() {
  const moved = git('log', '-g', '-1', '--format=%gd', '--date=unix', 'HEAD')?.match(/\{(\d+)\}/);
  const committed = git('log', '-1', '--format=%ct', 'HEAD')?.trim();
  const seconds = Math.max(Number(moved?.[1] ?? 0), Number(committed || 0));
  return seconds > 0 ? seconds * 1000 : undefined;
}

function run(command, args, env) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function selection(staged) {
  if (process.env.SLICC_UNIT_ALL === '1') return undefined;
  try {
    const { tests, total } = select({ root, changed: staged, since: since() });
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
  process.exit(0);
}

const env = { ...process.env };
const tests = selection(staged);
if (tests === undefined) delete env.SLICC_UNIT_TESTS;
else {
  env.SLICC_UNIT_TESTS = tests.join('\n');
  env.NODE_OPTIONS = inject(env.NODE_OPTIONS ?? '');
}
const status = run('npm', ['run', '--silent', 'test:unit'], env);
if (status !== 0) process.exit(status);
const local = join(root, 'node_modules', '.bin', 'slicc-diff-cover');
const cover = existsSync(local)
  ? local
  : fileURLToPath(new URL('slicc-diff-cover.sh', import.meta.url));
process.exit(run(cover, [], process.env));
