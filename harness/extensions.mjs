import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export function extensionId(input) {
  const hex = createHash('sha256').update(input).digest('hex').slice(0, 32);
  return [...hex].map((digit) => String.fromCharCode(97 + Number.parseInt(digit, 16))).join('');
}

export async function unpacked(dirs) {
  const found = new Map();
  for (const dir of dirs) {
    const root = await realpath(dir);
    const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
    const id = extensionId(manifest.key ? Buffer.from(manifest.key, 'base64') : root);
    found.set(id, `${root}${sep}`);
  }
  return found;
}

export function extensionSource(found) {
  return (href) => {
    if (!href.startsWith('chrome-extension://')) return null;
    const { host, pathname } = new URL(href);
    const root = found.get(host);
    return root ? join(root, normalize(decodeURIComponent(pathname))) : null;
  };
}

export async function install(cdp, found) {
  for (const [expected, root] of [...found]) {
    const { id } = await cdp.send('Extensions.loadUnpacked', { path: root.slice(0, -1) });
    if (id !== expected) found.set(id, root);
  }
}

export const BUILTIN_PATH = fileURLToPath(new URL('./extension', import.meta.url));
export const BUILTIN_ID = 'ankmbodmgimjemnojmeddfcdlbocolob';
export const OPT_OUT = 'SLICC_HARNESS_EXTENSION';

export function builtinWanted(option, env) {
  const value = env[OPT_OUT];
  if (value !== undefined && value !== '0' && value !== '1') {
    throw new Error(
      `${OPT_OUT} is ${JSON.stringify(value)}; set it to 0 to leave the harness extension out, or 1 (or unset) to load it`
    );
  }
  if (option !== true && option !== false) {
    throw new Error(
      `launch({ extension }) is ${JSON.stringify(option)}; pass false to leave the harness extension out`
    );
  }
  return option && value !== '0';
}

export async function installBuiltin(cdp) {
  const { id } = await cdp.send('Extensions.loadUnpacked', {
    path: BUILTIN_PATH,
    enableInIncognito: true,
  });
  if (id !== BUILTIN_ID) {
    throw new Error(`the harness extension loaded as ${id}, not ${BUILTIN_ID}`);
  }
  return { id, path: BUILTIN_PATH };
}
