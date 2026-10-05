import { writeFile } from 'node:fs/promises';
import { sleep } from './util.mjs';

const masks = { alt: 1, ctrl: 2, meta: 4, shift: 8 };
const keys = new Map([
  ['Enter', { code: 'Enter', keyCode: 13, text: '\r' }],
  ['Tab', { code: 'Tab', keyCode: 9, text: '\t' }],
  ['Backspace', { code: 'Backspace', keyCode: 8 }],
  ['Escape', { code: 'Escape', keyCode: 27 }],
  ['ArrowUp', { code: 'ArrowUp', keyCode: 38 }],
  ['ArrowDown', { code: 'ArrowDown', keyCode: 40 }],
  ['ArrowLeft', { code: 'ArrowLeft', keyCode: 37 }],
  ['ArrowRight', { code: 'ArrowRight', keyCode: 39 }],
  [' ', { code: 'Space', keyCode: 32, text: ' ' }],
]);

export function keystroke(key, modifiers) {
  const bits = modifiers.reduce((sum, name) => sum | masks[name], 0);
  const named = keys.get(key);
  const code = named?.code ?? `Key${key.toUpperCase()}`;
  const keyCode = named?.keyCode ?? key.toUpperCase().charCodeAt(0);
  const plain = named ? named.text : key;
  const text = bits & ~masks.shift ? undefined : plain;
  return { key, code, windowsVirtualKeyCode: keyCode, modifiers: bits, text };
}

export function settle(ms = 1000) {
  const finite = document
    .getAnimations()
    .filter((animation) => animation.effect?.getComputedTiming().endTime < Infinity);
  const done = Promise.all(finite.map((animation) => animation.finished.catch(() => null)));
  return Promise.race([done, new Promise((resolve) => setTimeout(resolve, ms))]);
}

export function mark() {
  window.stale = true;
}

export function fresh() {
  return !window.stale;
}

export function page(cdp, sessionId, server, timeout = 30000) {
  const send = (method, params) => cdp.send(method, params, sessionId);
  const errors = [];
  const responses = [];
  const bindings = new Map();
  const dispose = cdp.on(({ method, params, sessionId: from }) => {
    if (from !== sessionId) return;
    if (method === 'Runtime.exceptionThrown') {
      const { exception, text } = params.exceptionDetails;
      errors.push(exception?.description ?? text);
    }
    if (method === 'Runtime.bindingCalled') bindings.get(params.name)?.(JSON.parse(params.payload));
    if (method === 'Network.responseReceived') responses.push(params.response);
  });

  async function evaluate(fn, ...args) {
    const expression = `(${fn})(...${JSON.stringify(args)})`;
    const { result, exceptionDetails } = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description);
    return result.value;
  }

  async function until(fn, ...args) {
    const deadline = Date.now() + timeout;
    let last;
    while (Date.now() < deadline) {
      last = await evaluate(fn, ...args).catch((error) => error.message);
      if (last === true) return;
      await sleep(25);
    }
    throw new Error(`Timed out waiting for ${fn}\nlast result: ${JSON.stringify(last)}`);
  }

  async function press(key, ...modifiers) {
    const event = keystroke(key, modifiers);
    await send('Input.dispatchKeyEvent', { ...event, type: event.text ? 'keyDown' : 'rawKeyDown' });
    await send('Input.dispatchKeyEvent', { ...event, type: 'keyUp', text: undefined });
  }

  async function navigate(expression) {
    await evaluate(mark);
    await send('Runtime.evaluate', { expression });
    await until(fresh);
  }

  return {
    errors,
    responses,
    dispose,
    evaluate,
    until,
    press,
    goto: (path) => navigate(`location.assign(${JSON.stringify(new URL(path, server.url).href)})`),
    reload: () => navigate('location.reload()'),
    insert: (text) => send('Input.insertText', { text }),
    enter: () => press('Enter'),
    async type(text) {
      for (const key of text) await press(key);
    },
    init: (fn) => send('Page.addScriptToEvaluateOnNewDocument', { source: `(${fn})()` }),
    async expose(name, handler) {
      bindings.set(name, handler);
      await send('Runtime.addBinding', { name });
    },
    async screenshot(file) {
      await evaluate(settle);
      const { data } = await send('Page.captureScreenshot', { format: 'png' });
      await writeFile(file, Buffer.from(data, 'base64'));
    },
  };
}
