import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { crc32, deflateRawSync } from 'node:zlib';

const root = fileURLToPath(new URL('../..', import.meta.url));
const text = readFileSync(`${root}/.github/workflows/pipeline.yml`, 'utf8');
const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function job(name) {
  const start = text.indexOf(`\n  ${name}:\n`);
  const next = text.slice(start + 1).search(/\n {2}[a-z-]+:\n/);
  return text.slice(start, next < 0 ? undefined : start + 1 + next);
}

const steps = (body) => body.split(/\n(?= {6}- )/).slice(1);

function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, body, store = false] of entries) {
    const data = Buffer.from(body);
    const packed = store ? data : deflateRawSync(data);
    const named = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(store ? 0 : 8, 8);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(named.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(store ? 0 : 8, 10);
    central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(named.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, named, packed);
    centrals.push(central, named);
    offset += 30 + named.length + packed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]).toString('base64');
}

const times = (rows) =>
  rows
    .map(([file, s]) => JSON.stringify({ file: `test/integration/${file}.test.mjs`, ms: s * 1000 }))
    .join('\n');

const mock = `import { appendFileSync, readFileSync } from 'node:fs';
const api = JSON.parse(readFileSync(process.env.API, 'utf8'));
globalThis.fetch = async (url, { headers }) => {
  const path = url.slice('https://api.test/'.length);
  appendFileSync(process.env.CALLS, path + '\\n');
  if (headers.authorization !== 'Bearer token') return new Response('', { status: 401 });
  const answer = api[path];
  if (!answer) return new Response('', { status: 404 });
  if (answer.zip) return new Response(Buffer.from(answer.zip, 'base64'));
  return Response.json(answer);
};
`;

const run = (id, event, repo = 'o/r') => ({ id, event, head_repository: { full_name: repo } });
const artifact = (id, name, runId, expired = false) => ({
  id,
  name,
  expired,
  workflow_run: { id: runId },
});

function api({ queued = [], pulls = [], timings = [], perRun = {}, zips = {} }) {
  const fixture = {
    'repos/o/r/actions/runs/999': { workflow_id: 7 },
    'repos/o/r/actions/workflows/7/runs?event=merge_group&status=completed&per_page=20': {
      workflow_runs: queued,
    },
    'repos/o/r/actions/workflows/7/runs?event=pull_request&status=completed&per_page=20': {
      workflow_runs: pulls,
    },
    'repos/o/r/actions/artifacts?name=timings&per_page=100': { artifacts: timings },
  };
  for (const [id, artifacts] of Object.entries(perRun))
    fixture[`repos/o/r/actions/runs/${id}/artifacts?per_page=100`] = { artifacts };
  for (const [id, entries] of Object.entries(zips))
    fixture[`repos/o/r/actions/artifacts/${id}/zip`] = { zip: zip(entries) };
  return fixture;
}

