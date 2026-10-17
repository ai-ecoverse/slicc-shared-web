import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parse } from 'acorn';
import { ALL, BODY, describe } from './exports.mjs';

export const code = /\.(m|c)?(j|t)sx?$/;
const tests = /\.test\.(m|c)?(j|t)sx?$/;
const typed = /\.(m|c)?tsx?$/;
const swaps = { '.js': ['.ts', '.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'], '.jsx': ['.tsx'] };
const suffixes = ['.mjs', '.js', '.ts', '.tsx', '.mts', '.cjs', '.cts', '.jsx'];

export class ParseError extends Error {}

const isFile = (path) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

function walk(dir, found = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, found);
    else if (entry.isFile()) found.push(path);
  }
  return found;
}

function quiet(fn) {
  const emit = process.emitWarning;
  process.emitWarning = () => undefined;
  try {
    return fn();
  } finally {
    process.emitWarning = emit;
  }
}

function strip(source) {
  return quiet(() => {
    try {
      return stripTypeScriptTypes(source);
    } catch {
      return stripTypeScriptTypes(source, { mode: 'transform' });
    }
  });
}

function program(file) {
  const raw = readFileSync(file, 'utf8');
  const source = typed.test(file) ? strip(raw) : raw;
  const options = { ecmaVersion: 'latest', allowHashBang: true, allowAwaitOutsideFunction: true };
  try {
    return parse(source, { ...options, sourceType: 'module' });
  } catch (error) {
    if (!/\.c(j|t)s$/.test(file)) throw error;
    return parse(source, { ...options, sourceType: 'script', allowReturnOutsideFunction: true });
  }
}

function candidates(target) {
  const ext = extname(target);
  const base = target.slice(0, target.length - ext.length);
  return [
    target,
    ...(swaps[ext] ?? []).map((swap) => base + swap),
    ...suffixes.map((suffix) => target + suffix),
    ...suffixes.map((suffix) => join(target, `index${suffix}`)),
  ];
}

function skip(text, at) {
  if (text[at] !== '/') return at;
  if (text[at + 1] === '/') {
    const end = text.indexOf('\n', at);
    return end === -1 ? text.length : end;
  }
  if (text[at + 1] === '*') {
    const end = text.indexOf('*/', at + 2);
    return end === -1 ? text.length : end + 2;
  }
  return at;
}

function quoted(text, at) {
  let end = at + 1;
  while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
  return end + 1;
}

export function jsonc(text) {
  let out = '';
  let comma = false;
  let at = 0;
  while (at < text.length) {
    const next = skip(text, at);
    if (next !== at) {
      at = next;
      continue;
    }
    const char = text[at];
    if (/\s/.test(char)) {
      at += 1;
      continue;
    }
    if (comma && char !== '}' && char !== ']') out += ',';
    comma = char === ',';
    if (comma) {
      at += 1;
      continue;
    }
    const end = char === '"' ? quoted(text, at) : at + 1;
    out += text.slice(at, end);
    at = end;
  }
  return JSON.parse(comma ? `${out},` : out);
}

