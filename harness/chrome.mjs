import { execFile, spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { env as inherited } from 'node:process';
import { promisify } from 'node:util';
import { chromium } from 'playwright-core';
import { cdn } from './cdn.mjs';
import { CRASHED, connect, pipe } from './cdp.mjs';
import { crashpad } from './dumps.mjs';
import { extensionSource, install, unpacked } from './extensions.mjs';
import { page } from './page.mjs';
import { breakpoints, recorder } from './recorder.mjs';
import { serve } from './server.mjs';
import { artifacts, bounded, ignore, sleep, slug, TIMED_OUT } from './util.mjs';

export const flags = [
  '--headless',
  '--remote-debugging-port=0',
  '--remote-debugging-pipe',
  '--no-first-run',
  '--no-default-browser-check',
  '--no-sandbox',
  '--disable-extensions',
  '--disable-component-extensions-with-background-pages',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--hide-scrollbars',
  '--mute-audio',
  '--window-size=1280,800',
];

export function commandLine(profile, extensions = [], extra = []) {
  const loaded = extensions.length > 0;
  const base = loaded ? flags.filter((flag) => flag !== '--disable-extensions') : flags;
  const load = loaded ? ['--enable-unsafe-extension-debugging'] : [];
  return [...base, ...load, ...extra, `--user-data-dir=${profile}`, 'about:blank'];
}

export const KEPT = 200;

export function lines(stream, kept = KEPT) {
  const last = [];
  let partial = '';
  let total = 0;
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    const split = `${partial}${chunk}`.split('\n');
    partial = split.pop();
    total += split.length;
    last.push(...split);
    last.splice(0, last.length - kept);
  });
  return {
    get total() {
      return total;
    },
    since: (mark) => last.slice(Math.max(0, last.length - (total - mark))),
    tail: (n = 5) => last.slice(-n),
  };
}

export function exitOf(code, signal) {
  return signal ? `browser exited with ${signal}` : `browser exited with code ${code}`;
}

export async function start(
  profile,
  args = commandLine(profile),
  executable = chromium.executablePath(),
  env = inherited
) {
  const child = spawn(executable, args, {
    env,
    detached: true,
    stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
  });
  const stderr = lines(child.stderr);
  const drained = new Promise((resolve) => child.stderr.once('close', resolve));
  const exited = new Promise((resolve) => {
    child.once('exit', (code, signal) => {
      const reason = exitOf(code, signal);
      void Promise.race([drained, sleep(1000)]).then(() => resolve(reason));
    });
  });
  const url = await new Promise((resolve, reject) => {
    child.stderr.on('data', () => {
      const match = stderr
        .tail(KEPT)
        .join('\n')
        .match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) resolve(match[1]);
    });
    child.once('error', reject);
    void exited.then((reason) => reject(new Error(`${reason}\n${stderr.tail(KEPT).join('\n')}`)));
  });
  return { child, url, exited, stderr };
}

export function died(child) {
  if (child.signalCode) return child.signalCode !== 'SIGKILL';
  return (child.exitCode ?? 0) !== 0;
}

export const WAITS = { close: 10000, exit: 10000, kill: 5000 };

export async function stop(cdp, child, waits = WAITS) {
  const gone = () => child.exitCode !== null || child.signalCode !== null;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  await bounded(cdp.send('Browser.close').catch(ignore), 'Browser.close', waits.close);
  cdp.close();
  if (gone() || (await bounded(exited, 'exit', waits.exit)) !== TIMED_OUT || gone()) return;
  kill(child);
  if (gone() || (await bounded(exited, 'exit after SIGKILL', waits.kill)) !== TIMED_OUT) return;
  if (!gone()) console.warn(`chrome: pid ${child.pid} still runs after SIGKILL, moving on`);
}

export const PREFIX = 'slicc-harness-';
export const DAY = 24 * 60 * 60 * 1000;
export const GRACE = 60 * 1000;

const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
const running = new Set();

export function kill(child) {
  if (child.pid > 0 && child.spawnargs?.length) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {}
  }
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

function remove(entries) {
  for (const { paths } of entries) {
    for (const path of paths) rmSync(path, { recursive: true, force: true });
  }
}

function reap() {
  const entries = [...running];
  for (const { children } of entries) children.forEach(kill);
  remove(entries);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  remove(entries);
  running.clear();
  unhook();
}

function reraise(signal) {
  reap();
  process.kill(process.pid, signal);
}

function hook() {
  process.on('exit', reap);
  for (const signal of signals) process.on(signal, reraise);
}

function unhook() {
  process.off('exit', reap);
  for (const signal of signals) process.off(signal, reraise);
}

