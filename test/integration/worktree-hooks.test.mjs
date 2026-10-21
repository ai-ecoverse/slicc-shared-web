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
import { commitAll, initFixtureRepo } from '@ai-ecoverse/slicc-shared-web/testing';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const installer = join(
  repo,
  JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).bin['slicc-install-hooks']
);
const runner = (script) => (script.endsWith('.sh') ? 'sh' : process.execPath);
const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const which = (command) =>
  spawnSync('sh', ['-c', `command -v ${command}`], { encoding: 'utf8' }).stdout.trim();

const path = mkdtempSync(join(tmpdir(), 'slicc-worktree-hooks-bin-'));
dirs.push(path);
const tools = ['git', 'sh', 'sed', 'tr', 'uname', 'grep'].map(which);
writeFileSync(
  join(path, 'git'),
  [
    '#!/bin/sh',
    `case "$(env | grep -E '^GIT_CONFIG_(KEY_[0-9]+|PARAMETERS)=' | tr '[:upper:]' '[:lower:]')" in`,
    '  *core.hookspath*) echo "git: overriding core.hooksPath from the environment is refused" >&2; exit 1 ;;',
    'esac',
    `exec '${tools[0]}' "$@"`,
    '',
  ].join('\n'),
  { mode: 0o755 }
);
const linked = new Set(['git']);
for (const dir of new Set([process.execPath, ...tools].map(dirname))) {
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
  const run = spawnSync(runner(script), [script], {
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

const oldInstaller = [
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
].join('\n');

const config =
  'assert_lefthook_installed: true\npre-commit:\n  jobs:\n    - name: marker\n      run: echo worktree-hook-ran\n';

function repoWithShims(main) {
  mkdirSync(main);
  writeFileSync(join(main, '.gitignore'), 'node_modules/\n');
  writeFileSync(join(main, 'lefthook.yml'), config);
  writeFileSync(join(main, 'README.md'), '# fixture\n');
  initFixtureRepo(main);
  modules(main);
  install(main);
  commitAll(main, 'init');
}

function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'slicc-worktree-hooks-')));
  dirs.push(base);
  const main = join(base, 'main');
  repoWithShims(main);
  const a = join(base, 'a');
  const b = join(base, 'b');
  ok(main, 'worktree', 'add', '-q', '-b', 'a', a);
  ok(main, 'worktree', 'add', '-q', '-b', 'b', b);
  return { base, main, a, b };
}

function ranWith(run, own, others) {
  assert.equal(run.status, 0, run.output);
  assert.match(run.output, /worktree-hook-ran/);
  assert.ok(run.output.includes(join(own, 'node_modules', 'lefthook-')), run.output);
  assert.doesNotMatch(run.output, /core\.hooksPath is set|sync hooks/);
  for (const other of others) {
    assert.ok(!run.output.includes(join(other, 'node_modules')), run.output);
  }
}

function refused(run, dir, before) {
  assert.notEqual(run.status, 0, run.output);
  assert.match(run.output, /pre-commit: run npm install/);
  assert.equal(ok(dir, 'log', '-1', '--format=%s'), before);
}

function untouched(dir, bare = 'false') {
  const common = ok(dir, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  assert.equal(git(dir, ['config', '--get', 'extensions.worktreeConfig']).status, 1);
  assert.equal(ok(dir, 'config', '--file', join(common, 'config'), 'core.bare'), bare);
  assert.equal(
    ok(dir, 'config', '--show-scope', '--get-all', 'core.hooksPath'),
    'local\t.githooks'
  );
  const tops = ok(dir, 'worktree', 'list', '--porcelain')
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length));
  for (const top of tops.filter((t) => existsSync(t) && t !== common)) {
    const gitDir = ok(top, 'rev-parse', '--path-format=absolute', '--git-dir');
    assert.equal(existsSync(join(gitDir, 'config.worktree')), false, gitDir);
    assert.equal(existsSync(join(gitDir, 'worktree-hooks')), false, gitDir);
  }
  assert.equal(existsSync(join(common, 'config.worktree')), false);
  assert.equal(existsSync(join(common, 'hooks', 'pre-commit')), false);
}

test('the installer writes a committed .githooks shim that runs the worktree own lefthook hook', () => {
  const { main } = fixture();
  const shim = join(main, '.githooks', 'pre-commit');
  assert.equal(readFileSync(shim, 'utf8').split('\n')[0], '#!/bin/sh');
  assert.ok(existsSync(join(main, 'node_modules', '.git-hooks', 'pre-commit')));
  assert.equal(ok(main, 'ls-files', '.githooks'), '.githooks/pre-commit');
  assert.equal(ok(main, 'ls-files', '-s', '.githooks/pre-commit').split(' ')[0], '100755');
  ranWith(commit(main, 'main'), main, []);
  untouched(main);
});

