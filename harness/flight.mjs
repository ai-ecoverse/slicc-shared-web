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
      .map(({ what, since }) => `pending ${what} for ${((at - since) / 1000).toFixed(1)}s`);
  }

  function loaded(targetId) {
    requests.delete(targetId);
  }

  return { watch, loaded, pending };
}
