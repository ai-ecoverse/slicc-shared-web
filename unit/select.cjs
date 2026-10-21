'use strict';
require('./guard.cjs');
const { isAbsolute, join, matchesGlob, normalize, relative } = require('node:path');

const key = Symbol.for('slicc.unit.select');
const list = process.env.SLICC_UNIT_TESTS;

const inside = (file, pattern) => {
  const path = normalize(isAbsolute(pattern) ? relative(process.cwd(), pattern) : pattern);
  const dir = path.replace(/\/+$/, '');
  return file === path || file.startsWith(`${dir}/`) || matchesGlob(file, path);
};

if (
  list !== undefined &&
  !globalThis[key] &&
  process.execArgv.includes('--test') &&
  !process.env.NODE_TEST_CONTEXT
) {
  globalThis[key] = true;
  const patterns = process.argv.slice(1);
  const chosen = list
    .split('\n')
    .filter(Boolean)
    .map((file) => normalize(file))
    .filter((file) => patterns.length === 0 || patterns.some((pattern) => inside(file, pattern)));
  process.argv.splice(
    1,
    Number.POSITIVE_INFINITY,
    ...(chosen.length > 0 ? chosen : [join(__dirname, 'none.mjs')])
  );
}
