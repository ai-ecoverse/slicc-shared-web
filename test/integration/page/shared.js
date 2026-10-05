function wide(n) {
  return n < 2 ? n : wide(n - 1) + wide(n - 2);
}

self.addEventListener('connect', ({ ports: [port] }) => {
  port.addEventListener('message', ({ data }) => port.postMessage(wide(data)));
  port.start();
});
