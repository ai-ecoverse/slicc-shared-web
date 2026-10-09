import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { chromium } from 'playwright-core';
import { cdn } from './cdn.mjs';
import { connect } from './cdp.mjs';
import { extensionSource, unpacked } from './extensions.mjs';
import { page } from './page.mjs';
import { breakpoints, recorder } from './recorder.mjs';
import { serve } from './server.mjs';
import { artifacts, bounded, ignore, slug, TIMED_OUT } from './util.mjs';

export const flags = [
  '--headless',
  '--remote-debugging-port=0',
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
  const load = loaded
    ? [`--disable-extensions-except=${extensions}`, `--load-extension=${extensions}`]
    : [];
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
  executable = chromium.executablePath()
) {
  const child = spawn(executable, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  const stderr = lines(child.stderr);
  const exited = new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve(exitOf(code, signal)));
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

export async function stop(cdp, child) {
  const exited = new Promise((resolve) => child.once('exit', resolve));
  await bounded(cdp.send('Browser.close').catch(ignore), 'Browser.close');
  cdp.close();
  const running = child.exitCode === null && child.signalCode === null;
  if (running && (await bounded(exited, 'exit')) === TIMED_OUT) {
    child.kill('SIGKILL');
    await exited;
  }
}

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
  const server = await serve({ roots, aliases, isolated });
  const found = await unpacked(extensions);
  const fromExtension = extensionSource(found);
  const files = { ...server, source: (href) => server.source(href) ?? fromExtension(href) };
  const shared = extensions.length > 0;
  const profile = await mkdtemp(join(tmpdir(), 'slicc-harness-'));
  const loaded = [...found.values()].map((root) => root.slice(0, -1));
  const { child, url, exited, stderr } = await start(profile, commandLine(profile, loaded, args));
  const cdp = await connect(url, {
    exited,
    tail: () => stderr.tail().map((line) => `stderr: ${line}`),
  });
  const record = recorder(cdp, files, { coverage, exits: await breakpoints(server, exits) });
  const remote = await cdn(cdp, intercept);
  await cdp.send('Target.setDiscoverTargets', { discover: true });
  await cdp.send('Target.setAutoAttach', {
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: true,
  });

  async function tabs() {
    const { targetInfos } = await cdp.send('Target.getTargets');
    return targetInfos.filter(({ type }) => type === 'page').map(({ targetId }) => targetId);
  }

  async function sweep(before) {
    const added = (await tabs()).filter((targetId) => !before.has(targetId));
    const closing = added.map((targetId) => cdp.send('Target.closeTarget', { targetId }));
    await Promise.all(closing.map((sent) => sent.catch(ignore)));
  }

  async function finish(pages, browserContextId, dir, before, mark) {
    const log = stderr.since(mark).map((line) => `${line}\n`);
    await writeFile(new URL('chrome-stderr.log', dir), log.join(''));
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
      t.after(() => finish(pages, browserContextId, dir, before, mark));
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
      await server.close();
    },
  };
}
