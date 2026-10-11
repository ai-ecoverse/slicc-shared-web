const done = new Set(['Network.loadingFinished', 'Network.loadingFailed']);
const landed = new Set([
  'Page.frameNavigated',
  'Page.frameStoppedLoading',
  'Page.navigatedWithinDocument',
]);

export function flights(now = Date.now) {
  const requests = new Map();
  const navigations = new Map();

  function watch({ method, params }) {
    if (method === 'Network.requestWillBeSent') {
      const { request, type = 'Other', requestId } = params;
      requests.set(requestId, { what: `${request.method} ${request.url} (${type})`, since: now() });
    }
    if (method === 'Network.responseReceived') {
      const flight = requests.get(params.requestId);
      if (flight) flight.status = params.response.status;
    }
    if (method === 'Network.dataReceived') {
      const flight = requests.get(params.requestId);
      if (flight) flight.bytes = (flight.bytes ?? 0) + params.dataLength;
    }
    if (done.has(method)) requests.delete(params.requestId);
    if (method === 'Page.frameStartedNavigating') {
      const what = `navigation to ${params.url} (${params.navigationType})`;
      navigations.set(params.frameId, { what, since: now() });
    }
    if (landed.has(method)) navigations.delete(params.frame?.id ?? params.frameId);
  }

  function pending() {
    const at = now();
    return [...navigations.values(), ...requests.values()]
      .sort((a, b) => a.since - b.since)
      .slice(0, 20)
      .map(({ what, since, status, bytes = 0 }) => {
        const answer = status ? `, answered ${status} with ${bytes} bytes of body so far` : '';
        return `pending ${what} for ${((at - since) / 1000).toFixed(1)}s${answer}`;
      });
  }

  function loaded(targetId) {
    requests.delete(targetId);
  }

  return { watch, loaded, pending };
}
