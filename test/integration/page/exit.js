function last(n) {
  return n < 2 ? n : last(n - 1) + last(n - 2);
}

self.addEventListener('message', ({ data }) => {
  self.postMessage(last(data));
  self.close();
});
