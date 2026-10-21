import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { compile, format, inline, typed } from './typescript.mjs';

const swaps = { '.js': '.ts', '.mjs': '.mts', '.cjs': '.cts' };

const sibling = (specifier, parentURL) => {
  const ext = /^\.\.?\/.*(\.(m|c)?js)$/.exec(specifier)?.[1];
  if (!ext || !parentURL?.startsWith('file:')) return undefined;
  const swapped = specifier.slice(0, -ext.length) + swaps[ext];
  return existsSync(fileURLToPath(new URL(swapped, parentURL))) ? swapped : undefined;
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      const swapped =
        error?.code === 'ERR_MODULE_NOT_FOUND' && sibling(specifier, context.parentURL);
      if (!swapped) throw error;
      return nextResolve(swapped, context);
    }
  },
  load(url, context, nextLoad) {
    const { pathname } = new URL(url);
    if (pathname.endsWith('.json') && context.importAttributes?.type === undefined) {
      return nextLoad(url, {
        ...context,
        format: 'json',
        importAttributes: { ...context.importAttributes, type: 'json' },
      });
    }
    if (!url.startsWith('file:') || !typed.test(pathname) || pathname.includes('/node_modules/')) {
      return nextLoad(url, context);
    }
    const file = fileURLToPath(url);
    const output = compile(readFileSync(file, 'utf8'), file);
    if (output.map === undefined) return nextLoad(url, context);
    return {
      format: format(file, context.format, output.code),
      source: inline(output),
      shortCircuit: true,
    };
  },
});
