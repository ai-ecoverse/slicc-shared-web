const version = 'version 1';
const page = `<title>${version}</title><script>sessionStorage.answered = Date.now()</script>`;
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  if (new URL(event.request.url).pathname === '/next')
    event.respondWith(new Response(page, { headers: { 'content-type': 'text/html' } }));
});
