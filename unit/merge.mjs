import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const diff = [
  '-c',
  'diff.mnemonicprefix=no',
  '-c',
  'diff.noprefix=no',
  '-c',
  'diff.srcPrefix=a/',
  '-c',
  'diff.dstPrefix=b/',
  '-c',
  'core.quotePath=false',
  'diff',
  '--cached',
  '--no-color',
  '--no-ext-diff',
  '--no-relative',
  '-M',
  '-U0',
];
const escapes = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11 };
const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

function git(root, args) {
  const run = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 2 ** 30 });
  return run.status === 0 ? run.stdout : undefined;
}

export function unquote(text) {
  if (!text.startsWith('"')) return text;
  const bytes = [];
  for (let at = 1; at < text.length - 1; at++) {
    if (text[at] !== '\\') {
      bytes.push(text.charCodeAt(at));
      continue;
    }
    const next = text[++at];
    if (/[0-7]/.test(next)) {
      bytes.push(Number.parseInt(text.slice(at, at + 3), 8));
      at += 2;
    } else bytes.push(escapes[next] ?? next.charCodeAt(0));
  }
  return Buffer.from(bytes).toString('utf8');
}

function named(header) {
  const rest = header.slice('diff --git '.length);
  const half = (rest.length - 1) / 2;
  if (rest[half] !== ' ') return undefined;
  const from = unquote(rest.slice(0, half)).slice(2);
  return from === unquote(rest.slice(half + 1)).slice(2) ? from : undefined;
}

function mark(file, found) {
  file.hunks = true;
  const start = Number(found[1]);
  const count = found[2] === undefined ? 1 : Number(found[2]);
  for (let at = start; at < start + count; at++) file.marks.add(`+${at}`);
}

const meta = /^(new file mode|deleted file mode|new mode|rename from|rename to) /;

function describe(files, file, line) {
  file.marks.add(`=${line}`);
  const moved = /^rename (from|to) (.*)$/.exec(line);
  if (moved === null) return;
  file.paths.push(unquote(moved[2]));
  if (moved[1] === 'to') files.set(file.paths.at(-1), file);
}

export function marks(text) {
  const files = new Map();
  let file;
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const path = named(line);
      file = {
        header: line,
        paths: path === undefined ? [] : [path],
        marks: new Set(),
        hunks: false,
      };
      if (path !== undefined) files.set(path, file);
      continue;
    }
    if (!file) continue;
    const found = hunk.exec(line);
    if (found) mark(file, found);
    else if (file.hunks && line.startsWith('-')) file.marks.add(line);
    else if (!file.hunks && meta.test(line)) describe(files, file, line);
  }
  return files;
}

function where(root, name) {
  const found = git(root, ['rev-parse', '--git-path', name]);
  return found === undefined ? undefined : resolve(root, found.trim());
}

const present = (file) => file !== undefined && existsSync(file);

export function parents(root) {
  const head = where(root, 'MERGE_HEAD');
  const merging = present(head) ? readFileSync(head, 'utf8').split('\n').filter(Boolean) : [];
  const rebasing = ['rebase-merge', 'rebase-apply'].some((dir) => present(where(root, dir)));
  const picked = (rebasing ? ['CHERRY_PICK_HEAD', 'REBASE_HEAD'] : ['CHERRY_PICK_HEAD'])
    .map((ref) => git(root, ['rev-parse', '-q', '--verify', `${ref}^{commit}`])?.trim())
    .filter(Boolean);
  return [...merging, ...picked];
}

export function renames(text) {
  const moved = new Map();
  const parts = text.split('\0');
  for (let at = 0; at < parts.length; at += 2) {
    if (!parts[at].startsWith('R')) continue;
    moved.set(parts[at + 1], parts[at + 2]);
    at += 1;
  }
  return moved;
}

export function merged(root = process.cwd()) {
  const others = parents(root);
  if (others.length === 0) return undefined;
  const views = ['HEAD', ...others].map((parent) => git(root, [...diff, parent]));
  const moves = others.map((parent) =>
    git(root, [
      'diff',
      '--no-ext-diff',
      '--no-relative',
      '-M',
      '--name-status',
      '-z',
      'HEAD',
      parent,
    ])
  );
  if ([...views, ...moves].includes(undefined)) return undefined;
  const [base, ...rest] = views.map(marks);
  const moved = moves.map(renames);
  const prefix = git(root, ['rev-parse', '--show-prefix'])?.trim() ?? '';
  const files = new Set();
  let text = '';
  for (const [name, file] of base) {
    const matches = rest.map((other, at) => other.get(name) ?? other.get(moved[at].get(name)));
    const kept = [...file.marks].filter((entry) =>
      matches.every(
        (other) => other !== undefined && (entry.startsWith('=') || other.marks.has(entry))
      )
    );
    if (kept.length === 0) continue;
    for (const each of [file, ...matches].flatMap((one) => one.paths))
      if (each.startsWith(prefix)) files.add(each.slice(prefix.length));
    const lines = kept.filter((entry) => entry.startsWith('+')).map((entry) => entry.slice(1));
    if (lines.length > 0)
      text += `${file.header}\n${lines.map((at) => `@@ -0,0 +${at} @@\n+\n`).join('')}`;
  }
  return { files: [...files], diff: text };
}
