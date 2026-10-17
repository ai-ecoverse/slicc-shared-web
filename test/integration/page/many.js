window.many = async (n) => {
  const times = [];
  for (let i = 0; i < n; i++) {
    const start = performance.now();
    const worker = new Worker('exit.js', { type: 'module' });
    await new Promise((resolve) => {
      worker.addEventListener('message', resolve, { once: true });
      worker.postMessage(12);
    });
    times.push(performance.now() - start);
  }
  return times;
};
