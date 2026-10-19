'use strict';
const { isAbsolute, join, matchesGlob, normalize, relative } = require('node:path');

const list = process.env.SLICC_TEST_FILES;

const inside = (file, pattern) => {
  const path = normalize(isAbsolute(pattern) ? relative(process.cwd(), pattern) : pattern);
  const dir = path.replace(/\/+$/, '');
  return file === path || file.startsWith(`${dir}/`) || matchesGlob(file, path);
};

if (list !== undefined && process.execArgv.includes('--test') && !process.env.NODE_TEST_CONTEXT) {
  process.env.NODE_OPTIONS = process.env.SLICC_TEST_NODE_OPTIONS ?? '';
  delete process.env.SLICC_TEST_NODE_OPTIONS;
  delete process.env.SLICC_TEST_FILES;
  const patterns = process.argv.slice(1);
  const chosen = list
    .split('\n')
    .filter(Boolean)
    .map((file) => normalize(file))
    .filter((file) => patterns.length === 0 || patterns.some((pattern) => inside(file, pattern)));
  process.argv.splice(
    1,
    Number.POSITIVE_INFINITY,
    ...(chosen.length > 0 ? chosen : [join(__dirname, '..', 'unit', 'none.mjs')])
  );
}
