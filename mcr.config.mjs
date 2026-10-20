import { stripTypeScriptTypes } from 'node:module';
import { relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inject } from './unit/inject.mjs';
import { inSources, unitSources } from './unit/sources.mjs';

if (process.env.SLICC_UNIT_TESTS !== undefined) process.env.NODE_OPTIONS = inject();

const strip = (entry) => {
  if (entry.url.endsWith('.ts')) entry.source = stripTypeScriptTypes(entry.source);
};

const code = /\.(m?js|ts)$/;

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