export function watchdog(pid) {
  const dog = spawn('sh', ['-c', 'read -r _; kill -9 -"$0" "$0" 2>/dev/null', String(pid)], {
    detached: true,
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  dog.on('error', ignore);
  dog.stdin.on('error', ignore);
  return dog;
}

export function track(child, paths) {
  const dog = watchdog(child.pid);
  const entry = { children: [child, dog], paths };
  if (running.size === 0) hook();
  running.add(entry);
  return () => {
    running.delete(entry);
    if (running.size === 0) unhook();
    kill(dog);
  };
}

export async function commandLines() {
  const { stdout } = await promisify(execFile)('ps', ['axww', '-o', 'args='], {
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout.split('\n').map((line) => `${line} `);
}

export async function prune(dir = tmpdir(), grace = GRACE) {
  const lines = await commandLines().catch(ignore);
  const used = (path) => lines.some((line) => line.includes(`--user-data-dir=${path} `));
  const names = await readdir(dir).catch(() => []);
  const now = Date.now();
  const removing = names
    .filter((name) => name.startsWith(PREFIX))
    .map(async (name) => {
      const path = join(dir, name);
      const info = await lstat(path).catch(ignore);
      if (!info?.isDirectory()) return;
      const age = now - info.mtimeMs;
      const orphaned = lines !== null && age > grace && !used(path);
      if (age > DAY || orphaned) await rm(path, { recursive: true, force: true }).catch(ignore);
    });
  await Promise.all(removing);
}

let pruning = null;

export async function launch({
  roots,
  aliases,
  isolated,
  coverage,
  exits = {},
  intercept = [],
  extensions = [],
  args = [],
  timeout,
  stallAfter,
} = {}) {
  pruning ??= prune();
  await pruning;
  const server = await serve({ roots, aliases, isolated });
  const found = await unpacked(extensions);
  const fromExtension = extensionSource(found);
  const files = { ...server, source: (href) => server.source(href) ?? fromExtension(href) };
  const shared = extensions.length > 0;
  const profile = await mkdtemp(join(tmpdir(), PREFIX));
  const loaded = [...found.values()].map((root) => root.slice(0, -1));
  const dumps = await crashpad();
  const { child, exited, stderr } = await start(
    profile,
    commandLine(profile, loaded, args),
    chromium.executablePath(),
    dumps.env
  );
  const untrack = track(child, [profile, dumps.dir]);
  const cdp = await connect(pipe(child.stdio[3], child.stdio[4]), {
    exited,
    tail: () => stderr.tail().map((line) => `stderr: ${line}`),
  });
  let crashes = 0;
  let open = 0;
  let closed = false;
  cdp.on(({ method }) => {
    if (method === CRASHED || method === 'Target.targetCrashed') crashes += 1;
  });
  const record = recorder(cdp, files, { coverage, exits: await breakpoints(server, exits) });
  const remote = await cdn(cdp, intercept);
  await cdp.send('Target.setDiscoverTargets', { discover: true });
  await cdp.send('Target.setAutoAttach', {
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: true,
  });
  await install(cdp, found);

  async function tabs() {
    const { targetInfos } = await cdp.send('Target.getTargets');
    return targetInfos.filter(({ type }) => type === 'page').map(({ targetId }) => targetId);
  }

  async function sweep(before) {
    const added = (await tabs()).filter((targetId) => !before.has(targetId));
    const closing = added.map((targetId) => cdp.send('Target.closeTarget', { targetId }));
    await Promise.all(closing.map((sent) => sent.catch(ignore)));
  }

  async function finish(pages, browserContextId, dir, before, mark, seen) {
    const log = stderr.since(mark).map((line) => `${line}\n`);
    await writeFile(new URL('chrome-stderr.log', dir), log.join(''));
    if (crashes > seen || died(child)) await dumps.keep(dir).catch(ignore);
    open -= 1;
    if (closed && open === 0) await dumps.remove();
    await bounded(Promise.all(pages.map((opened) => opened.probed())), 'probes', 30000);
    const shots = pages.map((opened, i) =>
      opened.screenshot(new URL(`tab-${i + 1}.png`, dir)).catch(ignore)
    );
    await Promise.all(shots);
    await record.end();
    for (const opened of pages) opened.dispose();
    remote.reset();
    const closing = shared
      ? sweep(before)
      : cdp.send('Target.disposeBrowserContext', { browserContextId });
    await bounded(closing.catch(ignore), 'dispose');
  }

  return {
    url: server.url,
    pid: child.pid,
    profile,
    cdn: remote.state,
    requests: server.requests,
    overrides: server.overrides,
    async page(t) {
      const suite = slug(basename(t.filePath ?? 'test', '.test.mjs'));
      const dir = new URL(`${suite}/${slug(t.name)}/`, artifacts);
      await mkdir(dir, { recursive: true });
      const { browserContextId } = shared ? {} : await cdp.send('Target.createBrowserContext');
      const before = new Set(shared ? await tabs() : []);
      record.begin(browserContextId, dir, `${suite}-${slug(t.name)}`);
      server.requests.length = 0;
      server.overrides.clear();
      server.overridden.clear();
      const pages = [];
      const mark = stderr.total;
      const seen = crashes;
      open += 1;
      t.after(() => finish(pages, browserContextId, dir, before, mark, seen));
      const tab = async () => {
        const opened = page(cdp, await record.open(browserContextId), server, timeout, {
          stallAfter,
          stall: async (tag, png, pending) => {
            if (png) await writeFile(new URL(`${tag}.png`, dir), png).catch(ignore);
            await bounded(record.stall(dir, tag, pending), tag, 45000);
          },
        });
        pages.push(opened);
        return Object.assign(opened, { tab, dir });
      };
      return tab();
    },
    async close() {
      await stop(cdp, child);
      await rm(profile, { recursive: true, force: true });
      untrack();
      closed = true;
      if (open === 0) await dumps.remove();
      await server.close();
    },
  };
}
