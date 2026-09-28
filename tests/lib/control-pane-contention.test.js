'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { fork } = require('child_process');
const { createStateStore } = require('../../scripts/lib/state-store');

const FIXTURE = path.join(__dirname, 'helpers', 'control-pane-contention-server.js');

function request(url, method = 'GET', body, timeoutMs = 1000, onRequest = () => {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, agent: false, headers: { 'Content-Type': 'application/json' } }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', data => { text += data; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(text) });
        } catch (error) {
          reject(error);
        }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`HTTP ${method} timed out after ${timeoutMs}ms`)));
    req.on('error', reject);
    onRequest(req);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

async function startServer(dbPath, readOnly = false) {
  const child = fork(FIXTURE, [dbPath, readOnly ? 'read-only' : 'editable'], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });
  const closed = new Promise(resolve => child.once('close', resolve));
  child.stdout.resume();
  let stderr = '';
  let metrics = { active: 0, peak: 0, started: 0, exited: 0, received: 0, disconnected: 0 };
  const observers = new Set();
  child.on('message', message => {
    if (message.type === 'workers') {
      metrics = message;
      for (const notify of observers) notify();
    }
  });
  child.stderr.on('data', data => { stderr += data; });
  let ready;
  try {
    ready = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Server startup timed out: ${stderr}`)), 10000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.on('message', message => {
        if (message.type === 'ready') { clearTimeout(timer); resolve(message); }
      });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${stderr}`)); });
    });
  } catch (error) {
    child.kill();
    await closed;
    throw error;
  }
  return {
    url: ready.url,
    get metrics() { return metrics; },
    observe(fn) { observers.add(fn); return () => observers.delete(fn); },
    mutationReceived() {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { child.off('message', onMessage); reject(new Error('Mutation never reached server')); }, 5000);
        function onMessage(message) {
          if (message.type !== 'mutation-received') return;
          clearTimeout(timer);
          child.off('message', onMessage);
          resolve();
        }
        child.on('message', onMessage);
      });
    },
    async close() {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await closed;
    }
  };
}

function waitForObservation(server, predicate, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    let unsubscribe;
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Timed out waiting for worker lifecycle: ${JSON.stringify(server.metrics)}`));
    }, timeoutMs);
    function check() {
      if (!predicate()) return;
      clearTimeout(timer);
      unsubscribe();
      resolve();
    }
    unsubscribe = server.observe(check);
    check();
  });
}

async function burstScenario(server, dbPath) {
  const bytesBefore = fs.readFileSync(dbPath);
  const lockPath = `${dbPath}.ecc-state.lock`;
  const fd = fs.openSync(lockPath, 'wx', 0o600);
  fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, hostname: os.hostname() }));
  const results = [];
  const requests = [];
  let resolveRejected;
  const sixRejected = new Promise(resolve => { resolveRejected = resolve; });
  let released = false;
  try {
    for (let index = 0; index < 8; index += 1) {
      requests.push(request(`${server.url}/api/work-items/burst-${index}/claim`, 'POST', { owner: `owner-${index}` }, 12000)
        .then(result => {
          results.push({ index, ...result });
          if (results.filter(item => item.status === 503).length >= 6) resolveRejected();
          return result;
        }, error => ({ transportError: error })));
    }
    await waitForObservation(server, () => server.metrics.received >= 8);
    await waitForObservation(server, () => server.metrics.started >= 2);
    // Response completion is also observed; no sleep guesses how long Worker
    // construction or request body parsing needs on the current machine.
    let timer;
    try {
      await Promise.race([
        sixRejected,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Excess requests did not promptly return 503; peak workers=${server.metrics.peak}`)), 1500); })
      ]);
    } finally {
      clearTimeout(timer);
    }
    assert.strictEqual(server.metrics.started, 2, 'Overflow must not start additional workers');
    assert.strictEqual(server.metrics.peak, 2);
    assert.strictEqual(results.length, 6, 'Only the six rejected requests complete while lock is held');
    for (const result of results) {
      assert.strictEqual(result.status, 503);
      assert.strictEqual(result.body.code, 'STATE_STORE_BUSY');
      assert.ok(Number(result.headers['retry-after']) > 0);
    }
    assert.strictEqual((await request(`${server.url}/api/health`)).status, 200);
    const snapshot = await request(`${server.url}/api/snapshot`, 'GET', undefined, 3000);
    assert.strictEqual(snapshot.status, 200);
    assert.deepStrictEqual(fs.readFileSync(dbPath), bytesBefore);
    const rejected = results.map(result => result.index);
    fs.closeSync(fd);
    fs.unlinkSync(lockPath);
    released = true;
    await Promise.all(requests);
    await waitForObservation(server, () => server.metrics.active === 0);
    assert.strictEqual(results.filter(result => result.status === 200).length, 2);
    assert.strictEqual(server.metrics.started, 2, 'Rejected requests must never execute later');
    const store = await createStateStore({ dbPath });
    try {
      for (const index of rejected) assert.strictEqual(store.getWorkItemById(`burst-${index}`).owner, null);
    } finally { store.close(); }
    const retry = await request(`${server.url}/api/work-items/burst-${rejected[0]}/claim`, 'POST', { owner: 'retry-owner' }, 5000);
    assert.strictEqual(retry.status, 200);
    assert.strictEqual(retry.body.item.owner, 'retry-owner');
  } finally {
    if (!released) { fs.closeSync(fd); fs.unlinkSync(lockPath); }
    await Promise.all(requests);
  }
}

