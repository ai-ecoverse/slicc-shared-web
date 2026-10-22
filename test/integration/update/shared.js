self.addEventListener('connect', ({ ports: [port] }) => port.postMessage('shared'));
