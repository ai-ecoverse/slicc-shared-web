import { readFileSync } from 'node:fs';
import { relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inject } from './unit/inject.mjs';
import { inSources, unitSources } from './unit/sources.mjs';
import { compile, inline, typed } from './unit/typescript.mjs';

process.env.NODE_OPTIONS = inject();

const code = /\.(m|c)?(j|t)s$/;

const strip = (entry) => {
  if (!typed.test(entry.url)) return;
  const file = fileURLToPath(entry.url);
  const output = compile(readFileSync(file, 'utf8'), file);
  if (output.map === undefined) {
    entry.source = output.code;
    return;
  }
  entry.source = inline(output);
  entry.sourceMap = output.map;
  entry.fake = false;
};

const listed = unitSources();

const source = (file) =>
  code.test(file) &&
  inSources(relative(process.cwd(), file).split(sep).join('/'), process.cwd(), listed);

const ours = (url) => url.startsWith('file:') && source(fileURLToPath(url));

export default {
  name: process.env.npm_package_name ?? 'unit',
  outputDir: process.env.SLICC_UNIT_COVERAGE_DIR ?? 'coverage/unit',
  reports: ['lcovonly', 'console-details'],
  all: { dir: listed ?? 'src', filter: source, transformer: strip },
  entryFilter: (entry) => ours(entry.url),
  onEntry: strip,
};
