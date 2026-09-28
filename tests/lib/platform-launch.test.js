'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { openBrowser, openerCommandFor } = require('../../scripts/lib/platform-launch');

test('openerCommandFor: darwin returns open', () => {
  assert.deepEqual(openerCommandFor('darwin', 'http://x'), ['open', ['http://x']]);
});

test('openerCommandFor: win32 returns cmd /c start', () => {
  assert.deepEqual(openerCommandFor('win32', 'http://x'), ['cmd', ['/c', 'start', '', 'http://x']]);
});

test('openerCommandFor: linux returns xdg-open', () => {
  assert.deepEqual(openerCommandFor('linux', 'http://x'), ['xdg-open', ['http://x']]);
});

test('openerCommandFor: unknown falls through to xdg-open', () => {
  assert.deepEqual(openerCommandFor('freebsd', 'http://x'), ['xdg-open', ['http://x']]);
});

test('openBrowser: invalid url returns invalid-url without spawning', () => {
  let calls = 0;
  const launch = () => { calls += 1; };
  assert.deepEqual(openBrowser('', 'linux', launch), { opened: false, reason: 'invalid-url' });
  assert.deepEqual(openBrowser(null, 'linux', launch), { opened: false, reason: 'invalid-url' });
  assert.equal(calls, 0);
});

test('openBrowser: reports synchronous launcher failures', () => {
  const withCode = () => { throw Object.assign(new Error('missing launcher'), { code: 'ENOENT' }); };
  const withoutCode = () => { throw new Error('launcher failed'); };
  assert.deepEqual(openBrowser('http://localhost:0', 'linux', withCode), {
    opened: false, reason: 'spawn-threw:ENOENT',
  });
  assert.deepEqual(openBrowser('http://localhost:0', 'linux', withoutCode), {
    opened: false, reason: 'spawn-threw:unknown',
  });
});

test('openBrowser: installs an error listener and detaches the launcher', () => {
  const handlers = new Map();
  let unrefCalls = 0;
  let launchCalls = 0;
  const child = {
    on(event, listener) {
      handlers.set(event, listener);
    },
    unref() {
      assert.equal(typeof handlers.get('error'), 'function', 'listen before detaching');
      unrefCalls += 1;
    },
  };

  const result = openBrowser('http://localhost:0', 'linux', (command, args, options) => {
    launchCalls += 1;
    assert.equal(command, 'xdg-open');
    assert.deepEqual(args, ['http://localhost:0']);
    assert.deepEqual(options, { detached: true, stdio: 'ignore' });
    return child;
  });

  assert.deepEqual(result, { opened: true, reason: 'spawned' });
  assert.equal(launchCalls, 1);
  assert.equal(unrefCalls, 1);
  assert.equal(typeof handlers.get('error'), 'function');
  assert.doesNotThrow(() => handlers.get('error')({ code: 'ENOENT' }));
});

test('openBrowser: a detach failure does not escape after the listener is installed', () => {
  let listener;
  const result = openBrowser('http://localhost:0', 'linux', () => ({
    on(event, callback) {
      assert.equal(event, 'error');
      listener = callback;
    },
    unref() {
      assert.equal(typeof listener, 'function');
      throw new Error('cannot detach');
    },
  }));
  assert.deepEqual(result, { opened: true, reason: 'spawned' });
  assert.doesNotThrow(() => listener({ code: 'EACCES' }));
});
