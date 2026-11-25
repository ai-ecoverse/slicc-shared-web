import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { steps } from './pipeline-steps.mjs';

const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const reviewer = steps('reviewer');
const promptPath = '${{ runner.temp }}/review/prompt.txt';

function render() {
  const step = reviewer.find((entry) => entry.name === 'Prompt');
  assert.ok(step, 'no Prompt step');
  const temp = mkdtempSync(join(tmpdir(), 'pipeline-prompt-'));
  dirs.push(temp);
  const result = spawnSync('bash', ['-eo', 'pipefail', '-c', step.run], {
    env: {
      PATH: process.env.PATH,
      RUNNER_TEMP: temp,
      DISPLAY: ':99',
      REPO: 'ai-ecoverse/example',
      PR: '7',
      STAGING_URL: '',
      EXTRA: '',
      SHOTS: '30',
      ARTIFACTS: '',
    },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return readFileSync(join(temp, 'review/prompt.txt'), 'utf8');
}

test('the rendered prompt keeps a private-fix summary to what the change does', () => {
  const prompt = render();
  const rule = prompt.split('\n').find((line) => line.includes('private-fix'));
  assert.ok(rule, prompt);
  assert.match(rule, /If one of pr\.json's labels is exactly private-fix,/);
  assert.match(
    rule,
    /the summary says only what the change does, never what was exposed or broken before it/
  );
  assert.match(rule, /no exploit steps or reproduction detail/);
  assert.match(rule, /Report every finding in full/);
  const summary = prompt.indexOf('- summary: ');
  assert.ok(summary >= 0 && summary < prompt.indexOf(rule), 'the rule follows the summary line');
  assert.ok(
    prompt.indexOf(rule) < prompt.indexOf('- comments: '),
    'the rule stays with the summary'
  );
  assert.doesNotMatch(prompt.replace(rule, ''), /private/);
});

test('claude and codex, first run and retry, all read the one rendered prompt', () => {
  const writers = reviewer.filter((step) => step.run?.includes('review/prompt.txt'));
  assert.deepEqual(
    writers.map((step) => step.name),
    ['Prompt']
  );
  const claude = reviewer.filter((step) => step.uses?.startsWith('anthropics/claude-code-action@'));
  const codex = reviewer.filter((step) => step.uses?.startsWith('openai/codex-action@'));
  assert.deepEqual(
    claude.map((step) => step.id),
    ['claude', 'claude-retry']
  );
  assert.deepEqual(
    codex.map((step) => step.id),
    ['codex', 'codex-retry']
  );
  for (const step of claude) {
    assert.equal(step.with.prompt, `Follow the instructions in ${promptPath}.`, step.id);
    assert.equal(step.with.prompt_file, undefined, step.id);
  }
  for (const step of codex) {
    assert.equal(step.with['prompt-file'], promptPath, step.id);
    assert.equal(step.with.prompt, undefined, step.id);
  }
});
