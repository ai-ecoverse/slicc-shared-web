import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { evaluate, job, simulate, steps } from './pipeline-steps.mjs';

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
const isOutcome = (step) => step.name?.startsWith('Codex') && step.env.ATTEMPT !== undefined;
const outcomeSteps = () => reviewer.filter(isOutcome);
const model = 'global.openai.gpt-6.1-sol';
const secret = 'SECRET-DIFF-DETAIL';

function outcome(lines, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'slicc-codex-outcome-'));
  dirs.push(dir);
  const sessions = join(dir, 'codex-home', 'sessions');
  if (lines !== undefined) {
    const day = join(sessions, '2026', '11', '13');
    mkdirSync(day, { recursive: true });
    const body =
      typeof lines === 'string' ? lines : lines.map((line) => JSON.stringify(line)).join('\n');
    writeFileSync(join(day, 'rollout-2026-11-13T20-09-31-01a1d687.jsonl'), `${body}\n`);
  }
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
      OUTCOME: 'failure',
      HAS_FINDINGS: 'false',
      ...env,
    },
  });
  return { ...run, left: existsSync(sessions) };
}

const event = (payload) => ({ timestamp: '2026-11-13T20:09:42.391Z', type: 'event_msg', payload });
const tokens = (total) =>
  event({
    type: 'token_count',
    info: {
      total_token_usage: { input_tokens: total - 367, output_tokens: 367, total_tokens: total },
    },
  });
const session = [
  {
    type: 'session_meta',
    payload: { id: '01a1d687', cwd: `/w/${secret}`, base_instructions: secret },
  },
  event({ type: 'task_started', turn_id: 't1', model_context_window: 258400 }),
  {
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: secret }] },
  },
  { type: 'response_item', payload: { type: 'reasoning', summary: [], encrypted_content: secret } },
  {
    type: 'response_item',
    payload: { type: 'function_call', name: 'exec_command', arguments: secret, call_id: 'c1' },
  },
  {
    type: 'response_item',
    payload: { type: 'function_call_output', call_id: 'c1', output: secret },
  },
  tokens(9000),
  tokens(21367),
];
const rejected = [
  ...session,
  event({
    type: 'task_complete',
    turn_id: 't1',
    last_agent_message: null,
    error: {
      message: JSON.stringify({
        error: {
          message: 'invalid encrypted view',
          type: 'invalid_request_error',
          param: null,
          code: 'validation_error',
        },
      }),
      codex_error_info: 'other',
    },
  }),
];

test('the outcome line carries the attempt, the API error type and code and the tokens, and removes the rollout', () => {
  const run = outcome(rejected);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stderr, '');
  assert.equal(
    run.stdout,
    `codex attempt 1, ${model}: outcome=failure findings=false turn_end=task_complete error_type=invalid_request_error error_code=validation_error codex_error=other tokens=21367\n`
  );
  assert.doesNotMatch(run.stdout, new RegExp(secret));
  assert.equal(run.left, false);
});

test('a verdict run shows no error and never the final message', () => {
  const run = outcome(
    [
      ...session,
      tokens(54902),
      event({
        type: 'task_complete',
        turn_id: 't1',
        last_agent_message: JSON.stringify({
          verdict: 'approved',
          summary: secret,
          comments: [],
          issues: [],
        }),
      }),
    ],
    { OUTCOME: 'success', HAS_FINDINGS: 'true' }
  );
  assert.equal(
    run.stdout,
    `codex attempt 1, ${model}: outcome=success findings=true turn_end=task_complete error_type=none error_code=none codex_error=none tokens=54902\n`
  );
});

