import { sleep } from './util.mjs';

const RUN_EVERY = 1000;
const RUN_POLL = 10000;
const RUN_QUIET = 60000;
const RUN_MAX = 30 * 60 * 1000;

const unanswered = (error) => /: no answer in \d+ ms$/.test(error.message);
const seconds = (ms) => `${Math.round(ms / 1000)} s`;

export function started(source, args) {
  return `(() => {
    const runs = (globalThis.sliccHarnessRuns ??= []);
    const slot = { done: false };
    runs.push(slot);
    Promise.resolve()
      .then(() => (${source})(...${JSON.stringify(args)}))
      .then(
        (value) => Object.assign(slot, { done: true, value }),
        (error) => Object.assign(slot, { done: true, error: String(error?.stack ?? error) })
      );
    return runs.length - 1;
  })()`;
}

export function polled(id, marker) {
  const mark = marker
    ? `(() => { try { return (${marker})(); } catch (error) { return 'marker threw ' + error; } })()`
    : 'null';
  return `(() => {
    const slot = globalThis.sliccHarnessRuns?.[${id}];
    if (!slot) throw new Error('the page lost the run (it navigated or reloaded)');
    if (slot.done) globalThis.sliccHarnessRuns[${id}] = { done: true };
    return { ...slot, mark: ${mark} };
  })()`;
}

function settings(first, rest) {
  const direct = typeof first === 'function';
  const options = direct ? {} : first;
  const [fn, ...args] = direct ? [first, ...rest] : rest;
  return {
    fn,
    args,
    marker: options.marker,
    progress: options.progress,
    everyMs: options.everyMs ?? RUN_EVERY,
    quietMs: options.quietMs ?? RUN_QUIET,
    maxMs: options.maxMs ?? RUN_MAX,
    label: options.label ?? String(fn).replace(/\s+/g, ' ').slice(0, 60),
  };
}

async function poll(expression, source) {
  try {
    return await expression(source, RUN_POLL);
  } catch (error) {
    if (error.fatal || !unanswered(error)) throw error;
    return undefined;
  }
}

async function probed(progress) {
  if (!progress) return null;
  try {
    return await progress();
  } catch (error) {
    return `threw ${error}`;
  }
}

export function runner({ expression, timeout, pending, capture }) {
  async function failure(run, last, why) {
    if (capture) await capture().catch(() => undefined);
    const lines = [`${run.label}: ${why}`];
    if (run.marker !== undefined) lines.push(`last marker: ${JSON.stringify(last.mark)}`);
    if (run.progress !== undefined) lines.push(`last progress: ${JSON.stringify(last.probe)}`);
    const flying = pending();
    lines.push(...(flying.length ? flying : ['nothing in flight']));
    return new Error(lines.join('\n'));
  }

  return async function run(first, ...rest) {
    const job = settings(first, rest);
    const watched = job.marker !== undefined || job.progress !== undefined;
    const id = await expression(started(String(job.fn), job.args), timeout);
    const source = polled(id, job.marker && String(job.marker));
    const begun = Date.now();
    const at = { seen: undefined, moved: begun, last: {} };
    for (;;) {
      await sleep(job.everyMs);
      const state = await poll(expression, source);
      if (state?.done) {
        if (state.error !== undefined) throw new Error(state.error);
        return state.value;
      }
      at.last = { mark: state ? state.mark : at.last.mark, probe: await probed(job.progress) };
      const signature = JSON.stringify([at.last.mark, at.last.probe]);
      const now = Date.now();
      if (signature !== at.seen) Object.assign(at, { seen: signature, moved: now });
      if (watched && now - at.moved >= job.quietMs) {
        const why = `no progress for ${seconds(now - at.moved)} after ${seconds(now - begun)}`;
        throw await failure(job, at.last, why);
      }
      if (now - begun >= job.maxMs) {
        throw await failure(
          job,
          at.last,
          `still running after ${seconds(now - begun)}, the outer bound`
        );
      }
    }
  };
}
