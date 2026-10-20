import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const installer = join(repo, 'bin', 'slicc-install-hooks.sh');
const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const which = (command) =>
  spawnSync('sh', ['-c', `command -v ${command}`], { encoding: 'utf8' }).stdout.trim();

const path = mkdtempSync(join(tmpdir(), 'slicc-worktree-hooks-bin-'));
dirs.push(path);
const linked = new Set();
for (const dir of new Set([process.execPath, which('git'), which('sh')].map(dirname))) {
  for (const name of readdirSync(dir)) {
    if (!name.startsWith('lefthook') && !linked.has(name)) {
      linked.add(name);
      symlinkSync(join(dir, name), join(path, name));
    }
  }
}

function env(extra = {}) {
  const clean = { ...process.env, PATH: path, ...extra };
  for (const key of Object.keys(clean)) {
    if (key.startsWith('LEFTHOOK') && !(key in extra)) delete clean[key];
    if (key.startsWith('GIT_')) delete clean[key];
  }
  return clean;
}

function git(dir, args, extra) {
  const run = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: env(extra),
  });
  return { ...run, output: `${run.stdout}\n${run.stderr}` };
}

function ok(dir, ...args) {
  const run = git(dir, args);
  assert.equal(run.status, 0, run.output);
  return run.stdout.trim();
}

function modules(dir) {
  mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true });
  for (const name of readdirSync(join(repo, 'node_modules'))) {
    if (name === 'lefthook' || name.startsWith('lefthook-')) {
      cpSync(join(repo, 'node_modules', name), join(dir, 'node_modules', name), {
        recursive: true,
      });
    }
  }
  symlinkSync('../lefthook/bin/index.js', join(dir, 'node_modules', '.bin', 'lefthook'));
}

function install(dir) {
  const run = spawnSync('sh', [installer], {
    cwd: dir,
    encoding: 'utf8',
    env: env({ PATH: `${join(dir, 'node_modules', '.bin')}:${path}` }),
  });
  assert.equal(run.status, 0, run.stdout + run.stderr);
}

function commit(dir, line) {
  writeFileSync(join(dir, 'README.md'), `# fixture\n${line}\n`);
  ok(dir, 'add', 'README.md');
  return git(dir, ['commit', '-m', line], { LEFTHOOK_VERBOSE: '1' });
}

function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'slicc-worktree-hooks-')));
  dirs.push(base);
  const main = join(base, 'main');
  mkdirSync(main);
  writeFileSync(join(main, '.gitignore'), 'node_modules/\n');
  writeFileSync(
    join(main, 'lefthook.yml'),
    'assert_lefthook_installed: true\npre-commit:\n  jobs:\n    - name: marker\n      run: echo worktree-hook-ran\n'
  );
  writeFileSync(join(main, 'README.md'), '# fixture\n');
  ok(main, 'init', '-q');
  ok(main, 'add', '-A');
  ok(main, 'commit', '-qm', 'init', '--no-verify');
  const a = join(base, 'a');
  const b = join(base, 'b');
  ok(main, 'worktree', 'add', '-q', '-b', 'a', a);
  ok(main, 'worktree', 'add', '-q', '-b', 'b', b);
  for (const dir of [main, a, b]) modules(dir);
  return { main, a, b };
}

function ranWith(run, own, others) {
  assert.equal(run.status, 0, run.output);
  assert.match(run.output, /worktree-hook-ran/);
  assert.ok(run.output.includes(join(own, 'node_modules', 'lefthook-')), run.output);
  for (const other of others) {
    assert.ok(!run.output.includes(join(other, 'node_modules')), run.output);
  }
}

test("a commit in worktree A runs A's hooks after B installs, and still does once B is deleted", () => {
  const { main, a, b } = fixture();
  install(main);
  install(a);
  install(a);
  install(b);

  ranWith(commit(a, 'a after b installed'), a, [b, main]);
  ranWith(commit(main, 'main after b installed'), main, [a, b]);
  ranWith(commit(b, 'b'), b, [a, main]);

  const hooks = [main, a, b].map((dir) => ok(dir, 'rev-parse', '--git-path', 'hooks'));
  assert.equal(new Set(hooks).size, 3, hooks.join('\n'));
  assert.equal(ok(a, 'config', '--worktree', '--get-all', 'core.hooksPath').split('\n').length, 1);

  ok(main, 'worktree', 'remove', '--force', b);
  assert.equal(existsSync(b), false);
  ranWith(commit(a, 'a after b deleted'), a, [b, main]);
  ranWith(commit(main, 'main after b deleted'), main, [a, b]);
  assert.equal(ok(a, 'log', '-1', '--format=%s'), 'a after b deleted');
});
