const version = 'version 1';
const page = `<title>${version}</title><script>
sessionStorage.answered = Date.now();
window.started = [];
const note = ({ data }) => window.started.push(data);
new Worker('/dedicated.js').addEventListener('message', note);
const shared = new SharedWorker('/shared.js');
shared.port.addEventListener('message', note);
shared.port.start();
</script>`;
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  if (new URL(event.request.url).pathname === '/next')
    event.respondWith(new Response(page, { headers: { 'content-type': 'text/html' } }));
});
