'use strict';

const assert = require('assert');
const vm = require('vm');
const { canvasClientJs } = require('../../scripts/lib/plan-canvas/ui');

// Run the exact shipped client with a small DOM adapter and a deferred fetch.
// This exercises its event handlers and storage writes without a browser dependency.
function client() {
  function element() {
    const handlers = new Map();
    const node = { children: [], value: '', textContent: '', disabled: false,
      scrollHeight: 0, scrollTop: 0, clientHeight: 0,
      classList: { toggle() {}, add() {} },
      setAttribute() {}, removeAttribute() {},
      append(...items) { this.children.push(...items); },
      appendChild(item) { this.children.push(item); },
      addEventListener(type, fn) { handlers.set(type, [...(handlers.get(type) || []), fn]); },
      emit(type, event = {}) { return Promise.all((handlers.get(type) || []).map(fn => fn(event))); },
      querySelector() { return this.label || (this.label = element()); },
    };
    Object.defineProperty(node, 'innerHTML', { set() { this.children = []; } });
    return node;
  }
  const nodes = new Map();
  const get = id => {
    if (!nodes.has(id)) nodes.set(id, element());
    return nodes.get(id);
  };
  get('pc-session').textContent = JSON.stringify({ key: '123456789abc', status: 'open', chat: [] });
  get('artifact').contentWindow = { postMessage() {} };
  const storage = new Map();
  const window = element();
  const document = { getElementById: get, createElement: element, documentElement: element(), addEventListener() {} };
  const requests = [];
  vm.runInNewContext(canvasClientJs(), {
    window, document,
    localStorage: { getItem() { return null; }, setItem() {} },
    sessionStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
    EventSource: class { addEventListener() {} },
    fetch: (url, options) => new Promise((resolve, reject) => requests.push({ url, options, resolve, reject })),
  });
  const queue = () => JSON.parse(storage.get('ecc-plan-canvas:queue:123456789abc') || '[]');
  const annotate = text => window.emit('message', { source: get('artifact').contentWindow,
    data: { type: 'pc:queue', item: { kind: 'annotation', text, anchor: { selector: 'p' } } },
  });
  const input = async text => { get('chatInput').value = text; await get('chatInput').emit('input'); };
  const acknowledge = () => requests.at(-1).resolve({ ok: true, json: async () => ({ presence: 'queued' }) });
  return { get, queue, annotate, input, requests, acknowledge };
}

async function main() {
  let passed = 0;
  let failed = 0;
  async function test(name, fn) {
    try { await fn(); passed++; console.log(`PASS ${name}`); } catch (error) { failed++; console.error(`FAIL ${name}: ${error.message}`); }
  }
  await test('acknowledgment removes only submitted annotations after queue edits', async () => {
    const app = client();
    await app.annotate('first');
    await app.annotate('second');
    const send = app.get('send').emit('click');
    assert.strictEqual(JSON.parse(app.requests[0].options.body).items.length, 2);
    await app.get('queue').children[0].children[1].emit('click');
    await app.annotate('new while sending');
    app.acknowledge();
    await send;
    assert.deepStrictEqual(app.queue().map(item => item.text), ['new while sending']);
    const next = app.get('send').emit('click');
    assert.deepStrictEqual(JSON.parse(app.requests[1].options.body).items.map(item => item.text), ['new while sending']);
    app.acknowledge();
    await next;
    assert.deepStrictEqual(app.queue(), []);
  });
  await test('acknowledgment preserves new input, including edits back to the submitted text', async () => {
    for (const nextText of ['next draft', 'submitted']) {
      const app = client();
      await app.input('submitted');
      const send = app.get('send').emit('click');
      await app.input('edited draft');
      await app.input(nextText);
      app.acknowledge();
      await send;
      assert.strictEqual(app.get('chatInput').value, nextText);
      assert.strictEqual(app.get('send').disabled, false);
    }
  });
  await test('unchanged successful draft clears and failed requests preserve all drafts', async () => {
    const success = client();
    await success.input('submitted');
    const sent = success.get('send').emit('click');
    success.acknowledge();
    await sent;
    assert.strictEqual(success.get('chatInput').value, '');
    const failure = client();
    await failure.annotate('first');
    await failure.input('submitted');
    const pending = failure.get('send').emit('click');
    await failure.annotate('new');
    await failure.input('new draft');
    failure.requests[0].reject(new Error('offline'));
    await pending;
    assert.deepStrictEqual(failure.queue().map(item => item.text), ['first', 'new']);
    assert.strictEqual(failure.get('chatInput').value, 'new draft');
    assert.strictEqual(failure.get('send').disabled, false);
  });
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  if (failed) process.exitCode = 1;
}

main().catch(error => { console.error(error); process.exitCode = 1; });
