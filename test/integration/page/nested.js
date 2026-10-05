function deep(n) {
  return n < 2 ? n : deep(n - 1) + deep(n - 2);
}

self.addEventListener('message', ({ data }) => {
  console.log('nested done');
  self.postMessage(deep(data));
});
