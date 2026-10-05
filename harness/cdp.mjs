export async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  const pending = new Map();
  const listeners = new Set();
  let id = 0;
  const drop = (sessionId, reason) => {
    for (const [key, call] of pending) {
      if (call.sessionId !== sessionId) continue;
      pending.delete(key);
      call.reject(new Error(`${call.method}: ${reason}`));
    }
  };
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === 'Target.detachedFromTarget')
      drop(message.params.sessionId, 'target detached');
    if (message.method === 'Inspector.targetCrashed') drop(message.sessionId, 'target crashed');
    const call = pending.get(message.id);
    pending.delete(message.id);
    if (!call) for (const listener of listeners) listener(message);
    else if (message.error) call.reject(new Error(`${call.method}: ${message.error.message}`));
    else call.resolve(message.result);
  };
  socket.onclose = () => {
    for (const call of pending.values()) call.reject(new Error(`${call.method}: socket closed`));
  };
  return {
    send: (method, params = {}, sessionId) =>
      new Promise((resolve, reject) => {
        pending.set(++id, { method, sessionId, resolve, reject });
        socket.send(JSON.stringify({ id, method, params, sessionId }));
      }),
    on: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close: () => socket.close(),
  };
}
