import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const text = readFileSync(`${root}/.github/workflows/pipeline.yml`, 'utf8');
const harness = new URL('../../harness/cdn.mjs', import.meta.url).href;
const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function job(name) {
  const start = text.indexOf(`\n  ${name}:\n`);
  assert.ok(start > 0, name);
  const next = text.slice(start + 1).search(/\n {2}[a-z-]+:\n/);
  return text.slice(start, next < 0 ? undefined : start + 1 + next);
}

function steps(body) {
  return body.split(/\n(?= {6}- )/).slice(1);
}

const restore = /uses: actions\/cache\/restore@[0-9a-f]{40}\n/;
const cdn = 'path: node_modules/.cache/slicc-harness/cdn\n';
const locks = "LOCKS: ${{ hashFiles('**/package-lock.json', '**/pnpm-lock.yaml') }}";
const key = 'run: echo "key=slicc-harness-cdn-$RUNNER_OS-$LOCKS" >> "$GITHUB_OUTPUT"';
const prefix = 'restore-keys: slicc-harness-cdn-${{ runner.os }}-\n';

test('each shard restores the harness download cache after npm ci, keyed on the OS and the lockfiles, and saves none', () => {
  const shard = steps(job('test'));
  const at = (pattern) => shard.findIndex((step) => pattern.test(step));
  const keyed = at(/hashFiles\(/);
  const install = at(/^ {6}- run: npm ci\n/);
  const restored = at(restore);
  const tests = at(/- name: Integration tests/);
  assert.ok(
    keyed >= 0 && keyed < install && install < restored && restored < tests,
    shard.join('')
  );
  assert.ok(shard[keyed].includes(locks) && shard[keyed].includes(key), shard[keyed]);
  assert.ok(shard[restored].includes(cdn), shard[restored]);
  assert.ok(shard[restored].includes('key: ${{ steps.downloads.outputs.key }}\n'));
  assert.ok(shard[restored].includes(prefix), shard[restored]);
  assert.doesNotMatch(job('test'), /actions\/cache(\/save)?@/);
});

test('each shard lists the downloads the harness served in its junit artifact', () => {
  const shard = job('test');
  assert.match(shard, /\n {10}SLICC_TEST_DOWNLOADS=\$PWD\/junit\/\$SHARD\.downloads\n/);
  assert.match(shard, /\n {10}export [^\n]*\bSLICC_TEST_DOWNLOADS\b/);
  assert.match(shard, /name: junit-\$\{\{ matrix\.shard \}\}\n[^-]*path: junit\//);
});

test('only a push to main saves the cache, from the lists of the newest successful merge queue run, else pull request run', () => {
  const body = job('downloads');
  assert.match(
    body,
    /\n {4}if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'\n/
  );
  assert.match(body, /permissions:\n {6}contents: read\n {6}actions: read\n/);
  const all = steps(body);
  const queued = all.find((step) => step.includes('event: merge_group'));
  const fallback = all.find((step) => step.includes('event: pull_request'));
  for (const step of [queued, fallback]) {
    assert.match(step, /uses: dawidd6\/action-download-artifact@[0-9a-f]{40}\n/);
    assert.match(step, /workflow_conclusion: success\n/);
    assert.match(step, /name: \^junit-\n/);
  }
  assert.match(fallback, /if: steps\.queued\.outputs\.found_artifact != 'true'\n/);
  assert.match(fallback, /allow_forks: false\n/);
  const keyed = all.find((step) => step.includes('hashFiles('));
  assert.ok(keyed.includes(locks) && keyed.includes(key), keyed);
  const restored = all.find((step) => restore.test(step));
  assert.ok(restored.includes(cdn) && restored.includes(prefix), restored);
  const saved = all.find((step) => /actions\/cache\/save@[0-9a-f]{40}\n/.test(step));
  assert.match(saved, /if: steps\.fill\.outputs\.save == 'true'\n/);
  assert.ok(saved.includes(cdn) && saved.includes('key: ${{ steps.fill.outputs.key }}'), saved);
  assert.doesNotMatch(text, /actions\/cache@/);
});

function fill(workspace, env) {
  const step = steps(job('downloads')).find((s) => s.includes('id: fill'));
  const lines = step.split('\n');
  const script = lines
    .slice(lines.findIndex((line) => /^ {8}run: \|$/.test(line)) + 1)
    .map((line) => line.slice(10))
    .join('\n');
  const output = join(workspace, 'output');
  writeFileSync(output, '');
  const run = spawnSync('bash', ['-eo', 'pipefail', '-c', script], {
    cwd: workspace,
    encoding: 'utf8',
    env: { ...process.env, GITHUB_OUTPUT: output, NODE_OPTIONS: `--import=${env.MOCK}`, ...env },
  });
  assert.equal(run.status, 0, run.stderr);
  const out = Object.fromEntries(
    readFileSync(output, 'utf8')
      .trim()
      .split('\n')
      .map((line) => line.split('='))
  );
  return { ...out, stderr: run.stderr };
}

const registry = 'https://registry.npmjs.org';
const cached = `${registry}/@ai-ecoverse/wasm-xxd/-/wasm-xxd-9.1.1850.tgz`;
const missing = `${registry}/left-pad/-/left-pad-1.3.0.tgz`;
const gone = `${registry}/left-pad/-/left-pad-0.0.0.tgz`;
const versioned = 'https://cdn.jsdelivr.net/npm/modern-tar@0.8.6/dist/web/index.js';
const store = 'node_modules/.cache/slicc-harness/cdn';

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'slicc-downloads-'));
  dirs.push(dir);
  const temp = join(dir, 'temp');
  mkdirSync(join(temp, 'junit-download', 'junit-0'), { recursive: true });
  mkdirSync(join(temp, 'junit-download', 'junit-1'), { recursive: true });
  const ws = join(dir, 'ws');
  const put = (path, body) => {
    mkdirSync(join(ws, store, path, '..'), { recursive: true });
    writeFileSync(join(ws, store, path), body);
  };
  put('registry.npmjs.org/@ai-ecoverse/wasm-xxd/-/wasm-xxd-9.1.1850.tgz', 'cached xxd');
  put('registry.npmjs.org/left-pad/-/left-pad-1.1.0.tgz', 'unused');
  put('registry.npmjs.org/left-pad/index.json', '{"stale":true}');
  const mock = join(dir, 'mock.mjs');
  writeFileSync(
    mock,
    `import { appendFileSync } from 'node:fs';
globalThis.fetch = async (url) => {
  appendFileSync(process.env.CALLS, url + '\\n');
  if (url.includes('0.0.0')) return new Response('', { status: 404 });
  return new Response('real ' + url.split('/').pop());
};
`
  );
  return { dir, ws, temp, mock, calls: join(dir, 'calls') };
}

