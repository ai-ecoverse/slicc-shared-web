const events = new Set([
  'Target.targetCreated',
  'Target.targetInfoChanged',
  'Target.targetDestroyed',
  'Target.attachedToTarget',
  'Target.detachedFromTarget',
  'Page.windowOpen',
  'Page.frameNavigated',
  'Page.loadEventFired',
  'Network.loadingFailed',
]);

export function targetLog(cdp) {
  const sessions = new Map();
  let lines = [];
  const log = (event) => lines.push(JSON.stringify({ at: new Date().toISOString(), ...event }));
  const resume = (sessionId, state, error) => {
    const result = { at: new Date().toISOString(), state, error: error?.message };
    const attached = sessions.get(sessionId);
    if (attached) attached.resume = result;
    log({ method: 'Runtime.runIfWaitingForDebugger', sessionId, ...result });
  };
  cdp.on(({ method, params, sessionId }) => {
    if (method === 'Target.attachedToTarget') {
      sessions.set(params.sessionId, { ...params, parent: sessionId });
    }
    if (method === 'Target.detachedFromTarget') sessions.delete(params.sessionId);
    if (method === 'Target.targetInfoChanged') {
      for (const attached of sessions.values()) {
        if (attached.targetInfo.targetId === params.targetInfo.targetId) {
          attached.targetInfo = params.targetInfo;
        }
      }
    }
    if (events.has(method)) log({ method, sessionId, params });
  });
  async function send(method, params, sessionId) {
    const waiting = method === 'Runtime.runIfWaitingForDebugger';
    if (waiting) resume(sessionId, 'sent');
    try {
      const result = await cdp.send(method, params, sessionId);
      if (waiting) resume(sessionId, 'answered');
      return result;
    } catch (error) {
      if (waiting) resume(sessionId, 'failed', error);
      else log({ method, sessionId, state: 'failed', error: error.message });
      return null;
    }
  }
  return {
    send,
    resume: (sessionId) => send('Runtime.runIfWaitingForDebugger', {}, sessionId),
    begin() {
      lines = [];
      for (const params of sessions.values()) log({ method: 'Harness.existingSession', params });
    },
    text: () => lines.map((line) => `${line}\n`).join(''),
  };
}
