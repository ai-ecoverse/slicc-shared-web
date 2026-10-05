import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { cwd } from 'node:process';
import { CoverageReport } from 'monocart-coverage-reports';
import { artifacts, raw, samples } from './util.mjs';

async function name() {
  const manifest = await readFile('package.json', 'utf8').catch(() => '{}');
  return JSON.parse(manifest).name ?? basename(cwd());
}

async function load(dir) {
  const files = await readdir(dir).catch(() => []);
  const parsed = files
    .sort()
    .map(async (file) => JSON.parse(await readFile(new URL(file, dir), 'utf8')));
  return Promise.all(parsed);
}

export async function report() {
  const merged = new CoverageReport({
    name: await name(),
    outputDir: 'coverage',
    reports: ['console-details', 'lcovonly', 'v8'],
    logging: 'error',
    all: { dir: 'src', filter: '**/*.js' },
    sourceFilter: (path) => path.startsWith('src/'),
  });
  for (const entries of await load(raw)) {
    if (entries.length > 0) await merged.add(entries);
  }
  await merged.generate();
}

export function table(runs) {
  const self = new Map();
  let profiles = 0;
  for (const run of runs) {
    profiles += run.profiles;
    for (const [frame, micros] of Object.entries(run.self)) {
      self.set(frame, (self.get(frame) ?? 0) + micros);
    }
  }
  const top = [...self].sort((a, b) => b[1] - a[1]).slice(0, 15);
  const rows = top.map(([frame, micros]) => `| ${(micros / 1000).toFixed(2)} ms | \`${frame}\` |`);
  return [
    `### Hotspots: self time in our scripts across ${profiles} CPU profiles`,
    '',
    '| self | frame |',
    '| ---: | :--- |',
    ...rows,
    '',
  ].join('\n');
}

export async function hotspots() {
  const markdown = table(await load(samples));
  await mkdir(artifacts, { recursive: true });
  await writeFile(new URL('hotspots.md', artifacts), markdown);
  console.log(markdown);
}

export async function globalSetup() {
  await rm(artifacts, { recursive: true, force: true });
  await rm(raw, { recursive: true, force: true });
  await rm(samples, { recursive: true, force: true });
}

export async function globalTeardown() {
  await report();
  await hotspots();
}
