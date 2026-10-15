import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const bin = join(repo, 'bin', 'slicc-lint-comments.sh');
const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

async function lint(files) {
  const dir = await mkdtemp(join(tmpdir(), 'slicc-lint-comments-'));
  dirs.push(dir);
  for (const [path, body] of Object.entries({ '.gitignore': 'node_modules\n', ...files })) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  const cache = join(repo, 'node_modules', '.cache');
  if (existsSync(cache)) cpSync(cache, join(dir, 'node_modules', '.cache'), { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: dir });
  spawnSync('git', ['add', '-A'], { cwd: dir });
  return spawnSync('sh', [bin], { cwd: dir, encoding: 'utf8' });
}

const workflow = (annotation) =>
  `on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    env:\n      ${annotation}\n      TOOL: 1.2.3\n    steps:\n      - run: echo "$TOOL"\n`;

test('a renovate annotation in a workflow or action file passes', async () => {
  const run = await lint({
    '.github/workflows/ci.yml': workflow(
      '# renovate: datasource=github-releases depName=rhysd/actionlint extractVersion=^v(?<version>.+)$'
    ),
    '.github/actions/setup/action.yml': workflow('# renovate: datasource=npm depName=@scope/pkg'),
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^ok: /);
});

test('any other comment in a workflow still fails', async () => {
  const run = await lint({ '.github/workflows/ci.yml': workflow('# bump this by hand') });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /ci\.yml:6: comment not allowed: # bump this by hand/);
});

test('a renovate comment without a datasource and depName fails', async () => {
  const run = await lint({ '.github/workflows/ci.yml': workflow('# renovate: keep this pinned') });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /comment not allowed: # renovate: keep this pinned/);
});

test('a renovate annotation outside workflow and action files fails', async () => {
  const run = await lint({ 'config.yml': workflow('# renovate: datasource=npm depName=pkg') });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /config\.yml:6: comment not allowed: # renovate:/);
});
