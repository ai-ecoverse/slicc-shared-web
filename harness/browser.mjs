import { statSync } from 'node:fs';
import { env as inherited } from 'node:process';

const load = (name) => import(name);

function missing(error, name) {
  if (error?.code !== 'ERR_MODULE_NOT_FOUND') return false;
  return String(error.message).includes(`'${name}'`);
}

async function optional(name, importer) {
  try {
    return await importer(name);
  } catch (error) {
    if (missing(error, name)) return null;
    throw error;
  }
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export const HINT =
  'no Chromium for the harness: pass launch({ executable }), set CHROME_PATH, or install @ai-ecoverse/slicc-cdp and run `npx slicc-cdp install-browser --version <x.y.z.w>` (or install playwright-core and run `npx playwright-core install chromium`)';

export function explicit(path) {
  if (isFile(path)) return path;
  throw new Error(`launch({ executable }) is ${path}, which is not a file`);
}

export async function executablePath({ env = inherited, importer = load } = {}) {
  if (env.CHROME_PATH) {
    if (isFile(env.CHROME_PATH)) return env.CHROME_PATH;
    throw new Error(`CHROME_PATH is ${env.CHROME_PATH}, which is not a file`);
  }
  const cdp = await optional('@ai-ecoverse/slicc-cdp', importer);
  if (typeof cdp?.findBrowser === 'function') {
    const found = await cdp.findBrowser({ env });
    if (found) return found.executable;
  }
  const playwright = await optional('playwright-core', importer);
  const path = playwright?.chromium?.executablePath();
  if (path && isFile(path)) return path;
  throw new Error(path ? `${HINT}; playwright-core's ${path} is not installed` : HINT);
}
