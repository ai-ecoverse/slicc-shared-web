import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { launch } from '../../harness/index.mjs';

const ours = async () =>
  new Set(
    (await readdir(tmpdir())).filter(
      (name) => name.startsWith('slicc-harness-') || name.startsWith('slicc-crashes-')
    )
  );

test('an executable that is not a file is refused before anything starts', async () => {
  await assert.rejects(
    launch({ roots: [['/', 'test/integration/page/']], executable: '/nonexistent/chrome' }),
    /launch\(\{ executable \}\) is \/nonexistent\/chrome, which is not a file/
  );
});

test('a browser that exits at once leaves no server or directories behind', async () => {
  const before = await ours();
  await assert.rejects(
    launch({ roots: [['/', 'test/integration/page/']], executable: '/usr/bin/false' }),
    /browser exited with code 1/
  );
  const left = [...(await ours())].filter((name) => !before.has(name));
  assert.deepEqual(left, []);
});