test('a fresh worktree without npm install fails the commit with run npm install, then runs its own hooks once installed, also after another one is deleted', () => {
  const { main, a, b } = fixture();
  refused(commit(a, 'a before install'), a, 'init');
  refused(commit(b, 'b before install'), b, 'init');

  modules(a);
  install(a);
  install(a);
  modules(b);
  install(b);
  for (const dir of [a, b]) assert.equal(ok(dir, 'status', '--porcelain', '.githooks'), '');
  ranWith(commit(a, 'a after b installed'), a, [b, main]);
  ranWith(commit(main, 'main after b installed'), main, [a, b]);
  ranWith(commit(b, 'b'), b, [a, main]);
  for (const dir of [main, a, b]) {
    const hook = readFileSync(join(dir, 'node_modules', '.git-hooks', 'pre-commit'), 'utf8');
    assert.ok(!hook.includes(dir), dir);
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

  rmSync(join(a, 'node_modules'), { recursive: true, force: true });
  refused(commit(a, 'a without node_modules'), a, 'from sub');
  untouched(a);
});

test('a moved worktree keeps running its own hooks', () => {
  const { main, a } = fixture();
  modules(a);
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

test('an existing shim is never overwritten, and every configured hook gets one', () => {
  const { main } = fixture();
  const shim = join(main, '.githooks', 'pre-commit');
  const custom = '#!/bin/sh\necho custom-shim\nexit 0\n';
  writeFileSync(shim, custom);
  writeFileSync(join(main, 'extra.yml'), 'post-merge:\n  jobs:\n    - run: echo merged\n');
  writeFileSync(
    join(main, 'lefthook.yml'),
    `extends:\n  - extra.yml\n${config}pre-push:\n  jobs:\n    - run: echo push\ncommit-msg:\n  jobs:\n    - run: grep -q needle {1} && echo commit-msg-saw-it\nlint:\n  jobs:\n    - run: echo lint\n`
  );
  install(main);
  assert.equal(readFileSync(shim, 'utf8'), custom);
  assert.deepEqual(readdirSync(join(main, '.githooks')).sort(), [
    'commit-msg',
    'post-merge',
    'pre-commit',
    'pre-push',
  ]);
  assert.deepEqual(readdirSync(join(main, 'node_modules', '.git-hooks')).sort(), [
    'commit-msg',
    'post-merge',
    'pre-commit',
    'pre-push',
  ]);
  assert.equal(
    readFileSync(join(main, '.githooks', 'pre-push'), 'utf8'),
    readFileSync(join(main, '.githooks', 'commit-msg'), 'utf8')
  );
  const run = commit(main, 'the needle');
  assert.equal(run.status, 0, run.output);
  assert.match(run.output, /custom-shim/);
  assert.match(run.output, /commit-msg-saw-it/);
});

test('without a top-level platform binary, as under pnpm, the hook runs node_modules/.bin/lefthook, and without either it asks for npm install', () => {
  const { main } = fixture();
  const platform = readdirSync(join(main, 'node_modules')).find((n) => n.startsWith('lefthook-'));
  const nested = join(main, 'node_modules', 'lefthook', 'node_modules');
  mkdirSync(nested);
  cpSync(join(main, 'node_modules', platform), join(nested, platform), { recursive: true });
  rmSync(join(main, 'node_modules', platform), { recursive: true });
  const run = commit(main, 'through .bin');
  assert.equal(run.status, 0, run.output);
  assert.match(run.output, /worktree-hook-ran/);
  assert.ok(run.output.includes(join(main, 'node_modules', '.bin', 'lefthook')), run.output);
  rmSync(join(main, 'node_modules', '.bin'), { recursive: true });
  refused(commit(main, 'no lefthook'), main, 'through .bin');
});

test('lefthook postinstall writes no hook anywhere once core.hooksPath is set', () => {
  const { main, a } = fixture();
  modules(a);
  const shim = readFileSync(join(main, '.githooks', 'pre-commit'), 'utf8');
  const run = spawnSync(process.execPath, [join(a, 'node_modules', 'lefthook', 'postinstall.js')], {
    cwd: a,
    encoding: 'utf8',
    env: env({ INIT_CWD: a }),
  });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.equal(existsSync(join(a, 'node_modules', '.git-hooks')), false);
  assert.equal(readFileSync(join(a, '.githooks', 'pre-commit'), 'utf8'), shim);
  untouched(a);
});

test('in worktrees of a bare repo, each commit runs its own hooks, and the repo stays bare', () => {
  const { base, main } = fixture();
  const bare = join(base, 'repo.git');
  ok(base, 'clone', '-q', '--bare', main, bare);
  const a = join(base, 'bare-a');
  const b = join(base, 'bare-b');
  ok(bare, 'worktree', 'add', '-q', '-b', 'bare-a', a);
  ok(bare, 'worktree', 'add', '-q', '-b', 'bare-b', b);
  modules(a);
  install(a);
  refused(commit(b, 'b before install'), b, 'init');
  modules(b);
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
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'slicc-worktree-hooks-old-')));
  dirs.push(base);
  const old = join(base, 'old-install-hooks.sh');
  writeFileSync(old, oldInstaller);
  const main = join(base, 'main');
  mkdirSync(main);
  writeFileSync(join(main, '.gitignore'), 'node_modules/\n');
  writeFileSync(join(main, 'lefthook.yml'), config);
  writeFileSync(join(main, 'README.md'), '# fixture\n');
  initFixtureRepo(main);
  commitAll(main, 'init');
  const a = join(base, 'a');
  const b = join(base, 'b');
  ok(main, 'worktree', 'add', '-q', '-b', 'a', a);
  ok(main, 'worktree', 'add', '-q', '-b', 'b', b);
  for (const dir of [main, a, b]) {
    modules(dir);
    install(dir, old);
  }
  assert.match(ok(a, 'config', '--worktree', 'core.hooksPath'), /worktree-hooks$/);

  install(a);
  install(a);
  const gitDir = ok(a, 'rev-parse', '--path-format=absolute', '--git-dir');
  assert.equal(
    git(a, ['config', '--file', join(gitDir, 'config.worktree'), '--get-all', 'core.hooksPath'])
      .status,
    1
  );
  assert.equal(ok(a, 'config', '--get-all', 'core.hooksPath'), '.githooks');
  assert.equal(ok(a, 'config', 'extensions.worktreeConfig'), 'true');
  assert.equal(
    ok(main, 'config', '--file', join(main, '.git', 'config.worktree'), 'core.bare'),
    'false'
  );
  ranWith(commit(a, 'a after migration'), a, [b, main]);
  ranWith(commit(b, 'b still on its old hooks'), b, [a, main]);
  ranWith(commit(main, 'main still on its old hooks'), main, [a, b]);
});

