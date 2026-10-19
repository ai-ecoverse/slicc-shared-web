chrome.runtime.onConnect.addListener((port) => {
  port.onMessage.addListener((message) => port.postMessage(`pong ${message}`));
});