function readJson(path) {
  try {
    return jsonc(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

function tsconfigPaths(root, file = join(root, 'tsconfig.json'), seen = new Set()) {
  if (seen.has(file)) return [];
  seen.add(file);
  const config = readJson(file);
  if (!config) return [];
  const dir = dirname(file);
  const parents = [config.extends ?? []].flat().flatMap((parent) => {
    const path = parent.startsWith('.') ? resolve(dir, parent) : join(root, 'node_modules', parent);
    const json = path.endsWith('.json') ? path : `${path}.json`;
    return tsconfigPaths(root, json, seen);
  });
  const options = config.compilerOptions ?? {};
  if (!options.paths) return parents;
  const base = resolve(dir, options.baseUrl ?? '.');
  const own = Object.entries(options.paths).map(([pattern, targets]) => ({
    pattern,
    targets: targets.map((target) => resolve(base, target)),
  }));
  return [...own, ...parents];
}

function aliased(spec, aliases) {
  for (const { pattern, targets } of aliases) {
    const star = pattern.indexOf('*');
    if (star === -1) {
      if (spec === pattern) return targets;
      continue;
    }
    const head = pattern.slice(0, star);
    const tail = pattern.slice(star + 1);
    if (spec.length >= head.length + tail.length && spec.startsWith(head) && spec.endsWith(tail)) {
      const middle = spec.slice(head.length, spec.length - tail.length);
      return targets.map((target) => target.replace('*', middle));
    }
  }
  return [];
}

function resolver(root) {
  const aliases = tsconfigPaths(root);
  return (from, spec) => {
    let targets;
    if (spec.startsWith('.')) targets = [resolve(dirname(from), spec)];
    else if (isAbsolute(spec)) targets = [spec];
    else targets = aliased(spec, aliases);
    const missing = [];
    for (const target of targets) {
      const options = candidates(target.split(/[?#]/)[0]);
      const hit = options.find(isFile);
      if (hit) return hit.includes(`${sep}node_modules${sep}`) ? undefined : { hit };
      missing.push(...options);
    }
    return { missing };
  };
}

function modules(root) {
  const find = resolver(root);
  const cache = new Map();
  const load = (file) => {
    if (!cache.has(file)) {
      let info;
      if (code.test(file)) {
        try {
          info = describe(program(file), /\.c(j|t)s$/.test(file));
        } catch (error) {
          throw new ParseError(`${relative(root, file)}: ${error.message}`);
        }
      }
      cache.set(file, info);
    }
    return cache.get(file);
  };
  return { find, load };
}

function provider({ find, load }) {
  const memo = new Map();
  const provides = (file, name, stack = new Set()) => {
    const key = `${file}\0${name}`;
    if (memo.has(key)) return memo.get(key);
    if (stack.has(key)) return false;
    stack.add(key);
    const info = load(file);
    let answer;
    if (!info || info.whole) answer = undefined;
    else if (info.locals.has(name) || info.reexports.has(name)) answer = true;
    else answer = starred(file, info, name, stack);
    memo.set(key, answer);
    return answer;
  };
  const starred = (file, info, name, stack) => {
    let answer = false;
    for (const spec of info.stars) {
      const hit = find(file, spec)?.hit;
      const own = hit ? provides(hit, name, stack) : undefined;
      if (own === undefined) return undefined;
      answer ||= own;
    }
    return answer;
  };
  return provides;
}

function reacher(graph) {
  const { find } = graph;
  const context = { find, provides: provider(graph) };
  return (start) => {
    const touched = new Set();
    const absent = [];
    const seen = new Set();
    const queue = [[start, BODY]];
    const go = (file, spec, name) => {
      const found = find(file, spec);
      if (found?.hit) queue.push([found.hit, name]);
      else if (found) {
        for (const path of found.missing) touched.add(path);
        if (found.missing.length > 0) absent.push(found.missing);
      }
    };
    while (queue.length > 0) {
      const [file, name] = queue.pop();
      const key = `${file}\0${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      touched.add(file);
      const info = graph.load(file);
      if (!info) continue;
      for (const [next, wanted, spec] of step(info, name, file, context)) {
        if (spec === undefined) queue.push([next, wanted]);
        else go(next, spec, wanted);
      }
    }
    return { touched, absent };
  };
}

function starred(file, info, name, { find, provides }) {
  const targets = info.stars.map((spec) => find(file, spec)?.hit);
  if (targets.some((target) => !target)) return [[file, ALL]];
  const answers = targets.map((target) => provides(target, name));
  if (answers.some((answer) => answer === undefined)) return [[file, ALL]];
  const owners = targets.filter((_, index) => answers[index]);
  return owners.length > 0 ? owners.map((target) => [target, name]) : [[file, ALL]];
}

function step(info, name, file, context) {
  if (name === BODY) {
    return [
      ...info.imports.flatMap(({ spec, names }) => names.map((wanted) => [file, wanted, spec])),
      ...info.dynamic.flatMap(({ spec, names }) => names.map((wanted) => [file, wanted, spec])),
    ];
  }
  if (info.whole) return [[file, BODY]];
  if (name === ALL) {
    return [
      [file, BODY],
      ...[...info.reexports.values()].map(({ spec, name: wanted }) => [file, wanted, spec]),
      ...info.stars.map((spec) => [file, ALL, spec]),
    ];
  }
  if (info.locals.has(name)) return [[file, BODY]];
  const again = info.reexports.get(name);
  if (again) return [[file, again.name, again.spec]];
  if (name === 'default' || info.stars.length === 0) return [[file, ALL]];
  return starred(file, info, name, context);
}

export function select({ root, changed }) {
  const all = walk(join(root, 'test', 'unit')).filter((file) => tests.test(file));
  const staged = new Set(changed.map((file) => resolve(root, file)));
  const reach = reacher(modules(root));
  const posix = (file) => relative(root, file).split(sep).join('/');
  const lacks = ([target, ...rest]) =>
    !relative(root, target).startsWith('..') &&
    !target.includes(`${sep}node_modules${sep}`) &&
    !existsSync(target) &&
    ![target, ...rest].some((path) => staged.has(path));
  const reached = [];
  const elsewhere = [];
  for (const test of all) {
    const { touched, absent } = reach(test);
    if (![...touched].some((file) => staged.has(file))) continue;
    const lacking = absent.some(lacks);
    (lacking ? elsewhere : reached).push(posix(test));
  }
  return { tests: reached.sort(), elsewhere: elsewhere.sort(), total: all.length };
}
