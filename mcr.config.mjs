import { stripTypeScriptTypes } from 'node:module';
import { inject } from './unit/inject.mjs';

if (process.env.SLICC_UNIT_TESTS !== undefined) process.env.NODE_OPTIONS = inject();

const strip = (entry) => {
  if (entry.url.endsWith('.ts')) entry.source = stripTypeScriptTypes(entry.source);
};

const ours = (url) =>
  url.includes('/src/') && !url.includes('/node_modules/') && /\.(m?js|ts)$/.test(url);

export default {
  name: process.env.npm_package_name ?? 'unit',
  outputDir: process.env.SLICC_UNIT_COVERAGE_DIR ?? 'coverage/unit',
  reports: ['lcovonly', 'console-details'],
  all: { dir: 'src', filter: '**/*.{js,mjs,ts}', transformer: strip },
  entryFilter: (entry) => ours(entry.url),
  onEntry: strip,
};
