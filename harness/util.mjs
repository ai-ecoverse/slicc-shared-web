import { cwd } from 'node:process';
import { pathToFileURL } from 'node:url';

export const TIMED_OUT = Symbol('timed out');

const project = pathToFileURL(`${cwd()}/`);

export const artifacts = new URL('artifacts/', project);
export const cache = new URL('node_modules/.cache/slicc-harness/', project);
export const raw = new URL('coverage/', cache);
export const samples = new URL('hotspots/', cache);

export function ignore() {
  return null;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function bounded(promise, label, ms = 10000) {
  let timer;
  const expired = new Promise((resolve) => {
    timer = setTimeout(resolve, ms, TIMED_OUT);
  });
  const result = await Promise.race([promise, expired]).finally(() => clearTimeout(timer));
  if (result === TIMED_OUT) console.warn(`chrome: ${label} took over ${ms} ms, moving on`);
  return result;
}

export function slug(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}
