import { spawn, spawnSync } from 'node:child_process';
import { env as inherited, platform as running } from 'node:process';
import { bounded, TIMED_OUT } from './util.mjs';

const ci = (env) => Boolean(env.CI) && env.CI !== 'false' && env.CI !== '0';
const installed = () =>
  spawnSync('sh', ['-c', 'command -v Xvfb'], { stdio: 'ignore' }).status === 0;

export function wantsOwnDisplay({
  headed,
  env = inherited,
  platform = running,
  has = installed,
} = {}) {
  if (!headed || platform !== 'linux') return false;
  if (env.DISPLAY && !ci(env)) return false;
  return has();
}

function stopper(xvfb) {
  const exited = new Promise((resolve) => {
    if (xvfb.exitCode !== null || xvfb.signalCode !== null) resolve();
    else xvfb.once('exit', resolve);
  });
  return async () => {
    for (const signal of ['SIGTERM', 'SIGKILL']) {
      try {
        process.kill(-xvfb.pid, signal);
      } catch {}
      if ((await bounded(exited, 'Xvfb exit', 3000)) !== TIMED_OUT) return;
    }
  };
}

export async function ownDisplay(env = inherited) {
  const xvfb = spawn(
    'Xvfb',
    ['-displayfd', '3', '-screen', '0', '1920x1080x24', '-nolisten', 'tcp'],
    { detached: true, stdio: ['ignore', 'ignore', 'pipe', 'pipe'] }
  );
  const close = stopper(xvfb);
  let said = '';
  xvfb.stderr.on('data', (chunk) => {
    said = `${said}${chunk}`.slice(-2000);
  });
  const number = new Promise((resolve, reject) => {
    let out = '';
    xvfb.stdio[3].on('data', (chunk) => {
      out += chunk;
      const found = /^(\d+)\n/.exec(out);
      if (found) resolve(found[1]);
    });
    xvfb.once('error', reject);
    xvfb.once('exit', (code, signal) => reject(new Error(`Xvfb exited with ${signal ?? code}`)));
  });
  number.catch(() => {});
  const display = await bounded(number, 'Xvfb display', 10000).catch(async (error) => {
    await close();
    throw new Error(`${error.message}\n${said}`);
  });
  if (display === TIMED_OUT) {
    await close();
    throw new Error(`Xvfb named no display within 10 s\n${said}`);
  }
  return { env: { ...env, DISPLAY: `:${display}` }, child: xvfb, close };
}

export async function screenFor(headed, env = inherited) {
  if (!wantsOwnDisplay({ headed, env })) return { env, child: null, close: async () => {} };
  return ownDisplay(env);
}
