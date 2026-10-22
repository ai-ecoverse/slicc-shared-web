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

test('a headed Chrome may fall back to SwiftShader, so WebGL works on a display without a GPU', () => {
  assert.ok(commandLine('/p', [], [], false, false, false).includes('--enable-unsafe-swiftshader'));
  assert.ok(commandLine('/p', [], [], true, false, true).includes('--enable-unsafe-swiftshader'));
  assert.ok(!commandLine('/p', [], [], false, false, true).includes('--enable-unsafe-swiftshader'));
});

test('the harness exports what a repo launching its own Chrome needs to match it', async () => {
  const harness = await import('@ai-ecoverse/slicc-shared-web/harness');
  assert.equal(harness.headlessByDefault({ CI: 'true' }), false);
  assert.equal(harness.headlessByDefault({}), true);
  assert.deepEqual(harness.modeFlags(true), ['--headless=new']);
  assert.deepEqual(harness.modeFlags(false), ['--enable-unsafe-swiftshader']);
  const screen = await harness.screenFor(false, { CI: 'true' });
  assert.equal(screen.child, null);
  await screen.close();
});