const files = (ws) =>
  readdirSync(join(ws, store), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(join(ws, store).length + 1))
    .sort();

test('the push job fetches what the shards listed, keeps what it has, prunes the rest and saves only a new set', () => {
  const { ws, temp, mock, calls } = workspace();
  const lists = join(temp, 'junit-download');
  writeFileSync(
    join(lists, 'junit-0', '0.downloads'),
    [
      cached,
      missing,
      `${registry}/left-pad`,
      'https://raw.githubusercontent.com/ai-ecoverse/homescoop/main/certification-exceptions.json',
      'https://cdn.jsdelivr.net/npm/modern-tar@latest/dist/web/index.js',
      versioned,
      `http://registry.npmjs.org/left-pad/-/left-pad-1.2.0.tgz`,
      'https://registry.attacker.example/x/-/x-1.0.0.tgz',
      `${registry}/left-pad/-/left-pad-1.2.0.tgz?x=1`,
      'not a url',
      '',
    ].join('\n')
  );
  writeFileSync(join(lists, 'junit-1', '1.downloads'), `${missing}\n${gone}\n`);
  const env = { MOCK: mock, CALLS: calls, RUNNER_TEMP: temp, KEY: 'slicc-harness-cdn-Linux-abc' };
  const first = fill(ws, { ...env, MATCHED: 'slicc-harness-cdn-Linux-old' });
  assert.deepEqual(
    readFileSync(calls, 'utf8').trim().split('\n').sort(),
    [gone, versioned, missing].sort()
  );
  assert.deepEqual(files(ws), [
    'cdn.jsdelivr.net/npm/modern-tar@0.8.6/dist/web/index.js',
    'registry.npmjs.org/@ai-ecoverse/wasm-xxd/-/wasm-xxd-9.1.1850.tgz',
    'registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz',
  ]);
  assert.equal(
    readFileSync(
      join(ws, store, 'registry.npmjs.org/@ai-ecoverse/wasm-xxd/-/wasm-xxd-9.1.1850.tgz'),
      'utf8'
    ),
    'cached xxd'
  );
  assert.match(first.key, /^slicc-harness-cdn-Linux-abc-[0-9a-f]{16}$/);
  assert.equal(first.save, 'true');
  assert.match(
    first.stderr,
    /::warning title=Downloads::https:\/\/registry\.npmjs\.org\/left-pad\/-\/left-pad-0\.0\.0\.tgz: 404/
  );
  assert.match(
    first.stderr,
    /downloads: 3 files from 2 shard lists, 2 fetched, 2 pruned, 0 MB, saving slicc-harness-cdn-Linux-abc-/
  );

  rmSync(calls);
  writeFileSync(join(lists, 'junit-1', '1.downloads'), `${missing}\n`);
  const again = fill(ws, { ...env, MATCHED: first.key });
  assert.equal(existsSync(calls), false);
  assert.equal(again.key, first.key);
  assert.equal(again.save, 'false');
  assert.match(again.stderr, /is up to date/);

  rmSync(lists, { recursive: true });
  const none = fill(ws, { ...env, MATCHED: '' });
  assert.equal(none.save, 'false');
  assert.match(none.stderr, /nothing to cache/);
});

test('what the push job cached is what the harness serves, with the network down', () => {
  const { ws, temp, mock, calls } = workspace();
  writeFileSync(
    join(temp, 'junit-download', 'junit-0', '0.downloads'),
    `${missing}\n${versioned}\n`
  );
  fill(ws, { MOCK: mock, CALLS: calls, RUNNER_TEMP: temp, KEY: 'k', MATCHED: '' });
  const run = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `const { download } = await import(process.env.HARNESS);
globalThis.fetch = async () => { throw new Error('offline'); };
const bodies = [];
for (const url of JSON.parse(process.env.URLS)) bodies.push(String(await download(url).catch((error) => error.message)));
console.log(JSON.stringify(bodies));`,
    ],
    {
      cwd: ws,
      encoding: 'utf8',
      env: { ...process.env, HARNESS: harness, URLS: JSON.stringify([missing, versioned, cached]) },
    }
  );
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), ['real left-pad-1.3.0.tgz', 'real index.js', 'offline']);
});
