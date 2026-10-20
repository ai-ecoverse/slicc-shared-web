import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { compile, format, inline, typed } from './typescript.mjs';

registerHooks({
  load(url, context, nextLoad) {
    const { pathname } = new URL(url);
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
