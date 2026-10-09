export const SEND_TIMEOUT = 60000;
export const CRASHED = 'Harness.targetCrashed';

const kinds = {
  page: 'page',
  iframe: 'iframe',
  worker: 'worker',
  shared_worker: 'shared worker',
  service_worker: 'service worker',
};

export function fatal(message) {
  return Object.assign(new Error(message), { fatal: true });
}

function grace(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms, 'socket closed').unref());
}

async function websocket(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  return {
    send: (text) => socket.send(text),
    close: () => socket.close(),
    listen(message, closed) {
      socket.onmessage = ({ data }) => message(data);
      socket.onclose = closed;
    },
  };
}

export function pipe(input, output) {
  input.on('error', () => null);
  return {
    send: (text) => input.write(`${text}\0`),
    close: () => input.end(),
    listen(message, closed) {
      let partial = '';
      output.setEncoding('utf8');
      output.on('data', (chunk) => {
        const parts = `${partial}${chunk}`.split('\0');
        partial = parts.pop();
        for (const part of parts) message(part);
      });
      output.once('close', closed);
    },
  };
}

export async function connect(url, { exited, tail = () => [] } = {}) {
  const socket = typeof url?.listen === 'function' ? url : await websocket(url);
  const pending = new Map();
  const listeners = new Set();
  const targets = new Map();
  const crashed = new Map();
  let gone = null;
  let id = 0;
  const told = (reason) => [reason, ...tail()].join('\n');
  const drop = (matches, reason, error = Error) => {
    for (const [key, call] of pending) {
      if (!matches(call)) continue;
      pending.delete(key);
      call.reject(error(`${call.method}: ${reason}`));
    }
  };
  const notify = (message) => {
    for (const listener of listeners) listener(message);
  };
  const crash = (sessionId, status) => {
    const target = targets.get(sessionId);
    if (!target || crashed.has(sessionId)) return;
    const how = status ? ` (${status})` : '';
    const reason = `${kinds[target.type] ?? target.type} renderer crashed${how} at ${target.url}`;
    crashed.set(sessionId, reason);
    drop((call) => call.sessionId === sessionId, told(reason), fatal);
    notify({ method: CRASHED, sessionId, params: { reason } });
    for (const [child, { parent, type }] of targets) {
      if (parent === sessionId && type === 'worker') crash(child, status);
    }
  };
  const sessionsOf = (targetId) =>
    [...targets]
      .filter(([, target]) => target.targetId === targetId)
      .map(([sessionId]) => sessionId);
  const track = ({ method, params, sessionId }) => {
    if (method === 'Target.attachedToTarget')
      targets.set(params.sessionId, { ...params.targetInfo, parent: sessionId });
    if (method === 'Target.targetInfoChanged') {
      for (const session of sessionsOf(params.targetInfo.targetId)) {
        targets.set(session, { ...targets.get(session), url: params.targetInfo.url });
      }
    }
    if (method === 'Target.detachedFromTarget') {
      targets.delete(params.sessionId);
      drop((call) => call.sessionId === params.sessionId, 'target detached');
    }
    if (method === 'Inspector.targetCrashed') setTimeout(crash, 200, sessionId);
    if (method === 'Target.targetCrashed') {
      const status = `${params.status}, code ${params.errorCode}`;
      for (const session of sessionsOf(params.targetId)) crash(session, status);
    }
  };
  const die = (reason) => {
    if (gone) return;
    gone = reason;
    drop(() => true, told(reason), fatal);
  };
  socket.listen(
    (data) => {
      const message = JSON.parse(data);
      track(message);
      const call = pending.get(message.id);
      pending.delete(message.id);
      if (!call) notify(message);
      else if (message.error) call.reject(new Error(`${call.method}: ${message.error.message}`));
      else call.resolve(message.result);
    },
    async () => die(await Promise.race([exited ?? 'socket closed', grace(2000)]))
  );
  void exited?.then(die);
  return {
    send: (method, params = {}, sessionId, ms = SEND_TIMEOUT) =>
      new Promise((resolve, reject) => {
        const stopped = gone ?? crashed.get(sessionId);
        if (stopped) {
          reject(fatal(`${method}: ${told(stopped)}`));
          return;
        }
        const key = ++id;
        const timer = setTimeout(() => {
          pending.delete(key);
          reject(new Error(`${method}: no answer in ${ms} ms`));
        }, ms);
        const settle = (fn) => (value) => {
          clearTimeout(timer);
          fn(value);
        };
        pending.set(key, { method, sessionId, resolve: settle(resolve), reject: settle(reject) });
        socket.send(JSON.stringify({ id: key, method, params, sessionId }));
      }),
    on: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    target: (sessionId) => targets.get(sessionId),
    close: () => socket.close(),
  };
}