async function withServer(readOnly, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-http-contention-'));
  const dbPath = path.join(dir, 'state.db');
  let server;
  try {
    const store = await createStateStore({ dbPath });
    try {
      store.upsertWorkItem({ id: 'task', title: 'Synthetic board task', source: 'manual', status: 'open' });
      for (let index = 0; index < 8; index += 1) {
        store.upsertWorkItem({ id: `burst-${index}`, title: `Burst task ${index}`, source: 'manual', status: 'open' });
      }
    } finally {
      store.close();
    }
    server = await startServer(dbPath, readOnly);
    return await fn(server, dbPath);
  } finally {
    if (server) await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function disconnectScenario(server, dbPath) {
  const lockPath = `${dbPath}.ecc-state.lock`;
  const fd = fs.openSync(lockPath, 'wx', 0o600);
  fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, hostname: os.hostname() }));
  let disconnectedRequest;
  const abandoned = request(`${server.url}/api/work-items/burst-0/claim`, 'POST', { owner: 'abandoned-client' }, 12000,
    req => { disconnectedRequest = req; }).catch(error => ({ error }));
  const accepted = request(`${server.url}/api/work-items/burst-1/claim`, 'POST', { owner: 'connected-client' }, 12000)
    .catch(error => ({ error }));
  try {
    await waitForObservation(server, () => server.metrics.active === 2);
    disconnectedRequest.destroy(new Error('Intentional client disconnect'));
    await waitForObservation(server, () => server.metrics.disconnected === 1);
    const excess = await request(`${server.url}/api/work-items/burst-2/claim`, 'POST', { owner: 'excess-client' });
    assert.strictEqual(excess.status, 503, 'Disconnect must not release a slot while its worker is still alive');
    assert.strictEqual(server.metrics.started, 2);
    assert.strictEqual(server.metrics.active, 2);
  } finally {
    fs.closeSync(fd);
    fs.unlinkSync(lockPath);
    await abandoned;
    await accepted;
  }
  await waitForObservation(server, () => server.metrics.active === 0);
  const retry = await request(`${server.url}/api/work-items/burst-2/claim`, 'POST', { owner: 'retry-client' }, 5000);
  assert.strictEqual(retry.status, 200, 'Actual worker exits must restore capacity');
}

