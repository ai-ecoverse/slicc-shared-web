'use strict';
const { appendFileSync } = require('node:fs');
const { isAbsolute, normalize, relative } = require('node:path');

const out = process.env.SLICC_TEST_TIMES;
delete process.env.SLICC_TEST_TIMES;
const entry = process.argv[1];

if (out && entry) {
  const file = normalize(isAbsolute(entry) ? relative(process.cwd(), entry) : entry);
  process.on('exit', () => {
    try {
      appendFileSync(out, `${JSON.stringify({ file, ms: Math.round(performance.now()) })}\n`);
    } catch {}
  });
}
