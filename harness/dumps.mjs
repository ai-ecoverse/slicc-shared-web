import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { env } from 'node:process';
import { sleep } from './util.mjs';

export const DUMP_WAIT = 10000;

async function list(dir, sub) {
  return (await readdir(join(dir, sub)).catch(() => [])).map((file) => join(sub, file));
}

export async function crashpad() {
  const dir = await mkdtemp(join(tmpdir(), 'slicc-crashes-'));
  const kept = new Set();
  const scan = async () => {
    const [pending, completed, writing] = await Promise.all(
      ['pending', 'completed', 'new'].map((sub) => list(dir, sub))
    );
    const fresh = [...pending, ...completed].filter(
      (file) => file.endsWith('.dmp') && !kept.has(file)
    );
    return { fresh, writing: writing.some((file) => file.endsWith('.dmp')) };
  };
  return {
    dir,
    env: { ...env, BREAKPAD_DUMP_LOCATION: dir },
    async keep(target, ms = DUMP_WAIT) {
      const deadline = Date.now() + ms;
      let found = await scan();
      while ((found.fresh.length === 0 || found.writing) && Date.now() < deadline) {
        await sleep(250);
        found = await scan();
      }
      const names = [];
      for (const file of found.fresh) {
        kept.add(file);
        const name = basename(file);
        await copyFile(join(dir, file), new URL(name, target));
        names.push(name);
      }
      return names;
    },
    remove: () => rm(dir, { recursive: true, force: true }),
  };
}
