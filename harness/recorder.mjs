import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, relative } from 'node:path';
import { cwd } from 'node:process';
import { pathToFileURL } from 'node:url';
import { CRASHED } from './cdp.mjs';
import { trace } from './trace.mjs';
import { bounded, ignore, raw, samples, sleep, TIMED_OUT } from './util.mjs';

const profiled = new Set(['page', 'worker', 'service_worker', 'shared_worker']);
const nested = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true };
const sampling = [['Profiler.setSamplingInterval', { interval: 100 }], ['Profiler.start']];
const unload = "addEventListener('beforeunload', () => { debugger; })";

function pathOf(url) {
  return URL.canParse(url) ? new URL(url).pathname : '';
}

export function label(target) {
  return target.type === 'page' ? 'page' : basename(pathOf(target.url), '.js') || target.type;
}

export async function breakpoints(server, exits) {
  const found = new Map();
  for (const [path, patterns] of Object.entries(exits)) {
    const file = server.locate(path);
    const text = file ? await readFile(file, 'utf8').catch(() => '') : '';
    const lines = text.split('\n');
    const numbers = patterns
      .map((pattern) => lines.findIndex((line) => pattern.test(line)))
      .filter((n) => n >= 0);
    found.set(path, numbers);
  }
  return found;
}

export function covered(server, prefixes) {
  return ({ url }) => {
    if (!server.source(url)) return false;
    const { pathname, protocol } = new URL(url);
    const ours = protocol === 'chrome-extension:' || prefixes.some((p) => pathname.startsWith(p));
    return ours && /\.m?js$/.test(pathname) && !pathname.includes('/node_modules/');
  };
}

export function selfTimes(profile, server, into) {
  const frames = new Map(profile.nodes.map((node) => [node.id, node.callFrame]));
  profile.samples.forEach((id, i) => {
    const { url, functionName, lineNumber, columnNumber } = frames.get(id);
    const file = url.includes('/node_modules/') ? null : server.source(url);
    if (!file) return;
    const top = lineNumber === 0 && columnNumber === 0 ? '(top level)' : '(anonymous)';
    const key = `${relative(cwd(), file)}:${lineNumber + 1} ${functionName || top}`;
    into[key] = (into[key] ?? 0) + (profile.timeDeltas[i + 1] ?? 0);
  });
  return into;
}

async function entry(server, script) {
  const file = server.source(script.url);
  const source = await readFile(file, 'utf8').catch(ignore);
  if (source === null || server.overridden.has(new URL(script.url).pathname)) return null;
  const map = await readFile(`${file}.map`, 'utf8').catch(ignore);
  return {
    ...script,
    url: pathToFileURL(file).href,
    source,
    ...(map ? { sourceMap: JSON.parse(map) } : {}),
  };
}

function frames(params) {
  return (params.callFrames ?? [])
    .slice(0, 3)
    .map(
      (frame) =>
        `${frame.functionName || '(anonymous)'} ${pathOf(frame.url) || frame.url}:${frame.location.lineNumber + 1}`
    )
    .join(' < ');
}

async function sample(cdp, pauses, [sessionId, target], dir, tag, profiling) {
  const send = (method) => cdp.send(method, {}, sessionId, 8000);
  const pause = pauses.get(sessionId);
  const state = pause ? `paused (${pause.reason})` : 'running';
  if (!profiling) return `${label(target)}: ${state}`;
  const stopped = await send('Profiler.stop').catch((error) => ({ error }));
  send('Profiler.start').catch(ignore);
  if (!stopped.profile) return `${label(target)}: ${state}, no profile (${stopped.error?.message})`;
  const name = `${tag}-${label(target)}-${sessionId.slice(0, 6)}.cpuprofile`;
  await writeFile(new URL(name, dir), JSON.stringify(stopped.profile)).catch(ignore);
  return `${label(target)}: ${state}, profile ${name}`;
}

function collect(send, profiling) {
  const stop = profiling ? send('Profiler.stop') : {};
  const taken = Promise.all([send('Profiler.takePreciseCoverage'), stop]);
  return Promise.race([taken, sleep(3000)]).then(
    (answer) => answer ?? [{}, {}],
    () => [{}, {}]
  );
}

function held(pauses) {
  return [...pauses.values()].map(
    (pause) =>
      `paused ${pause.type} ${pause.targetId} ${pause.url} since ${pause.since}: ${pause.reason}`
  );
}

function pauseOf(target = {}, params) {
  return {
    type: target.type ?? 'unknown',
    targetId: target.targetId ?? '?',
    url: target.url ?? '?',
    since: new Date().toISOString(),
    reason: `${params.reason}: ${frames(params)}`,
  };
}

function claim(run) {
  if (!run || run.traced) return false;
  run.traced = true;
  return true;
}

function contextOf(sessions, parents, sessionId) {
  for (let id = sessionId; id; id = parents.get(id)) {
    const context = sessions.get(id)?.browserContextId;
    if (context) return context;
  }
  return undefined;
}

