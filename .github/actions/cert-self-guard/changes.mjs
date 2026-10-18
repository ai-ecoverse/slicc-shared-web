import { execFileSync } from 'node:child_process';
import { matchesGlob } from 'node:path';

export function git(...args) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    timeout: 60000,
    maxBuffer: 32 * 1024 * 1024,
  }).trimEnd();
}

export function checkedSha(sha) {
  if (!/^[a-f0-9]{40}$/.test(sha ?? '')) throw new Error('missing or invalid commit SHA');
  git('cat-file', '-e', `${sha}^{commit}`);
  return sha;
}

export function changedPaths(base, head) {
  const fields = git(
    'diff',
    '--find-renames',
    '--name-status',
    '-z',
    checkedSha(base),
    checkedSha(head),
    '--'
  ).split('\0');
  const paths = [];
  while (fields.length && fields[0]) {
    const status = fields.shift();
    const count = /^[RC]\d+$/.test(status) ? 2 : 1;
    if (!/^(?:[AMDUTX]|[RC]\d+)$/.test(status) || fields.length < count)
      throw new Error('invalid git changed-path evidence');
    for (let index = 0; index < count; index++) {
      const file = fields.shift();
      if (!file) throw new Error('missing changed path');
      paths.push(file);
    }
  }
  return [...new Set(paths)];
}

export function patterns(text) {
  const globs = text
    .split(/[\r\n]+/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (
    !globs.length ||
    globs.some(
      (glob) => glob.startsWith('!') || glob.startsWith('/') || glob.split('/').includes('..')
    )
  )
    throw new Error('paths must be nonempty repository-relative inclusive globs');
  return globs;
}

const SPECIAL = /[\\^$.+()|{}]/g;

function segment(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '*') {
      while (text[i + 1] === '*') i++;
      out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else if (c === '[') {
      const end = text.indexOf(']', i + 2);
      if (end < 0) out += '\\[';
      else {
        const body = text.slice(i + 1, end);
        const escaped = body.replace(/\\/g, '\\\\');
        out += `[${escaped.startsWith('!') ? `^${escaped.slice(1)}` : escaped}]`;
        i = end;
      }
    } else out += c.replace(SPECIAL, '\\$&');
  }
  return out;
}

export function dotGlob(glob) {
  const parts = glob.split('/');
  let source = '';
  parts.forEach((part, i) => {
    const last = i === parts.length - 1;
    if (part === '**') source += last ? '.+' : '(?:[^/]+/)*';
    else source += segment(part) + (last ? '' : '/');
  });
  return new RegExp(`^${source}$`);
}

export function touchedPaths(paths, globs) {
  const dots = globs.map(dotGlob);
  const dirs = globs.filter((glob) => glob.endsWith('/**')).map((glob) => glob.slice(0, -2));
  return paths.filter(
    (file) =>
      globs.some((glob) => matchesGlob(file, glob)) ||
      dots.some((re) => re.test(file)) ||
      dirs.some((dir) => !/[*?[]/.test(dir) && file.startsWith(dir))
  );
}

export function groupMembers(base, head) {
  checkedSha(base);
  checkedSha(head);
  git('merge-base', '--is-ancestor', base, head);
  const members = [];
  let current = head;
  while (current !== base) {
    if (members.length >= 100) throw new Error('merge group ancestry exceeds 100 members');
    const parents = git('show', '-s', '--format=%P', current).split(' ');
    if (parents.length !== 2) throw new Error(`unexplained merge group commit ${current}`);
    members.push({ merge: current, base: checkedSha(parents[0]), head: checkedSha(parents[1]) });
    current = parents[0];
  }
  if (!members.length) throw new Error('merge group has no queued PR ancestry');
  return members.reverse();
}
