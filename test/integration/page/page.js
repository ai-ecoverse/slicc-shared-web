function fib(n) {
  return n < 2 ? n : fib(n - 1) + fib(n - 2);
}

function blockOnXhr(url, done) {
  const request = new XMLHttpRequest();
  request.open('GET', url, false);
  request.send();
  done(request.status);
}

function ask(worker, message) {
  return new Promise((resolve) => {
    worker.addEventListener('message', ({ data }) => resolve(data), { once: true });
    worker.postMessage(message);
  });
}

window.fixture = {
  fib,
  later: (url, ms) => new Promise((resolve) => setTimeout(blockOnXhr, ms, url, resolve)),
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
