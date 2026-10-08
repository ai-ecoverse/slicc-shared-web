import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, relative } from 'node:path';
import { cwd } from 'node:process';
import { pathToFileURL } from 'node:url';
import { bounded, ignore, raw, samples, sleep, TIMED_OUT } from './util.mjs';

const profiled = new Set(['page', 'worker', 'service_worker', 'shared_worker']);
const nested = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true };
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

async function sample(cdp, pauses, [sessionId, target], dir, tag) {
  const send = (method) => cdp.send(method, {}, sessionId, 8000);
  const stopped = await send('Profiler.stop').catch((error) => ({ error }));
  send('Profiler.start').catch(ignore);
  const pause = pauses.get(sessionId);
  const state = pause ? `paused (${pause.reason})` : 'running';
  if (!stopped.profile) return `${label(target)}: ${state}, no profile (${stopped.error?.message})`;
  const name = `${tag}-${label(target)}-${sessionId.slice(0, 6)}.cpuprofile`;
  await writeFile(new URL(name, dir), JSON.stringify(stopped.profile)).catch(ignore);
  return `${label(target)}: ${state}, profile ${name}`;
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

const TRACED = [
  'toplevel',
  'devtools.timeline',
  'disabled-by-default-devtools.timeline',
  'v8.execute',
  'disabled-by-default-v8.cpu_profiler',
];

async function cpuTimes(cdp) {
  const { processInfo = [] } = await cdp
    .send('SystemInfo.getProcessInfo', {}, undefined, 5000)
    .catch(() => ({}));
  return new Map(processInfo.map((info) => [`${info.type} ${info.id}`, info.cpuTime]));
}

export async function trace(cdp, dir, tag, ms = 10000) {
  const events = [];
  const done = Promise.withResolvers();
  const off = cdp.on(({ method, params }) => {
    if (method === 'Tracing.dataCollected') events.push(...params.value);
    if (method === 'Tracing.tracingComplete') done.resolve();
  });
  try {
    const before = await cpuTimes(cdp);
    await cdp.send(
      'Tracing.start',
      { traceConfig: { includedCategories: TRACED }, transferMode: 'ReportEvents' },
      undefined,
      10000
    );
    await sleep(ms);
    await cdp.send('Tracing.end', {}, undefined, 10000);
    await bounded(done.promise, 'trace', 20000);
    const after = await cpuTimes(cdp);
    await writeFile(new URL(`${tag}-trace.json`, dir), JSON.stringify({ traceEvents: events }));
    const busy = [...after]
      .map(([name, time]) => [name, time - (before.get(name) ?? 0)])
      .filter(([, used]) => used > 0.05)
      .map(([name, used]) => `${name} ${used.toFixed(1)}s`);
    return [
      `trace ${tag}-trace.json (${events.length} events)`,
      `cpu over ${ms / 1000}s: ${busy.join(', ') || 'none'}`,
    ];
  } catch (error) {
    return [`trace failed: ${error.message}`];
  } finally {
    off();
  }
}

function contextOf(sessions, parents, sessionId) {
  for (let id = sessionId; id; id = parents.get(id)) {
    const context = sessions.get(id)?.browserContextId;
    if (context) return context;
  }
  return undefined;
}

export function recorder(cdp, server, { coverage = ['/'], exits = new Map() } = {}) {
  const sessions = new Map();
  const pauses = new Map();
  const parents = new Map();
  const tabs = new Map();
  const ours = covered(server, coverage);
  let run = null;

  async function dump(sessionId, target, restart) {
    const current = run;
    const send = (method) => cdp.send(method, {}, sessionId);
    const taken = Promise.all([send('Profiler.takePreciseCoverage'), send('Profiler.stop')]);
    const [{ result }, { profile }] = await Promise.race([taken, sleep(3000)]).then(
      (answer) => answer ?? [{}, {}],
      () => [{}, {}]
    );
    if (!(result && current)) return;
    if (restart) send('Profiler.start').catch(ignore);
    current.scripts.push(...result.filter(ours));
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
        ['Profiler.setSamplingInterval', { interval: 100 }],
        ['Profiler.startPreciseCoverage', { callCount: true, detailed: true }],
        ['Profiler.start'],
        ['Target.setAutoAttach', nested]
      );
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
    if (!run || target?.browserContextId !== run.context) return;
    run.console.push(`${label(target)}: ${line}`);
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

  async function stall(dir, tag) {
    const first = Boolean(run && !run.traced);
    if (run) run.traced = true;
    const current = [...sessions].filter(
      ([sessionId]) => contextOf(sessions, parents, sessionId) === run?.context
    );
    const [lines, traced] = await Promise.all([
      Promise.all(current.map((entry) => sample(cdp, pauses, entry, dir, tag))),
      first ? trace(cdp, dir, tag) : [],
    ]);
    const all = [...lines, ...traced, ...held(pauses)];
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
    run = { context, dir, name, scripts: [], console: [], profiles: 0, self: {} };
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
