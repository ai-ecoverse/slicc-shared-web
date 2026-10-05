import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';

const artifacts = new URL('../../artifacts/', import.meta.url);
const dir = new URL(
  'harness/profiles-the-page-its-dedicated-and-nested-workers-and-a-shared-worker/',
  artifacts
);
const files = await readdir(dir);
for (const name of ['page', 'worker', 'nested', 'shared', 'exit']) {
  assert.ok(
    files.some((file) => file.endsWith(`-${name}.cpuprofile`)),
    `${name}: ${files}`
  );
}
assert.ok(files.includes('tab-1.png'));
const logged = await readFile(new URL('console.log', dir), 'utf8');
for (const line of ['page: log page ready', 'worker: log worker done', 'nested: log nested done']) {
  assert.ok(logged.includes(line), logged);
}
const tabs = await readdir(
  new URL('harness/types-into-the-page-overrides-files-and-opens-a-second-tab/', artifacts)
);
assert.ok(tabs.includes('tab-2.png'), tabs);
const hotspots = await readFile(new URL('hotspots.md', artifacts), 'utf8');
assert.match(hotspots, /across \d+ CPU profiles/);
assert.match(hotspots, /`test\/integration\/page\/\w+\.js:\d+ /, hotspots);
const loaded = new URL(
  'extension/loads-an-unpacked-extension-and-profiles-its-service-worker-and-content-script/',
  artifacts
);
const extension = await readdir(loaded);
assert.ok(
  extension.some((file) => file.endsWith('-background.cpuprofile')),
  extension.join()
);
assert.match(
  await readFile(new URL('console.log', loaded), 'utf8'),
  /background: log background 2584/
);
const lcov = await readFile(new URL('../../coverage/lcov.info', import.meta.url), 'utf8');
for (const file of ['page.js', 'worker.js', 'nested.js', 'shared.js', 'exit.js']) {
  const record = lcov.split('end_of_record').find((part) => part.includes(`page/${file}\n`));
  assert.ok(record, `${file} missing from lcov`);
  assert.match(record, /^LH:[1-9]/m, record);
}
for (const file of ['background.js', 'content.js']) {
  const record = lcov.split('end_of_record').find((part) => part.includes(`extension/${file}\n`));
  assert.ok(record, `${file} missing from lcov`);
  assert.match(record, /^LH:[1-9]/m, record);
}
console.log('artifacts verified');
