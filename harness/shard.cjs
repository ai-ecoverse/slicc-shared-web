'use strict';
const { existsSync, globSync, renameSync, statSync } = require('node:fs');
const { isAbsolute, join, matchesGlob, normalize, relative } = require('node:path');

const env = process.env;
const list = env.SLICC_TEST_FILES;
const exts = '{js,mjs,cjs,ts,mts,cts}';
const defaults = [
  `**/*.test.${exts}`,
  `**/*-test.${exts}`,
  `**/*_test.${exts}`,
  `**/test-*.${exts}`,
  `**/test.${exts}`,
  `**/test/**/*.${exts}`,
];

const lines = (value) =>
  (value ?? '')
    .split('\n')
    .filter(Boolean)
    .map((file) => normalize(file));

const local = (pattern) =>
  normalize(isAbsolute(pattern) ? relative(process.cwd(), pattern) : pattern);

const inside = (file, pattern) => {
  const path = local(pattern);
  const dir = path.replace(/\/+$/, '');
  return file === path || file.startsWith(`${dir}/`) || matchesGlob(file, path);
};

const directory = (path) => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

function expand(patterns) {
  const globs =
    patterns.length === 0
      ? defaults
      : patterns.flatMap((pattern) => {
          const path = local(pattern).replace(/\/+$/, '');
          return directory(path) ? defaults.map((glob) => `${path}/${glob}`) : [path];
        });
  const files = globSync(globs, { exclude: (file) => file.includes('node_modules') });
  return files.map((file) => normalize(file)).filter((file) => !directory(file));
}

function keepReport() {
  const junit = env.SLICC_TEST_JUNIT;
  if (junit && existsSync(junit)) {
    renameSync(junit, junit.replace(/(\.xml)?$/, `-${process.pid}.xml`));
  }
}

function select(patterns) {
  const matches = (file) => patterns.length === 0 || patterns.some((p) => inside(file, p));
  const mine = lines(list).filter(matches);
  if ((env.SLICC_TEST_SHARD ?? '0') !== '0') return mine;
  const all = new Set(lines(env.SLICC_TEST_ALL));
  if (all.size === 0) return undefined;
  const rest = expand(patterns).filter((file) => !all.has(file));
  return [...new Set([...mine, ...rest])];
}

if (list !== undefined && process.execArgv.includes('--test') && !env.NODE_TEST_CONTEXT) {
  keepReport();
  const chosen = select(process.argv.slice(1));
  env.NODE_OPTIONS = env.SLICC_TEST_NODE_OPTIONS ?? '';
  for (const name of [
    'SLICC_TEST_NODE_OPTIONS',
    'SLICC_TEST_FILES',
    'SLICC_TEST_ALL',
    'SLICC_TEST_SHARD',
    'SLICC_TEST_JUNIT',
  ]) {
    delete env[name];
  }
  if (chosen !== undefined) {
    process.argv.splice(
      1,
      Number.POSITIVE_INFINITY,
      ...(chosen.length > 0 ? chosen : [join(__dirname, '..', 'unit', 'none.mjs')])
    );
  }
}
