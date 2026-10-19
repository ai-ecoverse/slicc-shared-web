const port = chrome.runtime.connect();
port.onMessage.addListener((message) => {
  document.documentElement.dataset.port = message;
});
port.postMessage('ping');
