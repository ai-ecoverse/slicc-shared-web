import { spawnSync } from 'node:child_process';

function git(dir, ...args) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  const run = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env });
  if (run.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${dir}: ${run.error?.message ?? run.stderr}`);
  }
}

export function initFixtureRepo(dir, { hooks = true } = {}) {
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.name', 'slicc-fixture');
  git(dir, 'config', 'user.email', 'fixture@slicc.invalid');
  git(dir, 'config', 'commit.gpgsign', 'false');
  if (!hooks) git(dir, 'config', 'core.hooksPath', '/dev/null');
}

export function commitAll(dir, message) {
  git(dir, 'add', '-A', '--', ':/');
  git(dir, 'commit', '-q', '--allow-empty', '-m', message);
}