test('a field that is not a plain word prints as ?, and an error that is not the API JSON prints none', () => {
  const odd = outcome([
    ...session,
    event({
      type: 'turn_aborted',
      reason: 'interrupted',
      error: {
        message: JSON.stringify({ error: { type: `type with ${secret}`, code: { secret } } }),
        codex_error_info: { response_stream_disconnected: { http_status_code: 502 } },
      },
    }),
  ]);
  assert.equal(odd.status, 0, odd.stderr);
  assert.equal(
    odd.stdout,
    `codex attempt 1, ${model}: outcome=failure findings=false turn_end=turn_aborted error_type=? error_code=? codex_error=response_stream_disconnected tokens=21367\n`
  );
  const prose = outcome([
    tokens(12),
    event({
      type: 'task_complete',
      error: { message: `stream disconnected: ${secret}`, codex_error_info: secret.repeat(5) },
    }),
  ]);
  assert.equal(
    prose.stdout,
    `codex attempt 1, ${model}: outcome=failure findings=false turn_end=task_complete error_type=none error_code=none codex_error=? tokens=12\n`
  );
  assert.doesNotMatch(odd.stdout + prose.stdout, new RegExp(secret));
});

test('a missing rollout, or one that is not JSON lines, says so and never prints the file', () => {
  const missing = outcome(undefined);
  assert.equal(missing.status, 0, missing.stderr);
  assert.equal(
    missing.stdout,
    `codex attempt 1, ${model}: outcome=failure findings=false, no session rollout\n`
  );
  const broken = outcome(
    `{"type":"event_msg","payload":{"type":"task_complete","error":{"message":"${secret}"\n${secret}`
  );
  assert.equal(broken.status, 0, broken.stderr);
  assert.equal(broken.stderr, '');
  assert.equal(
    broken.stdout,
    `codex attempt 1, ${model}: outcome=failure findings=false turn_end=none error_type=none error_code=none codex_error=none tokens=none\n`
  );
  assert.equal(broken.left, false);
});

test('each attempt gets the same outcome step, and nothing uploads the rollout', () => {
  const [first, second] = outcomeSteps();
  assert.equal(outcomeSteps().length, 2);
  assert.ok(first.run.includes('codex-home/sessions'));
  assert.equal(second.run, first.run);
  assert.deepEqual(
    [first.env, second.env],
    [
      {
        ATTEMPT: '1',
        MODEL: '${{ env.CODEX_MODEL }}',
        OUTCOME: '${{ steps.codex.outcome }}',
        HAS_FINDINGS: "${{ steps.codex.outputs.final-message != '' }}",
      },
      {
        ATTEMPT: '2',
        MODEL: '${{ env.CODEX_MODEL }}',
        OUTCOME: '${{ steps.codex-retry.outcome }}',
        HAS_FINDINGS: "${{ steps.codex-retry.outputs.final-message != '' }}",
      },
    ]
  );
  const order = reviewer.map((step) => (isOutcome(step) ? step.env.ATTEMPT : step.id));
  assert.equal(order.indexOf('1'), order.indexOf('codex') + 1);
  assert.equal(order.indexOf('2'), order.indexOf('codex-retry') + 1);
  assert.doesNotMatch(job('reviewer'), /path:[^\n]*(codex-home|rollout)/);
});

test('the retry runs the same action, inputs and model, and only the first attempt may fail', () => {
  const codex = byId('codex');
  const retry = byId('codex-retry');
  assert.match(
    job('reviewer'),
    /\n {4}env:\n(?: {6}[A-Z_]+: .*\n)* {6}CODEX_MODEL: \$\{\{ vars\.CODEX_BEDROCK_MODEL \|\| 'global\.openai\.gpt-6\.1-sol' \}\}\n/
  );
  assert.match(codex.uses, /^openai\/codex-action@[0-9a-f]{40}$/);
  assert.equal(retry.uses, codex.uses);
  assert.deepEqual(retry.env, codex.env);
  assert.deepEqual(retry.with, codex.with);
  assert.equal(codex.with.model, '${{ env.CODEX_MODEL }}');
  assert.equal(codex.with['codex-home'], '${{ runner.temp }}/codex-home');
  assert.equal(codex.with['output-file'], undefined);
  assert.equal(codex.continueOnError, true);
  assert.equal(retry.continueOnError, false);
  assert.deepEqual(
    reviewer.filter((step) => step.continueOnError).map((step) => step.id),
    ['claude', 'codex']
  );
});