test('it succeeds whatever core.hooksPath is already set, shared or per worktree', () => {
  const { base, main, a } = fixture();
  modules(a);
  for (const value of ['/elsewhere/hooks', 'node_modules/.git-hooks', '.githooks']) {
    ok(main, 'config', 'core.hooksPath', value);
    install(a);
    assert.equal(ok(a, 'config', '--get-all', 'core.hooksPath'), '.githooks');
  }
  ok(main, 'config', 'extensions.worktreeConfig', 'true');
  ok(a, 'config', '--worktree', 'core.hooksPath', join(base, 'other', 'worktree-hooks'));
  install(a);
  assert.equal(ok(a, 'config', '--get-all', 'core.hooksPath'), '.githooks');
  ranWith(commit(a, 'a'), a, [main]);
});

test('outside a git checkout it does nothing and exits 0', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'slicc-worktree-hooks-none-')));
  dirs.push(dir);
  const run = spawnSync(runner(installer), [installer], {
    cwd: dir,
    encoding: 'utf8',
    env: env(),
  });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.equal(run.stdout + run.stderr, '');
  assert.deepEqual(readdirSync(dir), []);
});

test('a package in a subdirectory gets its shims and hooks under its own directory', () => {
  const { main, a } = fixture();
  const pkg = join(main, 'pkg');
  mkdirSync(pkg);
  modules(pkg);
  install(pkg);
  assert.equal(ok(main, 'config', 'core.hooksPath'), 'pkg/.githooks');
  assert.ok(existsSync(join(pkg, '.githooks', 'pre-commit')));
  assert.ok(existsSync(join(pkg, 'node_modules', '.git-hooks', 'pre-commit')));
  ranWith(commit(main, 'from the root'), pkg, [a]);
  assert.equal(git(main, ['config', '--get', 'extensions.worktreeConfig']).status, 1);
});

test('on Windows it does nothing and exits 0, leaving git config and the checkout untouched', () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'slicc-worktree-hooks-win32-')));
  dirs.push(base);
  const preload = join(base, 'win32.mjs');
  writeFileSync(
    preload,
    "Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });\n"
  );
  const main = join(base, 'main');
  mkdirSync(main);
  writeFileSync(join(main, 'lefthook.yml'), config);
  ok(main, 'init', '-q');
  modules(main);
  const config0 = readFileSync(join(main, '.git', 'config'), 'utf8');
  const run = spawnSync(process.execPath, ['--import', preload, installer], {
    cwd: main,
    encoding: 'utf8',
    env: env({ PATH: `${join(main, 'node_modules', '.bin')}:${path}` }),
  });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.equal(run.stdout + run.stderr, '');
  assert.equal(readFileSync(join(main, '.git', 'config'), 'utf8'), config0);
  assert.equal(git(main, ['config', '--get-all', 'core.hooksPath']).status, 1);
  assert.equal(existsSync(join(main, '.githooks')), false);
  assert.equal(existsSync(join(main, 'node_modules', '.git-hooks')), false);
});
