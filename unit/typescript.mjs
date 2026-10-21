import { createRequire, stripTypeScriptTypes } from 'node:module';
import { parse } from 'acorn';

const require = createRequire(import.meta.url);

export const typed = /\.(m|c)?ts$/;

function quiet(fn) {
  const emit = process.emitWarning;
  process.emitWarning = () => undefined;
  try {
    return fn();
  } finally {
    process.emitWarning = emit;
  }
}

export function compile(source, filename) {
  try {
    return { code: quiet(() => stripTypeScriptTypes(source)) };
  } catch (error) {
    if (error.code !== 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX') throw error;
  }
  const { transformSync } = require('amaro');
  const { code, map } = transformSync(source, { mode: 'transform', sourceMap: true, filename });
  return { code, map: { ...JSON.parse(map), sourcesContent: [source] } };
}

export const inline = ({ code, map }) =>
  `${code}\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString('base64')}\n`;

export function format(file, hint, code) {
  if (/\.mts$/.test(file)) return 'module';
  if (/\.cts$/.test(file)) return 'commonjs';
  if (hint === 'module-typescript' || hint === 'commonjs-typescript') return hint.slice(0, -11);
  try {
    parse(code, {
      ecmaVersion: 'latest',
      sourceType: 'script',
      allowHashBang: true,
      allowReturnOutsideFunction: true,
    });
    return 'commonjs';
  } catch {
    return 'module';
  }
}
