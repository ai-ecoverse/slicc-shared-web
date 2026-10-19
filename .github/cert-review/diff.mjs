import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { annotate, diffOf, git, sha } from './lib.mjs';

const env = process.env;
const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
const pull = event.pull_request;
const head = sha(pull.head.sha);
const base = sha(pull.base.sha);
const out = env.CERT_DIR;
const template = env.CERT_PROMPT;
const rulesFile = env.CERT_RULES;
if (!out || !template || !rulesFile)
  throw new Error('CERT_DIR, CERT_PROMPT and CERT_RULES are required');
const rules = (
  env.GITHUB_EVENT_NAME === 'pull_request'
    ? git('show', `${head}:${rulesFile}`)
    : git('show', `${base}:${rulesFile}`)
).trim();
if (!rules) throw new Error(`${rulesFile} is empty: no certification rules, no review`);
mkdirSync(out, { recursive: true });

const files = diffOf(base, head);
const text = annotate(files);
writeFileSync(join(out, 'diff.txt'), text);
writeFileSync(
  join(out, 'files.json'),
  `${JSON.stringify(
    files.map((f) => ({ path: f.path, status: f.status, from: f.from, binary: f.binary })),
    null,
    2
  )}\n`
);
const values = {
  REPO: env.GITHUB_REPOSITORY,
  PR: String(pull.number),
  HEAD: head,
  BASE: base,
  WORKSPACE: env.GITHUB_WORKSPACE ?? process.cwd(),
  DIFF: join(out, 'diff.txt'),
  FILES: join(out, 'files.json'),
  DIFFLINES: String(text.split('\n').length),
};
const fill = (text) => text.replace(/\{\{([A-Z]+)\}\}/g, (m, k) => values[k] ?? m);
const prompt = fill(readFileSync(template, 'utf8')).replace('{{RULES}}', () => fill(rules));
writeFileSync(join(out, 'prompt.txt'), prompt);
console.log(
  `cert-review: ${files.length} files, ${files.reduce((n, f) => n + f.lines.length, 0)} diff lines for #${pull.number} ${head}`
);