export function recorder(cdp, server, { coverage = ['/'], exits = new Map(), profiling } = {}) {
  const sessions = new Map();
  const pauses = new Map();
  const parents = new Map();
  const tabs = new Map();
  const early = [];
  const ours = covered(server, coverage);
  let run = null;

  async function dump(sessionId, target, restart) {
    const current = run;
    const send = (method) => cdp.send(method, {}, sessionId);
    const [{ result }, { profile }] = await collect(send, profiling);
    if (!(result && current)) return;
    current.scripts.push(...result.filter(ours));
    if (!profile) return;
    if (restart) send('Profiler.start').catch(ignore);
    current.profiles += 1;
    selfTimes(profile, server, current.self);
    const name = `${String(current.profiles).padStart(3, '0')}-${label(target)}.cpuprofile`;
    await writeFile(new URL(name, current.dir), JSON.stringify(profile));
  }

  async function checkpoint() {
    const current = [...sessions].filter(([, target]) => target.browserContextId === run?.context);
    await Promise.all(current.map(([sessionId, target]) => dump(sessionId, target, true)));
  }

  function tab(targetId) {
    if (!tabs.has(targetId)) {
      const slot = {};
      slot.session = new Promise((resolve) => {
        slot.resolve = resolve;
      });
      tabs.set(targetId, slot);
    }
    return tabs.get(targetId);
  }

  function commands({ type, url }) {
    const list = [];
    if (profiled.has(type)) {
      list.push(
        ['Runtime.enable'],
        ['Profiler.enable'],
        ['Profiler.startPreciseCoverage', { callCount: true, detailed: true }],
        ['Target.setAutoAttach', nested]
      );
      if (profiling) list.push(...sampling);
    }
    const lines = type === 'worker' ? exits.get(pathOf(url)) : undefined;
    if (lines) {
      list.push(
        ['Debugger.enable'],
        ...lines.map((lineNumber) => ['Debugger.setBreakpointByUrl', { url, lineNumber }])
      );
    }
    if (type === 'page') {
      list.push(
        ['Network.enable'],
        ['Debugger.enable'],
        ['Page.enable'],
        ['Page.addScriptToEvaluateOnNewDocument', { source: unload }]
      );
    }
    return list;
  }

  function attach({ sessionId, targetInfo, waitingForDebugger }) {
    if (profiled.has(targetInfo.type)) sessions.set(sessionId, targetInfo);
    const list = commands(targetInfo);
    if (waitingForDebugger) list.push(['Runtime.runIfWaitingForDebugger']);
    const ready = Promise.all(
      list.map(([method, params]) => cdp.send(method, params, sessionId).catch(ignore))
    );
    if (targetInfo.type === 'page') tab(targetInfo.targetId).resolve(ready.then(() => sessionId));
    return ready;
  }

  function log(sessionId, line) {
    const target = sessions.get(sessionId);
    const into = run ? target?.browserContextId === run.context && run.console : target && early;
    if (into) into.push(`${label(target)}: ${line}`);
  }

  async function capture(sessionId, target) {
    if (target?.type === 'worker') return dump(sessionId, target, false);
    const { result } = await cdp
      .send('Runtime.evaluate', { expression: 'location.href', returnByValue: true }, sessionId)
      .catch(() => ({ result: {} }));
    if (result?.value && result.value !== 'about:blank') await checkpoint();
  }

  async function paused(sessionId) {
    try {
      await bounded(capture(sessionId, sessions.get(sessionId)).catch(ignore), 'pause', 10000);
    } finally {
      await cdp.send('Debugger.resume', {}, sessionId, 10000).catch(ignore);
    }
  }

  async function stall(dir, tag, pending = []) {
    const first = claim(run);
    const current = [...sessions].filter(
      ([sessionId]) => contextOf(sessions, parents, sessionId) === run?.context
    );
    const sampled = () =>
      Promise.all(current.map((entry) => sample(cdp, pauses, entry, dir, tag, profiling)));
    const [lines, traced] = first ? await trace(cdp, dir, tag, sampled) : [await sampled(), []];
    const all = [...pending, ...lines, ...traced, ...held(pauses)];
    for (const line of all) run?.console.push(`${tag}: ${line}`);
    return all;
  }

  cdp.on(async ({ method, params, sessionId }) => {
    if (method === 'Target.attachedToTarget') {
      if (sessionId) parents.set(params.sessionId, sessionId);
      await attach(params);
    }
    if (method === 'Target.detachedFromTarget') {
      sessions.delete(params.sessionId);
      pauses.delete(params.sessionId);
    }
    if (method === 'Runtime.consoleAPICalled') {
      const text = params.args.map((arg) => arg.value ?? arg.description).join(' ');
      log(sessionId, `${params.type} ${text}`);
    }
    if (method === 'Runtime.exceptionThrown') {
      const { exception, text } = params.exceptionDetails;
      log(sessionId, `uncaught ${exception?.description ?? text}`);
    }
    if (method === 'Debugger.paused') {
      pauses.set(sessionId, pauseOf(sessions.get(sessionId), params));
      await paused(sessionId);
    }
    if (method === 'Debugger.resumed') pauses.delete(sessionId);
    if (method === CRASHED) log(sessionId, params.reason);
  });

  async function open(browserContextId) {
    const { targetId } = await cdp.send('Target.createTarget', {
      url: 'about:blank',
      browserContextId,
    });
    const sessionId = await bounded(tab(targetId).session, 'attach');
    tabs.delete(targetId);
    if (sessionId === TIMED_OUT) throw new Error(`Target.createTarget: ${targetId} never attached`);
    if (run && !run.context) run.context = sessions.get(sessionId)?.browserContextId;
    return { sessionId, targetId };
  }

  function begin(context, dir, name) {
    run = { context, dir, name, scripts: [], console: early.splice(0), profiles: 0, self: {} };
  }

  async function end() {
    await checkpoint();
    const current = run;
    run = null;
    const entries = await Promise.all(current.scripts.map((script) => entry(server, script)));
    const found = { profiles: current.profiles, self: current.self };
    await mkdir(raw, { recursive: true });
    await mkdir(samples, { recursive: true });
    await Promise.all([
      writeFile(new URL(`${current.name}.json`, raw), JSON.stringify(entries.filter(Boolean))),
      writeFile(new URL(`${current.name}.json`, samples), JSON.stringify(found)),
      writeFile(
        new URL('console.log', current.dir),
        current.console.map((line) => `${line}\n`).join('')
      ),
    ]);
  }

  return { open, begin, end, stall };
}
