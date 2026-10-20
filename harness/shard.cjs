'use strict';
const { existsSync, renameSync } = require('node:fs');
const { isAbsolute, join, matchesGlob, normalize, relative } = require('node:path');

const env = process.env;
const list = env.SLICC_TEST_FILES;

const lines = (value) =>
  (value ?? '')
    .split('\n')
    .filter(Boolean)
    .map((file) => normalize(file));

const inside = (file, pattern) => {
  const path = normalize(isAbsolute(pattern) ? relative(process.cwd(), pattern) : pattern);
  const dir = path.replace(/\/+$/, '');
  return file === path || file.startsWith(`${dir}/`) || matchesGlob(file, path);
};

function keepReport() {
  const junit = env.SLICC_TEST_JUNIT;
  if (junit && existsSync(junit)) {
    renameSync(junit, junit.replace(/(\.xml)?$/, `-${process.pid}.xml`));
  }
}

function select(patterns) {
  const matches = (file) => patterns.length === 0 || patterns.some((p) => inside(file, p));
  const all = lines(env.SLICC_TEST_ALL);
  if (all.length > 0 && !all.some(matches)) {
    return (env.SLICC_TEST_SHARD ?? '0') === '0' ? undefined : [];
  }
  return lines(list).filter(matches);
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
