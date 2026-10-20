import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  accessSync,
  constants,
  cpSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const snippet = readFileSync(join(repo, 'README.md'), 'utf8').match(
  /```yaml\n(assert_lefthook_installed: true\n[\s\S]*?)```/
)[1];

const which = (command) =>
  spawnSync('sh', ['-c', `command -v ${command}`], { encoding: 'utf8' }).stdout.trim();

const executable = (file) => {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const path = [
  ...new Set([process.execPath, which('git'), which('sh')].map((file) => dirname(file))),
]
  .filter((dir) => !executable(join(dir, 'lefthook')))
  .join(delimiter);

function env(extra = {}) {
  const clean = { ...process.env, PATH: path, ...extra };
  for (const key of Object.keys(clean)) {
    if (key.startsWith('LEFTHOOK') && !(key in extra)) delete clean[key];
    if (key.startsWith('GIT_')) delete clean[key];
  }
  return clean;
}

function git(dir, args, extra) {
  return spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: env(extra),
  });
}

function ok(dir, ...args) {
  const run = git(dir, args);
  assert.equal(run.status, 0, run.stderr);
  return run.stdout;
}

function commit(dir, line, extra) {
  writeFileSync(join(dir, 'README.md'), `# fixture\n${line}\n`);
  ok(dir, 'add', 'README.md');
  const run = git(dir, ['commit', '-m', line], extra);
  return { ...run, output: `${run.stdout}\n${run.stderr}` };
}

async function fixture(config = snippet) {
  const base = realpathSync(await mkdtemp(join(tmpdir(), 'slicc-lefthook-')));
  dirs.push(base);
  const main = join(base, 'main');
  mkdirSync(join(main, 'node_modules', '@ai-ecoverse'), { recursive: true });
  writeFileSync(join(main, '.gitignore'), 'node_modules/\n');
  writeFileSync(join(main, 'lefthook.yml'), config);
  writeFileSync(join(main, 'README.md'), '# fixture\n');
  symlinkSync(repo, join(main, 'node_modules', '@ai-ecoverse', 'slicc-shared-web'));
  for (const name of readdirSync(join(repo, 'node_modules'))) {
    if (name === 'lefthook' || name.startsWith('lefthook-')) {
      cpSync(join(repo, 'node_modules', name), join(main, 'node_modules', name), {
        recursive: true,
      });
    }
  }
  ok(main, 'init', '-q');
  ok(main, 'add', '-A');
  ok(main, 'commit', '-qm', 'init', '--no-verify');
  const install = spawnSync(
    process.execPath,
    [join(main, 'node_modules', 'lefthook', 'bin', 'index.js'), 'install'],
    { cwd: main, encoding: 'utf8', env: env() }
  );
  assert.equal(install.status, 0, install.stdout + install.stderr);
  const worktree = join(base, 'worktree');
  ok(main, 'worktree', 'add', '-q', worktree);
  return { main, worktree };
}

const shared = 'biome,typecheck,no comments,no unit tests in git,AGENTS.md,diff coverage';

test('a worktree without node_modules fails the commit, with run npm install while lefthook is reachable and lefthook abort once it is not', async () => {
  const { main, worktree } = await fixture();
  assert.ok(path.length > 0);

  const missing = commit(worktree, 'no node_modules here');
  assert.notEqual(missing.status, 0, missing.output);
  assert.match(
    missing.output,
    /slicc-shared-web is not installed in this worktree, so its hooks cannot run: run npm install/
  );
  assert.equal(ok(worktree, 'log', '-1', '--format=%s').trim(), 'init');

  symlinkSync(join(main, 'node_modules'), join(worktree, 'node_modules'));
  const installed = commit(worktree, 'installed', { LEFTHOOK_EXCLUDE: shared });
  assert.equal(installed.status, 0, installed.output);
  assert.match(installed.output, /shared hooks/);
  rmSync(join(worktree, 'node_modules'));

  rmSync(join(main, 'node_modules'), { recursive: true, force: true });
  const gone = commit(worktree, 'no lefthook anywhere');
  assert.notEqual(gone.status, 0, gone.output);
  assert.match(gone.output, /Can't find lefthook in PATH/);
  assert.match(gone.output, /Operation is aborted due to lefthook settings/);
  assert.equal(ok(worktree, 'log', '-1', '--format=%s').trim(), 'installed');
});

test('the shared config alone makes the hook exit 1 when no lefthook can be found', async () => {
  const { main, worktree } = await fixture(
    'extends:\n  - node_modules/@ai-ecoverse/slicc-shared-web/lefthook.yml\n'
  );
  rmSync(join(main, 'node_modules'), { recursive: true, force: true });
  const gone = commit(worktree, 'no lefthook anywhere');
  assert.notEqual(gone.status, 0, gone.output);
  assert.match(gone.output, /Can't find lefthook in PATH/);
  assert.equal(ok(worktree, 'log', '-1', '--format=%s').trim(), 'init');
});
