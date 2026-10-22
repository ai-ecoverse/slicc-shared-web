import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const workflow = readFileSync(
  new URL('../../.github/workflows/pipeline.yml', import.meta.url),
  'utf8'
);
const start = workflow.indexOf('\n  reviewer:\n');
const reviewer = workflow.slice(start, workflow.indexOf('\n  post:\n', start));
const version = reviewer.match(
  /\n {6}# renovate: datasource=npm depName=@anthropic-ai\/claude-code\n {6}CLAUDE_VERSION: (\d+\.\d+\.\d+)\n/
)?.[1];
const step = reviewer
  .match(/\n {8}name: Claude Code\n {8}run: \|\n((?: {10}.*\n)+)/)?.[1]
  .replace(/^ {10}/gm, '');

function install(t, failures) {
  const dir = mkdtempSync(join(tmpdir(), 'slicc-claude-install-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'bin');
  const calls = join(dir, 'calls');
  const sleeps = join(dir, 'sleeps');
  spawnSync('mkdir', ['-p', bin]);
  writeFileSync(calls, '');
  writeFileSync(sleeps, '');
  writeFileSync(
    join(bin, 'npm'),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\nif [ "$(wc -l < '${calls}')" -le ${failures} ]; then echo 'npm error 429 Too Many Requests' >&2; exit 1; fi\nmkdir -p "$RUNNER_TEMP/claude-code/node_modules/.bin"\nfor last; do :; done\nprintf '#!/bin/sh\\necho "%s (Claude Code)"\\n' "\${last##*@}" > "$RUNNER_TEMP/claude-code/node_modules/.bin/claude"\nchmod +x "$RUNNER_TEMP/claude-code/node_modules/.bin/claude"\n`
  );
  writeFileSync(join(bin, 'sleep'), `#!/bin/sh\necho "$1" >> '${sleeps}'\n`);
  chmodSync(join(bin, 'npm'), 0o755);
  chmodSync(join(bin, 'sleep'), 0o755);
  const result = spawnSync('bash', ['-e', '-c', step], {
    encoding: 'utf8',
    env: { PATH: `${bin}:${process.env.PATH}`, RUNNER_TEMP: dir, CLAUDE_VERSION: version },
  });
  const lines = (file) => readFileSync(file, 'utf8').split('\n').filter(Boolean);
  return { result, calls: lines(calls), sleeps: lines(sleeps), dir };
}

test('the reviewer pins Claude Code for Renovate and hands the action the executable it installed', () => {
  assert.ok(version, 'CLAUDE_VERSION with a renovate annotation in the reviewer job');
  assert.ok(step, 'a Claude Code install step in the reviewer job');
  assert.match(
    reviewer,
    /uses: actions\/cache@[0-9a-f]{40}\n {8}with:\n {10}path: \$\{\{ runner\.temp \}\}\/claude-npm\n {10}key: claude-code-\$\{\{ runner\.os \}\}-\$\{\{ runner\.arch \}\}-\$\{\{ env\.CLAUDE_VERSION \}\}\n/
  );
  const action = reviewer.slice(reviewer.indexOf('uses: anthropics/claude-code-action@'));
  assert.match(
    action,
    /\n {10}path_to_claude_code_executable: \$\{\{ runner\.temp \}\}\/claude-code\/node_modules\/\.bin\/claude\n/
  );
  assert.ok(reviewer.indexOf('name: Claude Code') < reviewer.indexOf('claude-code-action@'));
});

test('a rate-limited npm registry is retried with backoff until the pinned Claude Code installs', (t) => {
  const { result, calls, sleeps } = install(t, 3);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(calls.length, 4);
  for (const call of calls) {
    assert.match(call, new RegExp(`@anthropic-ai/claude-code@${version.replaceAll('.', '\\.')}$`));
    assert.match(call, /--cache \S+\/claude-npm /);
    assert.match(call, /--prefer-offline/);
  }
  assert.deepEqual(sleeps, ['30', '60', '120']);
  assert.match(result.stdout, new RegExp(`${version.replaceAll('.', '\\.')} \\(Claude Code\\)`));
  assert.match(result.stdout, /::warning title=Claude Code::.*attempt 3 of 5/);
});

test('the install fails the step after five failed attempts', (t) => {
  const { result, calls, sleeps } = install(t, 9);
  assert.equal(result.status, 1);
  assert.equal(calls.length, 5);
  assert.deepEqual(sleeps, ['30', '60', '120', '240']);
});
