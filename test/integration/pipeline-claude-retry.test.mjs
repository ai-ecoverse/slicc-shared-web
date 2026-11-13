import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { evaluate, job, simulate as run, steps } from './pipeline-steps.mjs';

const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const reviewer = steps('reviewer');
const byId = (id) => {
  const found = reviewer.find((step) => step.id === id);
  assert.ok(found, `no step with id ${id} in reviewer`);
  return found;
};
const outcomeSteps = () => reviewer.filter((step) => step.name?.startsWith('Claude'));
const simulate = (agent, attempts) => run(reviewer, agent, attempts);

function outcome(transcript, model = 'global.anthropic.claude-opus-5-5') {
  const dir = mkdtempSync(join(tmpdir(), 'slicc-claude-outcome-'));
  dirs.push(dir);
  const file = join(dir, 'claude-execution-output.json');
  if (transcript !== undefined)
    writeFileSync(
      file,
      typeof transcript === 'string' ? transcript : JSON.stringify(transcript, null, 2)
    );
  const [first] = outcomeSteps();
  const run = spawnSync('bash', ['-eo', 'pipefail', '-c', first.run], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 30000,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      RUNNER_TEMP: dir,
      ATTEMPT: '1',
      MODEL: model,
    },
  });
  return { ...run, left: existsSync(file) };
}

const secret = 'SECRET-GUARD-BYPASS-DETAIL';
const refused = [
  {
    type: 'system',
    subtype: 'init',
    session_id: 's',
    model: 'global.anthropic.claude-opus-5-5',
    cwd: `/w/${secret}`,
  },
  {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: `review ${secret}` }] },
  },
  {
    type: 'assistant',
    error: 'invalid_request',
    message: {
      role: 'assistant',
      stop_reason: 'refusal',
      content: [{ type: 'text', text: `I cannot ${secret}` }],
    },
  },
  {
    type: 'system',
    subtype: 'model_refusal_no_fallback',
    original_model: 'global.anthropic.claude-opus-5-5',
    api_refusal_category: 'cyber',
    api_refusal_explanation: `the diff ${secret}`,
    content: `refused ${secret}`,
  },
  {
    type: 'result',
    subtype: 'success',
    is_error: true,
    api_error_status: 400,
    duration_ms: 212000,
    num_turns: 1,
    result: `API Error: ${secret}`,
    stop_reason: 'refusal',
    terminal_reason: 'completed',
    total_cost_usd: 0.0091,
    errors: [secret],
    permission_denials: [{ tool_name: 'Bash', tool_input: { command: secret } }],
  },
];

test('the outcome line carries only the structural fields of the result, and removes the transcript', () => {
  const run = outcome(refused);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stderr, '');
  assert.equal(
    run.stdout,
    'claude attempt 1, global.anthropic.claude-opus-5-5: subtype=success is_error=true stop_reason=refusal num_turns=1 total_cost_usd=0.0091 terminal_reason=completed api_error_status=400 refusal=model_refusal_no_fallback:cyber error=invalid_request\n'
  );
  assert.doesNotMatch(run.stdout, new RegExp(secret));
  assert.equal(run.left, false);
});

test('the outcome line prints a field that is not a plain word as ?, never its text', () => {
  const run = outcome([
    {
      type: 'assistant',
      error: `prose with ${secret} in it`,
      message: { content: [{ type: 'text', text: secret }] },
    },
    {
      type: 'system',
      subtype: 'model_refusal_fallback',
      api_refusal_category: { nested: secret },
      api_refusal_explanation: secret,
    },
    {
      type: 'result',
      subtype: secret.repeat(4),
      is_error: `not a flag ${secret}`,
      stop_reason: `stop ${secret}`,
      num_turns: [secret],
      total_cost_usd: { secret },
      result: secret,
    },
  ]);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(
    run.stdout,
    'claude attempt 1, global.anthropic.claude-opus-5-5: subtype=? is_error=? stop_reason=? num_turns=? total_cost_usd=? terminal_reason=none api_error_status=none refusal=model_refusal_fallback:? error=?\n'
  );
  assert.doesNotMatch(run.stdout, new RegExp(secret));
});

test('a verdict run shows no refusal and no error', () => {
  const run = outcome([
    { type: 'assistant', message: { content: [{ type: 'text', text: secret }] } },
    {
      type: 'result',
      subtype: 'success',
      is_error: false,
      num_turns: 42,
      stop_reason: 'end_turn',
      total_cost_usd: 3.5,
      result: secret,
      structured_output: { verdict: 'denied', summary: secret, comments: [], issues: [] },
    },
  ]);
  assert.equal(
    run.stdout,
    'claude attempt 1, global.anthropic.claude-opus-5-5: subtype=success is_error=false stop_reason=end_turn num_turns=42 total_cost_usd=3.5 terminal_reason=none api_error_status=none refusal=none error=none\n'
  );
});

test('a missing transcript, or one that is not JSON, says so in the line and never prints the file', () => {
  const missing = outcome(undefined);
  assert.equal(missing.status, 0, missing.stderr);
  assert.equal(
    missing.stdout,
    'claude attempt 1, global.anthropic.claude-opus-5-5: no claude-execution-output.json\n'
  );
  const broken = outcome(`[{"type":"result","result":"${secret}"`);
  assert.equal(broken.status, 0, broken.stderr);
  assert.equal(broken.stderr, '');
  assert.equal(
    broken.stdout,
    'claude attempt 1, global.anthropic.claude-opus-5-5: claude-execution-output.json is not JSON\n'
  );
  assert.equal(broken.left, false);
  const empty = outcome([]);
  assert.match(
    empty.stdout,
    /: subtype=none is_error=none stop_reason=none num_turns=none .* refusal=none error=none\n$/
  );
});

