import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const repo = fileURLToPath(new URL('../../', import.meta.url));
const VERSIONS = ['2.5.15', '2.6.2'];

const FILES = {
  'README.md': [
    '| Input | Default | |',
    '|---|---|---|',
    "| `node-version` | `'24'` | the Node.js version every job sets up |",
    '| `a-much-longer-input-name` | none | |',
    '',
    '- **Outer:** a list',
    '  - **Inner:** a list',
    '    - **Property:** a list',
    '      - With `loose`, it says why,',
    '        - a self-signed leaf;',
    '        - otherwise the code.',
    '',
    '        It is never the name.',
    '    - **Certificate:** the next item',
    '',
  ].join('\n'),
  'docs/guide.markdown': ['| a | b |', '|---|---|', '| a long cell | x |', ''].join('\n'),
  '.github/workflows/ci.yml': [
    'name: CI',
    'on:',
    '  pull_request:',
    'jobs:',
    '  test:',
    "    runs-on: 'ubuntu-latest'",
    '    steps:',
    '      - uses: actions/setup-node@v6',
    '        with:',
    "          node-version: '26'",
    "      - run: npm test -- --grep 'quoted'",
    '',
  ].join('\n'),
  'pnpm-lock.yaml': [
    "lockfileVersion: '9.0'",
    '',
    'settings:',
    '  autoInstallPeers: true',
    '',
    'importers:',
    '',
    '  .:',
    '    dependencies:',
    "      '@ai-ecoverse/slicc-kernel':",
    '        specifier: 1.125.9',
    '        version: 1.125.9',
    '',
    'packages:',
    '',
    "  '@ai-ecoverse/slicc-kernel@1.125.9':",
    '    resolution: {integrity: sha512-AAAA}',
    "    engines: {node: '>=24'}",
    '',
    'snapshots:',
    '',
    "  '@ai-ecoverse/slicc-kernel@1.125.9': {}",
    '',
  ].join('\n'),
  'pnpm-workspace.yaml': ['packages:', "  - 'packages/*'", ''].join('\n'),
};

let root;
let fixture;
after(() => rm(root, { recursive: true, force: true }));

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'slicc-biome-'));
  fixture = join(root, 'fixture');
  const shared = join(fixture, 'node_modules/@ai-ecoverse/slicc-shared-web');
  await mkdir(shared, { recursive: true });
  await cp(join(repo, 'package.json'), join(shared, 'package.json'));
  await cp(join(repo, 'biome.json'), join(shared, 'biome.json'));
  await writeFile(join(fixture, '.gitignore'), 'node_modules/\n');
  await writeFile(
    join(fixture, 'biome.json'),
    '{ "extends": ["@ai-ecoverse/slicc-shared-web/biome"] }\n'
  );
  for (const [name, content] of Object.entries(FILES)) {
    await mkdir(dirname(join(fixture, name)), { recursive: true });
    await writeFile(join(fixture, name), content);
  }
  await Promise.all(
    VERSIONS.map((version) =>
      run(
        'npm',
        [
          'install',
          '--prefix',
          join(root, version),
          '--no-save',
          '--no-audit',
          '--no-fund',
          `@biomejs/biome@${version}`,
        ],
        { cwd: root, timeout: 300000 }
      )
    )
  );
});

function biome(version, args) {
  return run(join(root, version, 'node_modules/.bin/biome'), args, {
    cwd: fixture,
    timeout: 60000,
  }).then(
    ({ stdout, stderr }) => ({ code: 0, output: stdout + stderr }),
    (error) => ({ code: error.code, output: `${error.stdout}${error.stderr}` })
  );
}

async function unchanged() {
  for (const [name, content] of Object.entries(FILES)) {
    assert.equal(await readFile(join(fixture, name), 'utf8'), content, name);
  }
}

test('biome 2.6.2 checks Markdown and YAML under the shared config without formatting them', async () => {
  const checked = await biome('2.6.2', ['check', '--verbose', '--max-diagnostics=none', '.']);
  assert.equal(checked.code, 0, checked.output);
  for (const name of Object.keys(FILES)) {
    assert.match(checked.output, new RegExp(`^\\s+- ${name.replaceAll('.', '\\.')}$`, 'm'), name);
  }
  assert.doesNotMatch(checked.output, / format ━/, checked.output);
  const written = await biome('2.6.2', ['check', '--write', '.']);
  assert.equal(written.code, 0, written.output);
  await unchanged();
});

test('biome 2.5.15 loads the same shared config and passes the fixture', async () => {
  const checked = await biome('2.5.15', ['check', '--max-diagnostics=none', '.']);
  assert.equal(checked.code, 0, checked.output);
  assert.doesNotMatch(checked.output, /unknown key|deserialize/i, checked.output);
  assert.match(checked.output, /Checked \d+ files?/, checked.output);
  await unchanged();
});
