import { fileURLToPath } from 'node:url';

export const preload = fileURLToPath(new URL('select.cjs', import.meta.url));

export function inject(options = process.env.NODE_OPTIONS ?? '') {
  if (options.includes(preload)) return options;
  const flag = `--require ${/\s/.test(preload) ? `"${preload}"` : preload}`;
  return options ? `${options} ${flag}` : flag;
}
