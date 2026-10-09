import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { join, normalize, sep } from 'node:path';

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