function split(fixture, total = 2) {
  const dir = mkdtempSync(join(tmpdir(), 'slicc-split-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'test/integration'), { recursive: true });
  for (const name of ['a', 'b', 'c', 'd'])
    writeFileSync(join(dir, `test/integration/${name}.test.mjs`), '');
  writeFileSync(join(dir, 'api.json'), JSON.stringify(fixture));
  writeFileSync(join(dir, 'mock.mjs'), mock);
  writeFileSync(join(dir, 'output'), '');
  const step = steps(job('lint')).find((s) => s.includes('id: split'));
  const lines = step.split('\n');
  const script = lines
    .slice(lines.findIndex((line) => /^ {8}run: \|$/.test(line)) + 1)
    .map((line) => line.slice(10))
    .join('\n');
  const result = spawnSync('bash', ['-eo', 'pipefail', '-c', script], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_OPTIONS: `--import=${join(dir, 'mock.mjs')}`,
      API: join(dir, 'api.json'),
      CALLS: join(dir, 'calls'),
      GLOB: 'test/integration/*.test.mjs',
      TOTAL: String(total),
      GH_TOKEN: 'token',
      GITHUB_API_URL: 'https://api.test',
      GITHUB_REPOSITORY: 'o/r',
      GITHUB_RUN_ID: '999',
      GITHUB_OUTPUT: join(dir, 'output'),
      RUNNER_TEMP: dir,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const out = Object.fromEntries(
    readFileSync(join(dir, 'output'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => [
        line.slice(0, line.indexOf('=')),
        JSON.parse(line.slice(line.indexOf('=') + 1)),
      ])
  );
  const calls = readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n');
  return {
    shards: out.split.map((s) =>
      s
        .split('\n')
        .filter(Boolean)
        .map((f) => f.slice(17, 18))
    ),
    stderr: result.stderr,
    calls,
  };
}

test('a file slow only in an older run is weighted by its slow time', () => {
  const { shards, stderr } = split(
    api({
      queued: [run(3, 'merge_group'), run(2, 'merge_group')],
      timings: [artifact(30, 'timings', 3), artifact(20, 'timings', 2)],
      zips: {
        30: [
          [
            'junit-0/0-1.times',
            times([
              ['a', 10],
              ['b', 10],
            ]),
          ],
          [
            'junit-1/1-1.times',
            times([
              ['c', 10],
              ['d', 10],
            ]),
            true,
          ],
        ],
        20: [
          [
            'junit-0/0-1.times',
            times([
              ['a', 100],
              ['b', 9],
              ['c', 9],
              ['d', 9],
            ]),
          ],
        ],
      },
    })
  );
  assert.deepEqual(shards, [['a'], ['b', 'c', 'd']]);
  assert.match(stderr, /shard 0: 1 files, ~100 s\nshard 1: 3 files, ~30 s\n/);
  assert.match(
    stderr,
    /timings for 4 of 4 files, 4 by wall time, the most each took in 2 runs \(merge_group 3, merge_group 2\)\n/
  );
});

test('it takes the last five runs with timings, merge queue runs first, never this run, a fork or an expired artifact', () => {
  const { stderr, calls } = split(
    api({
      queued: [run(999, 'merge_group'), run(8, 'merge_group'), run(7, 'merge_group')],
      pulls: [
        run(6, 'pull_request'),
        run(5, 'pull_request', 'fork/r'),
        run(4, 'pull_request'),
        run(3, 'pull_request'),
        run(2, 'pull_request'),
        run(1, 'pull_request'),
      ],
      timings: [9990, 80, 70, 60, 50, 40, 30, 20, 10].map((id) =>
        artifact(id, 'timings', id === 9990 ? 999 : id / 10, id === 70)
      ),
      zips: Object.fromEntries(
        [80, 60, 40, 30, 20, 10].map((id) => [id, [['junit-0/0-1.times', times([['a', id]])]]])
      ),
    })
  );
  assert.match(
    stderr,
    /the most each took in 5 runs \(merge_group 8, pull_request 6, pull_request 4, pull_request 3, pull_request 2\)\n/
  );
  assert.match(
    stderr,
    /shard 0: 2 files, ~160 s\nshard 1: 2 files, ~160 s\ntimings for 1 of 4 files/
  );
  assert.deepEqual(
    calls.filter((path) => path.endsWith('/zip')),
    [80, 60, 40, 30, 20].map((id) => `repos/o/r/actions/artifacts/${id}/zip`)
  );
});

test('before any run has uploaded timings, it reads the junit artifacts of the newest run that has them, as before', () => {
  const xml =
    '<testsuites><testcase name="x" file="/w/test/integration/d.test.mjs" time="40"/></testsuites>';
  const { shards, stderr } = split(
    api({
      queued: [run(3, 'merge_group'), run(2, 'merge_group')],
      perRun: {
        3: [artifact(31, 'integration-0', 3)],
        2: [
          artifact(21, 'junit-0', 2),
          artifact(22, 'junit-1', 2),
          artifact(23, 'junit-2', 2, true),
        ],
      },
      zips: {
        21: [
          ['0-1.times', times([['a', 30]])],
          ['0.xml', xml],
        ],
        22: [
          ['1-1.times', times([['b', 10]])],
          ['1.files', 'x'],
        ],
      },
    })
  );
  assert.deepEqual(shards, [
    ['d', 'b'],
    ['a', 'c'],
  ]);
  assert.match(
    stderr,
    /timings for 3 of 4 files, 2 by wall time, the most each took in 1 runs \(merge_group 2\)\n/
  );
});

test('when the API fails, every file counts the same and the split still comes out', () => {
  const fixture = api({ queued: [run(3, 'merge_group')], timings: [artifact(30, 'timings', 3)] });
  const { shards, stderr } = split(fixture);
  assert.deepEqual(shards, [
    ['a', 'c'],
    ['b', 'd'],
  ]);
  assert.match(
    stderr,
    /::warning title=Split::timings of earlier runs, stopped at repos\/o\/r\/actions\/artifacts\/30\/zip: 404\n/
  );
  assert.match(stderr, /timings for 0 of 4 files, 0 by wall time, the most each took in 0 runs\n/);
});

test('integration uploads the run timings as one artifact, and lint reads earlier runs through the API', () => {
  const upload = steps(job('integration')).find((step) => step.includes('name: timings'));
  assert.match(upload, /uses: actions\/upload-artifact@[0-9a-f]{40}\n/);
  assert.match(upload, /path: \|\n {12}junit\/\*\*\/\*\.times\n {12}junit\/\*\*\/\*\.xml\n/);
  assert.ok(
    job('integration').indexOf('name: timings') < job('integration').indexOf('integration: FAIL')
  );
  assert.doesNotMatch(job('lint'), /action-download-artifact/);
  assert.match(job('lint'), /GH_TOKEN: \$\{\{ github\.token \}\}\n/);
  assert.match(job('lint'), /permissions:\n {6}contents: read\n {6}actions: read\n/);
});
