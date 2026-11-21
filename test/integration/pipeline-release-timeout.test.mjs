import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const text = readFileSync(`${root}/.github/workflows/pipeline.yml`, 'utf8');
const release =
  '${{ inputs.release-timeout-minutes > 0 && inputs.release-timeout-minutes || inputs.timeout-minutes }}';

function jobs() {
  const body = text.slice(text.indexOf('\njobs:\n'));
  const found = {};
  let current;
  for (const line of body.split('\n')) {
    const job = /^ {2}([a-z-]+):\s*$/.exec(line);
    if (job) {
      current = job[1];
      found[current] = [];
    } else if (current) {
      found[current].push(line);
    }
  }
  return found;
}

const timeout = (lines) =>
  lines.map((line) => /^ {4}timeout-minutes:\s*(.+?)\s*$/.exec(line)?.[1]).find(Boolean);

function input(name) {
  const at = text.indexOf(`\n      ${name}:\n`);
  assert.ok(at >= 0 && at < text.indexOf('\njobs:\n'), `no ${name} input`);
  const lines = text
    .slice(at + 1)
    .split('\n')
    .slice(1);
  const fields = {};
  for (const line of lines) {
    const entry = /^ {8}([a-z-]+): (.*)$/.exec(line);
    if (!entry) break;
    fields[entry[1]] = entry[2];
  }
  return fields;
}

function tokens(source) {
  const list = [];
  const pattern = /\s*(\|\||&&|>=|<=|==|!=|>|<|\(|\)|\d+|[A-Za-z_][\w.-]*)/y;
  let at = 0;
  while (at < source.length) {
    pattern.lastIndex = at;
    const match = pattern.exec(source);
    if (!match) {
      assert.equal(source.slice(at).trim(), '', `cannot read ${source.slice(at)}`);
      break;
    }
    list.push(match[1]);
    at = pattern.lastIndex;
  }
  return list;
}

function evaluate(expression, inputs) {
  const body = /^\$\{\{\s*(.*?)\s*\}\}$/.exec(expression)?.[1];
  assert.ok(body, expression);
  const list = tokens(body);
  let at = 0;
  const truthy = (value) =>
    !(value === 0 || value === '' || value === null || value === false || Number.isNaN(value));
  const primary = () => {
    const token = list[at++];
    if (token === '(') {
      const value = or();
      assert.equal(list[at++], ')');
      return value;
    }
    if (/^\d+$/.test(token)) return Number(token);
    const name = /^inputs\.(.+)$/.exec(token)?.[1];
    assert.ok(name, `unexpected ${token}`);
    return inputs[name] ?? null;
  };
  const compare = () => {
    const left = primary();
    const op = list[at];
    const ops = {
      '>': (a, b) => a > b,
      '<': (a, b) => a < b,
      '>=': (a, b) => a >= b,
      '<=': (a, b) => a <= b,
      '==': (a, b) => a === b,
      '!=': (a, b) => a !== b,
    };
    if (!ops[op]) return left;
    at++;
    return ops[op](Number(left), Number(primary()));
  };
  const and = () => {
    let value = compare();
    while (list[at] === '&&') {
      at++;
      const right = compare();
      value = truthy(value) ? right : value;
    }
    return value;
  };
  const or = () => {
    let value = and();
    while (list[at] === '||') {
      at++;
      const right = and();
      value = truthy(value) ? value : right;
    }
    return value;
  };
  const value = or();
  assert.equal(at, list.length, `trailing ${list.slice(at).join(' ')}`);
  return value;
}

test('release-timeout-minutes is a number input that defaults to 0', () => {
  assert.deepEqual(input('release-timeout-minutes'), { type: 'number', default: '0' });
  assert.deepEqual(input('timeout-minutes'), { type: 'number', default: '20' });
});

test('release takes release-timeout-minutes when above 0, else timeout-minutes', () => {
  assert.equal(timeout(jobs().release), release);
});

test('every other job keeps its own timeout', () => {
  const all = jobs();
  const expected = {
    lint: '${{ inputs.timeout-minutes }}',
    deploy: '${{ inputs.timeout-minutes }}',
    test: '${{ inputs.timeout-minutes }}',
    windows: '${{ inputs.timeout-minutes }}',
    flaky: '${{ inputs.timeout-minutes }}',
    downloads: '${{ inputs.timeout-minutes }}',
    reviewer: '${{ inputs.review-timeout-minutes }}',
  };
  for (const [name, lines] of Object.entries(all)) {
    if (name === 'release') continue;
    assert.equal(timeout(lines), expected[name], name);
  }
  assert.equal(text.split('release-timeout-minutes').length - 1, 3);
});

test('the release timeout evaluates as Actions would', () => {
  const expression = timeout(jobs().release);
  const fallback = Number(input('release-timeout-minutes').default);
  const cases = [
    [{ 'timeout-minutes': 45 }, 45],
    [{ 'release-timeout-minutes': 0, 'timeout-minutes': 45 }, 45],
    [{ 'release-timeout-minutes': 100, 'timeout-minutes': 45 }, 100],
    [{ 'release-timeout-minutes': 0, 'timeout-minutes': 20 }, 20],
  ];
  for (const [given, minutes] of cases) {
    const inputs = { 'release-timeout-minutes': fallback, ...given };
    assert.equal(evaluate(expression, inputs), minutes, JSON.stringify(given));
  }
});