test('each attempt gets the same outcome step, with its own number and model, and nothing uploads the transcript', () => {
  const [first, second] = outcomeSteps();
  assert.equal(outcomeSteps().length, 2);
  assert.ok(first.run.includes('claude-execution-output.json'));
  assert.equal(second.run, first.run);
  assert.deepEqual(
    [first.env, second.env],
    [
      { ATTEMPT: '1', MODEL: '${{ env.CLAUDE_MODEL }}' },
      { ATTEMPT: '2', MODEL: '${{ env.CLAUDE_FALLBACK_MODEL }}' },
    ]
  );
  const order = reviewer.map((step) =>
    step.name?.startsWith('Claude') ? step.env.ATTEMPT : step.id
  );
  assert.deepEqual(
    order.filter((id) => ['claude', '1', 'claude-retry', '2'].includes(id)),
    ['claude', '1', 'claude-retry', '2']
  );
  assert.equal(order.indexOf('1'), order.indexOf('claude') + 1);
  assert.equal(order.indexOf('2'), order.indexOf('claude-retry') + 1);
  assert.doesNotMatch(
    job('reviewer'),
    /path:[^\n]*claude-execution-output|show_full_output|execution_file/
  );
});

test('the retry runs the same action and arguments on the fallback model, and only the first attempt may fail', () => {
  const claude = byId('claude');
  const retry = byId('claude-retry');
  assert.match(
    job('reviewer'),
    /\n {4}env:\n {6}CLAUDE_MODEL: \$\{\{ vars\.CERT_BEDROCK_MODEL \|\| 'global\.anthropic\.claude-opus-5-5' \}\}\n {6}CLAUDE_FALLBACK_MODEL: \$\{\{ vars\.CERT_BEDROCK_FALLBACK_MODEL \|\| 'global\.anthropic\.claude-sonnet-5-5' \}\}\n/
  );
  assert.equal(retry.uses, claude.uses);
  assert.deepEqual(retry.env, claude.env);
  assert.deepEqual(retry.with, claude.with);
  assert.match(claude.claudeArgs, /^--model \$\{\{ env\.CLAUDE_MODEL \}\} /);
  assert.equal(
    retry.claudeArgs,
    claude.claudeArgs.replace('${{ env.CLAUDE_MODEL }}', '${{ env.CLAUDE_FALLBACK_MODEL }}')
  );
  assert.match(claude.claudeArgs, /--json-schema '\$\{\{ env\.FINDINGS_SCHEMA \}\}'$/);
  assert.equal(claude.continueOnError, true);
  assert.equal(retry.continueOnError, false);
  assert.deepEqual(
    reviewer
      .filter((step) => step.continueOnError && step.id.startsWith('claude'))
      .map((step) => step.id),
    ['claude']
  );
});

test('the retry runs only when the first attempt has no verdict, and findings.json takes whichever attempt had one', () => {
  const first = simulate('claude', ['approved']);
  assert.deepEqual(first.ran.slice(0, 2), ['claude', 'Claude outcome']);
  assert.ok(!first.ran.includes('claude-retry'));
  assert.ok(!first.ran.includes('Claude retry outcome'));
  assert.equal(JSON.parse(first.findings).verdict, 'approved');
  assert.equal(first.failed, false);

  const second = simulate('claude', [undefined, 'denied']);
  assert.deepEqual(second.ran.slice(0, 4), [
    'claude',
    'Claude outcome',
    'claude-retry',
    'Claude retry outcome',
  ]);
  assert.equal(JSON.parse(second.findings).verdict, 'denied');
  assert.equal(second.failed, false);
  assert.equal(second.left, 0);

  const none = simulate('claude', [undefined, undefined]);
  assert.deepEqual(none.ran.slice(0, 4), [
    'claude',
    'Claude outcome',
    'claude-retry',
    'Claude retry outcome',
  ]);
  assert.equal(none.findings, undefined);
  assert.equal(none.failed, true);
  assert.ok(none.ran.some((label) => label.startsWith('actions/upload-artifact@')));

  const codex = simulate('codex', ['approved']);
  assert.ok(!codex.ran.some((label) => /^(claude|Claude)/.test(label)));
  assert.equal(JSON.parse(codex.findings).verdict, 'approved');
  assert.equal(codex.failed, false);
});

test('the retry condition reads the first attempt as GitHub reports it', () => {
  const retry = byId('claude-retry');
  const when = (agent, outcome, output) =>
    evaluate(retry.if, {
      matrix: { agent },
      steps: { claude: { outcome, outputs: output ? { structured_output: output } : {} } },
      failed: false,
    });
  assert.equal(when('claude', 'success', '{"verdict":"approved"}'), false);
  assert.equal(when('claude', 'failure', undefined), true);
  assert.equal(when('claude', 'success', undefined), true);
  assert.equal(when('claude', 'failure', '{"verdict":"approved"}'), true);
  assert.equal(when('codex', 'skipped', undefined), false);
  assert.equal(evaluate(retry.if, { matrix: { agent: 'claude' }, steps: {}, failed: true }), false);
});
