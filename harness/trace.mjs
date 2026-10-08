import { writeFile } from 'node:fs/promises';
import { bounded, sleep } from './util.mjs';

export const TRACED = [
  'toplevel',
  'ipc',
  'disabled-by-default-ipc.flow',
  'mojom',
  'blink',
  'loading',
  'navigation',
  'devtools.timeline',
  'disabled-by-default-devtools.timeline',
  'v8.execute',
  'disabled-by-default-v8.cpu_profiler',
];

function where({ functionName, url, lineNumber }) {
  const path = URL.canParse(url) ? new URL(url).pathname : url;
  const name = functionName || '(anonymous)';
  return path ? `${name} ${path}:${lineNumber + 1}` : name;
}

function threads(events) {
  const names = new Map();
  const processes = new Map();
  for (const { name, pid, tid, args } of events) {
    if (name === 'thread_name') names.set(`${pid}:${tid}`, args.name);
    if (name === 'process_name') processes.set(pid, args.name);
  }
  return { names, processes };
}

function detail(event) {
  const data = event.args?.data ?? event.args?.beginData ?? {};
  const tag = event.args?.chrome_mojo_event_info?.mojo_interface_tag;
  if (typeof data.functionName === 'string') {
    return where({ ...data, lineNumber: (data.lineNumber ?? 1) - 1 });
  }
  return data.url ?? event.args?.url ?? tag ?? '';
}

function labels(slices) {
  const named = slices.map((event) => `${event.name} ${detail(event)}`.trim());
  return named
    .filter((name, i) => name !== named[i - 1])
    .slice(0, 10)
    .join(' > ');
}

function inside(slices, task) {
  const end = task.ts + task.dur;
  return slices
    .filter(
      ({ ph, ts, dur }) => ph === 'X' && ts >= task.ts && ts + dur <= end && dur >= task.dur / 2
    )
    .sort((a, b) => a.ts - b.ts || b.dur - a.dur);
}

function main(pid, slices, last) {
  const tasks = slices.filter(({ name, ph }) => name === 'RunTask' && ph === 'X');
  const longest = tasks.reduce((most, task) => (task.dur > (most?.dur ?? 0) ? task : most), null);
  const open = slices.filter(({ ph, ts }) => ph === 'B' && ts < last - 50000);
  const head = `renderer ${pid} main thread: ${tasks.length} tasks`;
  if (open.length) return `${head}, still in ${labels(open)}`;
  if (!longest) return head;
  const ms = (longest.dur / 1000).toFixed(1);
  return longest.dur < 50000
    ? `${head}, longest ${ms} ms`
    : `${head}, longest ${ms} ms in ${labels(inside(slices, longest))}`;
}

function mains(events, { names, processes }) {
  const found = new Map();
  const last = events.reduce((most, { ts = 0 }) => Math.max(most, ts), 0);
  for (const event of events) {
    const ours = names.get(`${event.pid}:${event.tid}`) === 'CrRendererMain';
    if (!ours || processes.get(event.pid) !== 'Renderer' || event.ph === 'M') continue;
    found.set(event.pid, [...(found.get(event.pid) ?? []), event]);
  }
  return [...found].map(([pid, slices]) => main(pid, slices, last));
}

function stack(nodes, id) {
  const frames = [];
  for (let node = nodes.get(id); node && frames.length < 3; node = nodes.get(node.parent)) {
    frames.push(where(node.callFrame));
  }
  return frames.join(' < ');
}

function profiles(events) {
  const streams = new Map();
  for (const event of events) {
    if (event.name !== 'ProfileChunk') continue;
    const key = `${event.pid} ${event.id}`;
    const stream = streams.get(key) ?? { pid: event.pid, nodes: new Map(), counts: new Map() };
    const { nodes = [], samples = [] } = event.args.data.cpuProfile ?? {};
    for (const node of nodes) stream.nodes.set(node.id, node);
    for (const id of samples) stream.counts.set(id, (stream.counts.get(id) ?? 0) + 1);
    streams.set(key, stream);
  }
  return [...streams.values()].filter(({ counts }) => counts.size > 0).map(busiest);
}

function busiest({ pid, nodes, counts }) {
  const total = [...counts.values()].reduce((sum, n) => sum + n, 0);
  const ranked = [...counts].sort((a, b) => b[1] - a[1]);
  const share = (n) => `${Math.round((100 * n) / total)}%`;
  const [id, most] = ranked[0];
  const named = nodes.has(id) ? stack(nodes, id) : `node ${id}, named before the trace began`;
  const line = `samples in ${pid}: ${share(most)} of ${total} samples in ${named}`;
  const script = ranked.find(
    ([n]) => nodes.has(n) && !nodes.get(n).callFrame.functionName.startsWith('(')
  );
  if (!script || script[0] === id || script[1] * 100 < total) return line;
  return `${line}, ${share(script[1])} in ${stack(nodes, script[0])}`;
}

export function summary(events) {
  const known = threads(events);
  return [...mains(events, known), ...profiles(events)];
}

async function cpuTimes(cdp) {
  const { processInfo = [] } = await cdp
    .send('SystemInfo.getProcessInfo', {}, undefined, 5000)
    .catch(() => ({}));
  return new Map(processInfo.map((info) => [`${info.type} ${info.id}`, info.cpuTime]));
}

async function begin(cdp) {
  const traceConfig = { includedCategories: TRACED };
  try {
    await cdp.send(
      'Tracing.start',
      { traceConfig, transferMode: 'ReportEvents' },
      undefined,
      10000
    );
    return [];
  } catch (error) {
    if (!/no answer/.test(error.message)) throw error;
    return [`${error.message}, a renderer may be blocked; tracing anyway`];
  }
}

export async function trace(cdp, dir, tag, during = () => [], ms = 10000) {
  const events = [];
  let ran = null;
  const done = Promise.withResolvers();
  const off = cdp.on(({ method, params }) => {
    if (method === 'Tracing.dataCollected') events.push(...params.value);
    if (method === 'Tracing.tracingComplete') done.resolve();
  });
  try {
    const before = await cpuTimes(cdp);
    const late = await begin(cdp);
    ran = during();
    await sleep(ms);
    await cdp.send('Tracing.end', {}, undefined, 10000);
    await bounded(done.promise, 'trace', 20000);
    const after = await cpuTimes(cdp);
    await writeFile(new URL(`${tag}-trace.json`, dir), JSON.stringify({ traceEvents: events }));
    const busy = [...after]
      .map(([name, time]) => [name, time - (before.get(name) ?? 0)])
      .filter(([, used]) => used > 0.05)
      .map(([name, used]) => `${name} ${used.toFixed(1)}s`);
    const lines = [
      ...late,
      `trace ${tag}-trace.json (${events.length} events)`,
      `cpu over ${ms / 1000}s: ${busy.join(', ') || 'none'}`,
      ...summary(events),
    ];
    return [await ran, lines];
  } catch (error) {
    return [await (ran ?? during()), [`trace failed: ${error.message}`]];
  } finally {
    off();
  }
}
