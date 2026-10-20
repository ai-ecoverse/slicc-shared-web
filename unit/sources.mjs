import { readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export function unitSources(root = process.cwd()) {
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
  const list = pkg?.slicc?.unitSources;
  if (list === undefined) return null;
  if (
    !Array.isArray(list) ||
    !list.length ||
    !list.every(
      (d) =>
        typeof d === 'string' &&
        /^[\w.-]+(\/[\w.-]+)*$/.test(d) &&
        d.split('/').every((p) => p !== '.' && p !== '..')
    )
  )
    throw new Error(
      `package.json slicc.unitSources must be a list of repo-relative directories, not ${JSON.stringify(list)}`
    );
  return list;
}

export function inSources(file, root = process.cwd(), list = unitSources(root)) {
  const parts = relative(root, join(root, file)).split(sep);
  if (parts[0] === '..' || parts.includes('node_modules')) return false;
  if (!list) return parts.includes('src');
  return list.some((dir) => {
    const want = dir.split('/');
    return want.every((p, i) => parts[i] === p) && parts.length > want.length;
  });
}
