import { writeFile } from 'node:fs/promises';
import { sleep } from './util.mjs';

const masks = { alt: 1, ctrl: 2, meta: 4, shift: 8 };
const keys = new Map([
  ['Enter', { code: 'Enter', keyCode: 13, text: '\r' }],
  ['Tab', { code: 'Tab', keyCode: 9, text: '\t' }],
  ['Backspace', { code: 'Backspace', keyCode: 8 }],
  ['Escape', { code: 'Escape', keyCode: 27 }],
  ['Delete', { code: 'Delete', keyCode: 46 }],
  ['Insert', { code: 'Insert', keyCode: 45 }],
  ['Home', { code: 'Home', keyCode: 36 }],
  ['End', { code: 'End', keyCode: 35 }],
  ['PageUp', { code: 'PageUp', keyCode: 33 }],
  ['PageDown', { code: 'PageDown', keyCode: 34 }],
  ['ArrowUp', { code: 'ArrowUp', keyCode: 38 }],
  ['ArrowDown', { code: 'ArrowDown', keyCode: 40 }],
  ['ArrowLeft', { code: 'ArrowLeft', keyCode: 37 }],
  ['ArrowRight', { code: 'ArrowRight', keyCode: 39 }],
]);
const punctuation = new Map([
  [' ', ['Space', 32]],
  [';', ['Semicolon', 186]],
  ['=', ['Equal', 187]],
  [',', ['Comma', 188]],
  ['-', ['Minus', 189]],
  ['.', ['Period', 190]],
  ['/', ['Slash', 191]],
  ['`', ['Backquote', 192]],
  ['[', ['BracketLeft', 219]],
  ['\\', ['Backslash', 220]],
  [']', ['BracketRight', 221]],
  ["'", ['Quote', 222]],
]);
const shifted = new Map(
  [...'~!@#$%^&*()_+{}|:"<>?'].map((char, i) => [char, "`1234567890-=[]\\;',./"[i]])
);

function named(key) {
  const known = keys.get(key);
  if (known) return known;
  const fn = /^F(\d{1,2})$/.exec(key);
  return { code: key, keyCode: fn ? 111 + Number(fn[1]) : 0 };
}

export function character(char) {
  const base = shifted.get(char) ?? char.toLowerCase();
  const upper = base.toUpperCase();
  if (/^[a-z]$/.test(base))
    return { code: `Key${upper}`, keyCode: upper.charCodeAt(0), text: char };
  if (/^\d$/.test(base)) return { code: `Digit${base}`, keyCode: base.charCodeAt(0), text: char };
  const [code, keyCode] = punctuation.get(base) ?? ['', 0];
  return { code, keyCode, text: char };
}

export function keystroke(key, modifiers) {
  const bits = modifiers.reduce((sum, name) => sum | masks[name], 0);
  const { code, keyCode, text } = [...key].length === 1 ? character(key) : named(key);
  const typed = bits & ~masks.shift ? undefined : text;
  return { key, code, windowsVirtualKeyCode: keyCode, modifiers: bits, text: typed };
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
  return !window.stale && document.readyState === 'complete' && location.href !== 'about:blank';
}

const specials = { Infinity, '-Infinity': -Infinity, NaN, '-0': -0 };

export function decoded({ value, unserializableValue }) {
  if (unserializableValue === undefined) return value;
  if (unserializableValue.endsWith('n')) return BigInt(unserializableValue.slice(0, -1));
  return specials[unserializableValue];
}

export function page(cdp, { sessionId, targetId }, server, timeout = 30000) {
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
    return decoded(result);
  }

  async function until(fn, ...args) {
    const deadline = Date.now() + timeout;
    let last;
    while (Date.now() < deadline) {
      try {
        last = await evaluate(fn, ...args);
        if (last) return last;
      } catch (error) {
        last = error.message;
      }
      await sleep(25);
    }
    throw new Error(
      `Timed out waiting for a truthy result from ${fn}\nlast result: ${JSON.stringify(last)}`
    );
  }

  async function press(key, ...modifiers) {
    const event = keystroke(key, modifiers);
    await send('Input.dispatchKeyEvent', { ...event, type: event.text ? 'keyDown' : 'rawKeyDown' });
    await send('Input.dispatchKeyEvent', { ...event, type: 'keyUp', text: undefined });
  }

  async function navigate(expression) {
    for (let attempt = 0; attempt < 2; attempt++) {
      await evaluate(mark);
      await send('Runtime.evaluate', { expression });
      try {
        await until(fresh);
        return;
      } catch (error) {
        if (attempt === 1) throw error;
      }
    }
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
    close: () => cdp.send('Target.closeTarget', { targetId }),
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