async function contentionScenario() {
  return withServer(false, async (server, dbPath) => {
    const bytesBefore = fs.readFileSync(dbPath);
    const lockPath = `${dbPath}.ecc-state.lock`;
    const fd = fs.openSync(lockPath, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, hostname: os.hostname() }));
    let outcome;
    try {
      const received = server.mutationReceived();
      let settled = false;
      const mutation = request(`${server.url}/api/work-items/task/claim`, 'POST', { owner: 'alice' }, 12000)
        .then(result => { settled = true; return result; }, error => { settled = true; return { transportError: error }; });
      await received;
      let healthError = null;
      let healthChecks = 0;
      let snapshotChecks = 0;
      // Probe continuously after actual HTTP receipt, including asynchronous
      // database initialization. No timing guess about when lock wait begins.
      while (!settled) {
        try {
          const health = await request(`${server.url}/api/health`);
          assert.strictEqual(health.status, 200);
          healthChecks += 1;
          const snapshot = await request(`${server.url}/api/snapshot`, 'GET', undefined, 3000);
          assert.strictEqual(snapshot.status, 200);
          assert.ok(snapshot.body.workItems.items.some(item => item.id === 'task'));
          snapshotChecks += 1;
        } catch (error) {
          healthError = error.message;
          break;
        }
      }
      const result = await mutation;
      if (result.transportError) throw result.transportError;
      outcome = { result, healthError, healthChecks, snapshotChecks };
    } finally {
      fs.closeSync(fd);
      fs.unlinkSync(lockPath);
    }
    assert.deepStrictEqual(fs.readFileSync(dbPath), bytesBefore, 'Timed-out mutation must not change database bytes');
    const store = await createStateStore({ dbPath });
    try {
      const item = store.getWorkItemById('task');
      assert.strictEqual(item.status, 'open');
      assert.strictEqual(item.owner, null);
    } finally {
      store.close();
    }
    return outcome;
  });
}

async function run() {
  let passed = 0;
  let failed = 0;
  async function test(name, fn) {
    try {
      await fn();
      console.log(`  PASS ${name}`);
      passed += 1;
    } catch (error) {
      console.log(`  FAIL ${name}\n    ${error.message}`);
      failed += 1;
    }
  }
  console.log('\n=== Testing control-pane mutation contention ===\n');
  const contention = await contentionScenario();
  await test('health and snapshots remain responsive while a board mutation waits for another database writer', () => {
    assert.strictEqual(contention.healthError, null, contention.healthError || undefined);
    assert.ok(contention.healthChecks > 0);
    assert.ok(contention.snapshotChecks > 0);
  });
  await test('lock timeout is retryable HTTP 503 with Retry-After', () => {
    assert.strictEqual(contention.result.status, 503);
    assert.ok(Number(contention.result.headers['retry-after']) > 0, 'Retry-After must give a positive delay');
    assert.strictEqual(contention.result.body.ok, false);
    assert.strictEqual(contention.result.body.code, 'STATE_STORE_BUSY');
  });
  await test('claim and move still save their changes, while invalid edits return 400', () => withServer(false, async (server, dbPath) => {
    const claim = await request(`${server.url}/api/work-items/task/claim`, 'POST', { owner: 'alice', as: 'human' }, 5000);
    assert.strictEqual(claim.status, 200);
    assert.strictEqual(claim.body.item.owner, 'alice');
    assert.strictEqual(claim.body.item.status, 'running');
    const move = await request(`${server.url}/api/work-items/task/move`, 'POST', { lane: 'blocked' }, 5000);
    assert.strictEqual(move.status, 200);
    assert.strictEqual(move.body.item.status, 'blocked');
    const invalid = await request(`${server.url}/api/work-items/task/move`, 'POST', { lane: 'imaginary' }, 5000);
    assert.strictEqual(invalid.status, 400);
    assert.strictEqual(invalid.body.ok, false);
    const store = await createStateStore({ dbPath });
    try {
      const item = store.getWorkItemById('task');
      assert.strictEqual(item.owner, 'alice');
      assert.strictEqual(item.status, 'blocked');
      assert.strictEqual(item.metadata.assigneeKind, 'human');
    } finally {
      store.close();
    }
  }));
  await test('read-only mode rejects board edits before database work', () => withServer(true, async server => {
    for (const action of ['claim', 'move']) {
      const result = await request(`${server.url}/api/work-items/task/${action}`, 'POST', { owner: 'alice', lane: 'done' });
      assert.strictEqual(result.status, 403);
    }
  }));
  await test('an eight-request burst caps live workers at two and rejects excess work without queuing', () => withServer(false, burstScenario));
  await test('a disconnected HTTP client retains its worker slot until actual exit', () => withServer(false, disconnectScenario));
  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exitCode = failed ? 1 : 0;
}
run().catch(error => { console.error(error); process.exitCode = 1; });
