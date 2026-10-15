import { readdirSync, readFileSync, statSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parse } from 'acorn';

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

const literal = (node) => {
  if (node?.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis[0].value.cooked;
  }
  return undefined;
};

const metaUrl = (node) =>
  node?.type === 'MemberExpression' &&
  node.object.type === 'MetaProperty' &&
  node.property.name === 'url';

function specifier(node) {
  switch (node.type) {
    case 'ImportDeclaration':
    case 'ExportAllDeclaration':
    case 'ExportNamedDeclaration':
    case 'ImportExpression':
      return literal(node.source);
    case 'CallExpression':
      return node.callee.type === 'Identifier' && node.callee.name === 'require'
        ? literal(node.arguments[0])
        : undefined;
    case 'NewExpression':
      return node.callee.type === 'Identifier' &&
        node.callee.name === 'URL' &&
        metaUrl(node.arguments[1])
        ? literal(node.arguments[0])
        : undefined;
    default:
      return undefined;
  }
}

function specifiers(ast) {
  const found = [];
  const stack = [ast];
  while (stack.length > 0) {
    const node = stack.pop();
    const value = specifier(node);
    if (value !== undefined) found.push(value);
    for (const key of Object.keys(node)) {
      const child = node[key];
      if (Array.isArray(child)) {
        for (const item of child) if (item && typeof item.type === 'string') stack.push(item);
      } else if (child && typeof child.type === 'string') {
        stack.push(child);
      }
    }
  }
  return found;
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

function graph(root, starts) {
  const find = resolver(root);
  const edges = new Map();
  const queue = [...starts];
  while (queue.length > 0) {
    const file = queue.pop();
    if (edges.has(file)) continue;
    const out = [];
    edges.set(file, out);
    if (!code.test(file)) continue;
    let ast;
    try {
      ast = program(file);
    } catch (error) {
      throw new ParseError(`${relative(root, file)}: ${error.message}`);
    }
    for (const spec of specifiers(ast)) {
      const found = find(file, spec);
      if (found?.hit) {
        out.push(found.hit);
        queue.push(found.hit);
      } else if (found) {
        out.push(...found.missing);
      }
    }
  }
  return edges;
}

function reaching(edges, changed) {
  const back = new Map();
  for (const [file, out] of edges) {
    for (const target of out) {
      if (!back.has(target)) back.set(target, []);
      back.get(target).push(file);
    }
  }
  const seen = new Set();
  const queue = [...changed];
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    queue.push(...(back.get(file) ?? []));
  }
  return seen;
}

export function select({ root, changed, since }) {
  const unit = join(root, 'test', 'unit');
  const files = walk(unit);
  const all = files.filter((file) => tests.test(file));
  const fresh = files.filter((file) => since === undefined || statSync(file).mtimeMs > since);
  const touched = new Set([...changed.map((file) => resolve(root, file)), ...fresh]);
  const reached = reaching(graph(root, all), touched);
  const posix = (file) => relative(root, file).split(sep).join('/');
  return {
    tests: all
      .filter((file) => reached.has(file))
      .map(posix)
      .sort(),
    total: all.length,
  };
}
