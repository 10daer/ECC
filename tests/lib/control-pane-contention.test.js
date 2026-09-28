'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { fork } = require('child_process');
const { createStateStore } = require('../../scripts/lib/state-store');

const FIXTURE = path.join(__dirname, 'helpers', 'control-pane-contention-server.js');

function request(url, method = 'GET', body, timeoutMs = 1000) {
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

async function withServer(readOnly, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-http-contention-'));
  const dbPath = path.join(dir, 'state.db');
  let server;
  try {
    const store = await createStateStore({ dbPath });
    try {
      store.upsertWorkItem({ id: 'task', title: 'Synthetic board task', source: 'manual', status: 'open' });
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
  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exitCode = failed ? 1 : 0;
}
run().catch(error => { console.error(error); process.exitCode = 1; });
