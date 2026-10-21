import { fileURLToPath } from 'node:url';

export const preload = fileURLToPath(new URL('select.cjs', import.meta.url));
export const loader = new URL('transform.mjs', import.meta.url).href;

export function inject(options = process.env.NODE_OPTIONS ?? '') {
  const flag = `--require ${/\s/.test(preload) ? `"${preload}"` : preload}`;
  const flags = [options.includes(preload) ? '' : flag];
  if (!options.includes(loader)) flags.push(`--import ${loader}`);
  return [options, ...flags].filter(Boolean).join(' ');
}
