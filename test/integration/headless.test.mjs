import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commandLine, headlessByDefault } from '../../harness/chrome.mjs';

test('Chrome is headless on a developer machine and headed on CI', () => {
  assert.equal(headlessByDefault({}), true);
  assert.equal(headlessByDefault({ CI: 'true' }), false);
  assert.equal(headlessByDefault({ CI: 'false' }), true);
});

test('SLICC_HEADLESS overrides the default either way', () => {
  assert.equal(headlessByDefault({ CI: 'true', SLICC_HEADLESS: '1' }), true);
  assert.equal(headlessByDefault({ SLICC_HEADLESS: '0' }), false);
});

test('headless adds --headless=new, and realistic is always headed', () => {
  assert.ok(commandLine('/p', [], [], false, false, true).includes('--headless=new'));
  assert.ok(!commandLine('/p', [], [], false, false, false).includes('--headless=new'));
  assert.ok(!commandLine('/p', [], [], true, false, true).includes('--headless=new'));
});
