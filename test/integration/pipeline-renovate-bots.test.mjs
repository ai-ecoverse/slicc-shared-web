import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { job, steps } from './pipeline-steps.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const text = readFileSync(join(root, '.github/workflows/pipeline.yml'), 'utf8');
const lint = steps('lint');
const reviewer = steps('reviewer');
const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const named = (list, id) => {
  const found = list.find((step) => step.id === id);
  assert.ok(found, `no ${id} step`);
  return found;
};

function run(step, env) {
  const dir = mkdtempSync(join(tmpdir(), 'slicc-renovate-bots-'));
  dirs.push(dir);
  const output = join(dir, 'output');
  const result = spawnSync('bash', ['-e', '-c', `: > "$GITHUB_OUTPUT"\n${step.run}`], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, GITHUB_OUTPUT: output, ...env },
  });
  const outputs = {};
  for (const line of readFileSync(output, 'utf8').split('\n').filter(Boolean)) {
    const at = line.indexOf('=');
    outputs[line.slice(0, at)] = line.slice(at + 1);
  }
  return { status: result.status, stdout: result.stdout, outputs };
}

const bots = (input) => run(named(lint, 'bots'), { BOTS: input });

const lintOutputs = Object.fromEntries(
  [...job('lint').matchAll(/^ {6}([\w-]+): (\$\{\{ .+ \}\})$/gm)].map(([, key, value]) => [
    key,
    value,
  ])
);

function resolve(expression, computed) {
  const fromLint = /^\$\{\{ needs\.lint\.outputs\.([\w-]+) \}\}$/.exec(expression);
  const inner = fromLint ? lintOutputs[fromLint[1]] : expression;
  assert.ok(inner, `${expression} names no lint output`);
  const fromStep = /^\$\{\{ steps\.bots\.outputs\.(\w+) \}\}$/.exec(inner);
  assert.ok(fromStep, `${expression} does not come from the bots step`);
  return computed[fromStep[1]];
}

function gate({ input = '', sender, author = 'renovate[bot]', branch, groups = '' }) {
  const computed = bots(input);
  assert.equal(computed.status, 0, computed.stdout);
  const step = named(lint, 'review');
  const env = {
    EVENT: 'pull_request',
    BRANCH: branch,
    AUTHOR: author,
    SENDER: sender,
    RENOVATE_GROUPS: groups,
  };
  for (const [key, value] of Object.entries(step.env))
    if (value.includes('steps.bots.outputs')) env[key] = resolve(value, computed.outputs);
  const result = run(step, env);
  assert.equal(result.status, 0, result.stdout);
  return result.outputs.review;
}

const refresh = 'homescoop-renovate-refresh';

test('renovate-bots is a string input that defaults to empty', () => {
  assert.match(text, /\n {6}renovate-bots:\n {8}type: string\n {8}default: ''\n/);
});

test('the validator strips [bot], lowercases, dedupes and accepts newlines and commas', () => {
  const result = bots(` ${refresh}[bot]\n\nOther-App , other-app[bot],renovate\n`);
  assert.equal(result.status, 0, result.stdout);
  assert.deepEqual(result.outputs, {
    bots: `${refresh},other-app`,
    claude: `renovate[bot],${refresh}[bot],other-app[bot]`,
    codex: `renovate,${refresh},other-app`,
  });
});

test('an empty input lists no extra bots', () => {
  for (const input of ['', ' \n , \n']) {
    const result = bots(input);
    assert.equal(result.status, 0, result.stdout);
    assert.deepEqual(result.outputs, { bots: '', claude: 'renovate[bot]', codex: 'renovate' });
  }
});

test('the validator fails on wildcards and anything that is not a plain login', () => {
  for (const input of [
    '*',
    '*[bot]',
    `${refresh}*`,
    'homescoop-*',
    '-leading',
    'two words',
    'a/b',
    'x[bot][bot]',
    '[bot]',
    `${refresh}\n?`,
  ]) {
    const result = bots(input);
    assert.notEqual(result.status, 0, `${JSON.stringify(input)} passed`);
    assert.match(result.stdout, /::error title=renovate-bots::.*not a bot login/);
    assert.deepEqual(result.outputs, {}, `${JSON.stringify(input)} wrote outputs`);
  }
});

test("renovate[bot]'s own push to its branch skips review outside review-renovate", () => {
  assert.equal(gate({ sender: 'renovate[bot]', branch: 'renovate/vim' }), 'false');
  assert.equal(gate({ input: refresh, sender: 'renovate[bot]', branch: 'renovate/vim' }), 'false');
});

test("a listed bot's push to a Renovate branch counts as Renovate's", () => {
  for (const input of [refresh, `${refresh}[bot]`, `other\n${refresh}`, `other,${refresh}[bot]`])
    assert.equal(
      gate({ input, sender: `${refresh}[bot]`, branch: 'renovate/vim' }),
      'false',
      input
    );
});

test("an unlisted bot's push to a Renovate branch gets a review", () => {
  assert.equal(gate({ sender: `${refresh}[bot]`, branch: 'renovate/vim' }), 'true');
  assert.equal(
    gate({ input: 'other-app', sender: `${refresh}[bot]`, branch: 'renovate/vim' }),
    'true'
  );
  assert.equal(gate({ input: refresh, sender: refresh, branch: 'renovate/vim' }), 'true');
});

test('a listed bot pushing outside a Renovate branch or to another author is not Renovate', () => {
  assert.equal(gate({ input: refresh, sender: `${refresh}[bot]`, branch: 'refresh/vim' }), 'true');
  assert.equal(
    gate({ input: refresh, sender: `${refresh}[bot]`, branch: 'renovate/vim', author: 'someone' }),
    'true'
  );
  assert.equal(
    gate({
      input: refresh,
      sender: `${refresh}[bot]`,
      branch: 'renovate/vim',
      author: `${refresh}[bot]`,
    }),
    'true'
  );
});

test('a listed bot on a group that matches review-renovate still gets a review', () => {
  const groups = 'kernel-and-pnpm\nvim*';
  assert.equal(
    gate({ input: refresh, sender: `${refresh}[bot]`, branch: 'renovate/major-vim', groups }),
    'true'
  );
  assert.equal(
    gate({ input: refresh, sender: `${refresh}[bot]`, branch: 'renovate/coreutils', groups }),
    'false'
  );
  assert.equal(
    gate({ sender: 'renovate[bot]', branch: 'renovate/kernel-and-pnpm', groups }),
    'true'
  );
});

test('every reviewer step allows the listed bots, and only renovate without them', () => {
  const listed = bots(`${refresh}[bot]`).outputs;
  const empty = bots('').outputs;
  const claudes = reviewer.filter((step) =>
    step.uses?.startsWith('anthropics/claude-code-action@')
  );
  const codexes = reviewer.filter((step) => step.uses?.startsWith('openai/codex-action@'));
  assert.deepEqual(
    claudes.map((step) => step.id),
    ['claude', 'claude-retry']
  );
  assert.deepEqual(
    codexes.map((step) => step.id),
    ['codex', 'codex-retry']
  );
  for (const step of claudes) {
    assert.equal(resolve(step.with.allowed_bots, listed), `renovate[bot],${refresh}[bot]`);
    assert.equal(resolve(step.with.allowed_bots, empty), 'renovate[bot]');
  }
  for (const step of codexes) {
    assert.equal(resolve(step.with['allow-bot-users'], listed), `renovate,${refresh}`);
    assert.equal(resolve(step.with['allow-bot-users'], empty), 'renovate');
  }
});
