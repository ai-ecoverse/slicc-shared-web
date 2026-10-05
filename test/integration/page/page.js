function fib(n) {
  return n < 2 ? n : fib(n - 1) + fib(n - 2);
}

function ask(worker, message) {
  return new Promise((resolve) => {
    worker.addEventListener('message', ({ data }) => resolve(data), { once: true });
    worker.postMessage(message);
  });
}

window.fixture = {
  fib,
  worker: () => ask(new Worker('worker.js', { type: 'module' }), 24),
  shared: () => {
    const worker = new SharedWorker('shared.js', { type: 'module' });
    worker.port.start();
    return ask(worker.port, 20);
  },
  exit: () => ask(new Worker('exit.js', { type: 'module' }), 22),
  remote: (url) => fetch(url).then((response) => response.status),
};

console.log('page ready');
document.querySelector('#log').value = `fib ${fib(20)}`;
