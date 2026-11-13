import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const text = readFileSync(join(root, '.github/workflows/pipeline.yml'), 'utf8');

export function job(name) {
  const start = text.indexOf(`\n  ${name}:\n`);
  assert.ok(start >= 0, `no ${name} job`);
  const next = text.slice(start + 1).search(/\n {2}[a-z-]+:\n/);
  return text.slice(start, next < 0 ? undefined : start + 1 + next);
}

const field = (lines, key) => {
  const found = lines.map((line) => new RegExp(`^ {8}${key}: (.+)$`).exec(line)?.[1]).find(Boolean);
  if (found === undefined) return undefined;
  return /^'.*'$/.test(found) ? found.slice(1, -1).replace(/''/g, "'") : found;
};

function block(lines, key) {
  const at = lines.indexOf(`        ${key}:`);
  if (at < 0) return {};
  const map = {};
  for (const line of lines.slice(at + 1)) {
    if (line.startsWith('            ')) continue;
    const entry = /^ {10}([A-Za-z_-]+): (.*)$/.exec(line);
    if (!entry) break;
    map[entry[1]] = /^'.*'$/.test(entry[2]) ? entry[2].slice(1, -1) : entry[2];
  }
  return map;
}

function folded(lines, key) {
  const at = lines.indexOf(`          ${key}: >-`);
  if (at < 0) return undefined;
  const body = [];
  for (const line of lines.slice(at + 1)) {
    if (!line.startsWith('            ')) break;
    body.push(line.trim());
  }
  return body.join(' ');
}

export function steps(jobName) {
  const anchors = {};
  return job(jobName)
    .split(/\n(?= {6}- )/)
    .slice(1)
    .map((raw) => {
      const lines = raw.replace(/^ {6}- /, '        ').split('\n');
      let run;
      const at = lines.findIndex((line) => /^ {8}run: (&[\w-]+ )?\|$/.test(line));
      if (at >= 0) {
        const body = [];
        for (const line of lines.slice(at + 1)) {
          if (line.trim() && !line.startsWith('          ')) break;
          body.push(line.slice(10));
        }
        run = body.join('\n').trimEnd();
        const anchor = /run: &([\w-]+) \|/.exec(lines[at])?.[1];
        if (anchor) anchors[anchor] = run;
      } else {
        const inline = field(lines, 'run');
        run = inline?.startsWith('*') ? anchors[inline.slice(1)] : inline;
      }
      return {
        raw,
        lines,
        id: field(lines, 'id'),
        name: field(lines, 'name'),
        if: field(lines, 'if'),
        uses: field(lines, 'uses'),
        continueOnError: field(lines, 'continue-on-error') === 'true',
        env: block(lines, 'env'),
        with: block(lines, 'with'),
        claudeArgs: folded(lines, 'claude_args'),
        run,
      };
    });
}

function compute(expression, context) {
  const source = expression.replace(/^\$\{\{\s*|\s*\}\}$/g, '');
  const lookup = (path) => {
    const value = path.split('.').reduce((at, key) => at?.[key], context);
    return value ?? '';
  };
  const js = source.replace(
    /'((?:[^']|'')*)'|\b(always|cancelled|success|failure)\(\)|\b((?:matrix|steps|env|vars)(?:\.[A-Za-z_][\w-]*)+)|(!=|==)/g,
    (_, string, call, path, op) => {
      if (string !== undefined) return JSON.stringify(string.replace(/''/g, "'"));
      if (call === 'always') return 'true';
      if (call === 'cancelled') return 'false';
      if (call === 'success') return String(!context.failed);
      if (call === 'failure') return String(context.failed);
      if (path) return JSON.stringify(lookup(path));
      return `${op}=`;
    }
  );
  return Function(`return (${js});`)();
}

export function evaluate(expression, context) {
  const value = compute(expression, context);
  return /\b(always|cancelled|success|failure)\(\)/.test(expression)
    ? value
    : !context.failed && value;
}

const agents = {
  claude: { ids: ['claude', 'claude-retry'], output: 'structured_output' },
  codex: { ids: ['codex', 'codex-retry'], output: 'final-message' },
};

export function simulate(reviewer, agent, attempts) {
  const context = { matrix: { agent }, steps: {}, failed: false };
  const ran = [];
  const logged = [];
  let findings;
  const start = reviewer.findIndex((step) => step.id === 'claude');
  for (const step of reviewer.slice(start)) {
    const label = step.id ?? step.name ?? step.uses ?? step.run?.slice(0, 40);
    const go = step.if === undefined ? !context.failed : evaluate(step.if, context);
    if (!go) {
      if (step.id) context.steps[step.id] = { outcome: 'skipped', outputs: {} };
      continue;
    }
    ran.push(label);
    let outcome = 'success';
    let outputs = {};
    const owner = Object.values(agents).find((entry) => entry.ids.includes(step.id));
    if (owner) {
      const verdict = attempts.shift();
      outcome = verdict === undefined ? 'failure' : 'success';
      if (verdict) outputs = { [owner.output]: JSON.stringify({ verdict }) };
    }
    if (step.env.ATTEMPT) {
      const env = {};
      for (const [key, value] of Object.entries(step.env))
        env[key] = value.startsWith('${{') ? String(compute(value, context)) : value;
      logged.push(env);
    }
    if (step.env.FINDINGS) findings = evaluate(step.env.FINDINGS, context);
    if (step.id) context.steps[step.id] = { outcome, outputs };
    if (outcome === 'failure' && !step.continueOnError) context.failed = true;
  }
  return { ran, logged, findings, failed: context.failed, left: attempts.length };
}
