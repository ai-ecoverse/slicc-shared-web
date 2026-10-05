function spin(n) {
  return n < 2 ? n : spin(n - 1) + spin(n - 2);
}

self.addEventListener('message', async ({ data }) => {
  const nested = new Worker('nested.js', { type: 'module' });
  const inner = await new Promise((resolve) => {
    nested.addEventListener('message', (event) => resolve(event.data), { once: true });
    nested.postMessage(data);
  });
  console.log('worker done');
  self.postMessage({ outer: spin(data), inner });
});
