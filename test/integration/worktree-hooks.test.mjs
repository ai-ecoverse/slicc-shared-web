import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
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

function install(dir, script = installer) {
  const run = spawnSync('sh', [script], {
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

function untouched(dir, bare = 'false') {
  const common = ok(dir, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  assert.equal(git(dir, ['config', '--get', 'extensions.worktreeConfig']).status, 1);
  assert.equal(ok(dir, 'config', '--file', join(common, 'config'), 'core.bare'), bare);
  assert.equal(ok(dir, 'config', '--get-all', 'core.hooksPath'), 'node_modules/.git-hooks');
  assert.equal(
    ok(dir, 'config', '--show-scope', '--get-all', 'core.hooksPath'),
    'local\tnode_modules/.git-hooks'
  );
  const configs = [common, ...ok(dir, 'worktree', 'list', '--porcelain').split('\n')]
    .filter((line) => line.startsWith('worktree ') || line === common)
    .map((line) => line.replace(/^worktree /, ''));
  for (const top of configs) {
    if (!existsSync(top)) continue;
    const gitDir = ok(top, 'rev-parse', '--path-format=absolute', '--git-dir');
    assert.equal(existsSync(join(gitDir, 'config.worktree')), false, gitDir);
    assert.equal(existsSync(join(gitDir, 'worktree-hooks')), false, gitDir);
  }
  assert.equal(existsSync(join(common, 'hooks', 'pre-commit')), false);
}

test('each worktree runs its own hooks from a shared relative core.hooksPath, also after another one is deleted', () => {
  const { main, a, b } = fixture();
  install(main);
  install(a);
  install(a);
  install(b);
  untouched(main);

  ranWith(commit(a, 'a after b installed'), a, [b, main]);
  ranWith(commit(main, 'main after b installed'), main, [a, b]);
  ranWith(commit(b, 'b'), b, [a, main]);
  for (const dir of [main, a, b]) {
    assert.ok(existsSync(join(dir, 'node_modules', '.git-hooks', 'pre-commit')), dir);
    assert.ok(
      readFileSync(join(dir, 'node_modules', '.git-hooks', 'pre-commit'), 'utf8').includes(
        join(dir, 'node_modules')
      )
    );
  }

  ok(main, 'worktree', 'remove', '--force', b);
  ok(main, 'worktree', 'prune');
  assert.equal(existsSync(b), false);
  ranWith(commit(a, 'a after b deleted'), a, [b, main]);
  ranWith(commit(main, 'main after b deleted'), main, [a, b]);
  mkdirSync(join(a, 'sub'));
  writeFileSync(join(a, 'README.md'), '# fixture\nfrom a subdirectory\n');
  ok(a, 'add', 'README.md');
  ranWith(git(join(a, 'sub'), ['commit', '-m', 'from sub'], { LEFTHOOK_VERBOSE: '1' }), a, [
    b,
    main,
  ]);
  assert.equal(ok(a, 'log', '-1', '--format=%s'), 'from sub');
  untouched(a);
});

test('a moved worktree keeps running its own hooks', () => {
  const { main, a } = fixture();
  install(main);
  install(a);
  const moved = `${a}-moved`;
  ok(main, 'worktree', 'move', a, moved);
  const run = commit(moved, 'after move');
  assert.equal(run.status, 0, run.output);
  assert.match(run.output, /worktree-hook-ran/);
  assert.equal(ok(moved, 'log', '-1', '--format=%s'), 'after move');
  ranWith(commit(main, 'main after move'), main, [moved]);
  untouched(moved);
});

test('lefthook postinstall writes no shared hook once core.hooksPath is relative', () => {
  const { main, a } = fixture();
  install(main);
  const run = spawnSync(process.execPath, [join(a, 'node_modules', 'lefthook', 'postinstall.js')], {
    cwd: a,
    encoding: 'utf8',
    env: env({ INIT_CWD: a }),
  });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.equal(existsSync(join(a, 'node_modules', '.git-hooks')), false);
  untouched(a);
});

test('in worktrees of a bare repo, each commit runs its own hooks, and the repo stays bare', () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'slicc-worktree-hooks-bare-')));
  dirs.push(base);
  const { main } = fixture();
  const bare = join(base, 'repo.git');
  ok(base, 'clone', '-q', '--bare', main, bare);
  const a = join(base, 'a');
  const b = join(base, 'b');
  ok(bare, 'worktree', 'add', '-q', '-b', 'bare-a', a);
  ok(bare, 'worktree', 'add', '-q', '-b', 'bare-b', b);
  for (const dir of [a, b]) modules(dir);
  install(a);
  install(b);
  install(b);

  assert.equal(ok(bare, 'rev-parse', '--is-bare-repository'), 'true');
  for (const dir of [a, b]) assert.equal(ok(dir, 'rev-parse', '--is-bare-repository'), 'false');
  ranWith(commit(a, 'a after b installed'), a, [b]);
  ranWith(commit(b, 'b'), b, [a]);

  ok(bare, 'worktree', 'remove', '--force', b);
  ranWith(commit(a, 'a after b deleted'), a, [b]);
  assert.equal(ok(bare, 'rev-parse', '--is-bare-repository'), 'true');
  untouched(a, 'true');
});

test('a worktree set up by the old per-worktree installer drops its absolute core.hooksPath and runs its own hooks', () => {
  const { main, a, b } = fixture();
  const old = join(dirname(main), 'old-install-hooks.sh');
  writeFileSync(
    old,
    [
      '#!/bin/sh',
      'set -eu',
      'git rev-parse --git-dir >/dev/null 2>&1 || exit 0',
      'common="$(git rev-parse --path-format=absolute --git-common-dir)"',
      'for key in core.bare core.worktree; do',
      '  if value=$(git config --file "$common/config" --get "$key"); then',
      '    git config --file "$common/config.worktree" --get "$key" >/dev/null || git config --file "$common/config.worktree" "$key" "$value"',
      '    git config --file "$common/config" --unset "$key"',
      '  fi',
      'done',
      'hooks="$(git rev-parse --absolute-git-dir)/worktree-hooks"',
      'git config extensions.worktreeConfig true',
      'git config --worktree core.hooksPath "$hooks"',
      'exec lefthook install "$@"',
      '',
    ].join('\n')
  );
  install(main, old);
  install(a, old);
  install(b, old);
  assert.match(ok(a, 'config', '--worktree', 'core.hooksPath'), /worktree-hooks$/);

  install(a);
  install(a);
  const gitDir = ok(a, 'rev-parse', '--path-format=absolute', '--git-dir');
  assert.equal(
    git(a, ['config', '--file', join(gitDir, 'config.worktree'), '--get-all', 'core.hooksPath'])
      .status,
    1
  );
  assert.equal(ok(a, 'config', '--get-all', 'core.hooksPath'), 'node_modules/.git-hooks');
  assert.equal(ok(a, 'config', 'extensions.worktreeConfig'), 'true');
  ranWith(commit(a, 'a after migration'), a, [b, main]);
  ranWith(commit(b, 'b still on its old hooks'), b, [a, main]);
});

test('outside a git checkout it does nothing and exits 0', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'slicc-worktree-hooks-none-')));
  dirs.push(dir);
  const run = spawnSync('sh', [installer], { cwd: dir, encoding: 'utf8', env: env() });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.equal(run.stdout + run.stderr, '');
  assert.deepEqual(readdirSync(dir), []);
});