test('a verdict on the first attempt skips the retry', () => {
  const run = simulate(reviewer, 'codex', ['approved']);
  assert.deepEqual(run.ran.slice(0, 3), ['Codex on Bedrock', 'codex', 'Codex outcome']);
  assert.ok(!run.ran.includes('codex-retry'));
  assert.ok(!run.ran.includes('Codex retry outcome'));
  assert.deepEqual(run.logged, [
    { ATTEMPT: '1', MODEL: '', OUTCOME: 'success', HAS_FINDINGS: 'true' },
  ]);
  assert.equal(JSON.parse(run.findings).verdict, 'approved');
  assert.equal(run.failed, false);
});

test('a failed first attempt, or one without a message, reruns once and takes the retry verdict', () => {
  for (const first of [undefined, '']) {
    const run = simulate(reviewer, 'codex', [first, 'denied']);
    assert.deepEqual(run.ran.slice(0, 5), [
      'Codex on Bedrock',
      'codex',
      'Codex outcome',
      'codex-retry',
      'Codex retry outcome',
    ]);
    assert.deepEqual(
      run.logged.map(({ ATTEMPT, OUTCOME, HAS_FINDINGS }) => [ATTEMPT, OUTCOME, HAS_FINDINGS]),
      [
        ['1', first === undefined ? 'failure' : 'success', 'false'],
        ['2', 'success', 'true'],
      ]
    );
    assert.equal(JSON.parse(run.findings).verdict, 'denied');
    assert.equal(run.failed, false);
    assert.equal(run.left, 0);
  }
});

test('no verdict from either attempt fails the job as before, and findings.json stays unwritten', () => {
  const run = simulate(reviewer, 'codex', [undefined, undefined]);
  assert.deepEqual(run.ran.slice(0, 5), [
    'Codex on Bedrock',
    'codex',
    'Codex outcome',
    'codex-retry',
    'Codex retry outcome',
  ]);
  assert.deepEqual(
    run.logged.map(({ OUTCOME }) => OUTCOME),
    ['failure', 'failure']
  );
  assert.equal(run.findings, undefined);
  assert.equal(run.failed, true);
  assert.ok(run.ran.some((label) => label.startsWith('actions/upload-artifact@')));
  const silent = simulate(reviewer, 'codex', [undefined, '']);
  assert.equal(silent.failed, false);
  assert.equal(silent.findings, '');
});

test('the Claude and Codex paths do not run or read each other', () => {
  const codex = simulate(reviewer, 'codex', [undefined, 'approved']);
  assert.ok(!codex.ran.some((label) => /^(claude|Claude)/.test(label)));
  assert.equal(JSON.parse(codex.findings).verdict, 'approved');
  const claude = simulate(reviewer, 'claude', [undefined, 'denied']);
  assert.ok(!claude.ran.some((label) => /^(codex|Codex)/.test(label)));
  assert.deepEqual(
    claude.logged.map(({ ATTEMPT }) => ATTEMPT),
    ['1', '2']
  );
  assert.equal(JSON.parse(claude.findings).verdict, 'denied');
  const retry = byId('codex-retry');
  const when = (agent, steps) => evaluate(retry.if, { matrix: { agent }, steps, failed: false });
  const answered = { outcome: 'success', outputs: { 'final-message': '{"verdict":"approved"}' } };
  const failed = { outcome: 'failure', outputs: {} };
  assert.equal(when('codex', { codex: answered, claude: failed, 'claude-retry': failed }), false);
  assert.equal(when('codex', { codex: failed, claude: answered }), true);
  assert.equal(
    when('claude', { codex: { outcome: 'skipped', outputs: {} }, claude: failed }),
    false
  );
  assert.equal(when('codex', { codex: { outcome: 'success', outputs: {} } }), true);
  assert.equal(evaluate(retry.if, { matrix: { agent: 'codex' }, steps: {}, failed: true }), false);
  for (const step of reviewer.filter((entry) =>
    /^(codex|Codex)/.test(entry.id ?? entry.name ?? '')
  ))
    assert.doesNotMatch(step.raw, /claude/i);
  for (const step of reviewer.filter((entry) =>
    /^(claude|Claude)/.test(entry.id ?? entry.name ?? '')
  ))
    assert.doesNotMatch(step.raw, /codex/i);
});
