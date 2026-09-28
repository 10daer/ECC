'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fork, spawnSync } = require('child_process');
const { createStateStore } = require('../../scripts/lib/state-store');

const WORKER = path.join(__dirname, 'helpers', 'state-store-worker.js');
const WORK_ITEMS = path.join(__dirname, '..', '..', 'scripts', 'work-items.js');

function startWorker() {
  const child = fork(WORKER, [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const pending = new Map();
  let nextId = 0;
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  child.stdout.resume();
  child.on('message', message => {
    const request = pending.get(message.id);
    if (!request) return;
    clearTimeout(request.timer);
    pending.delete(message.id);
    if (message.ok) request.resolve();
    else request.reject(new Error(message.error));
  });
  child.on('exit', code => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error(`Worker exited ${code}: ${stderr}`));
    }
    pending.clear();
  });
  return {
    request(action, options = {}) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Worker timed out during ${action}: ${stderr}`));
        }, 30000);
        pending.set(id, { resolve, reject, timer });
        child.send({ id, action, ...options });
      });
    },
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      await new Promise(resolve => {
        child.once('exit', resolve);
        child.kill();
      });
    }
  };
}

async function withDatabase(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-store-concurrency-'));
  const dbPath = path.join(dir, 'state.db');
  try {
    await fn(dbPath);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function readItems(dbPath) {
  const store = await createStateStore({ dbPath });
  try {
    return store.listWorkItems({ limit: 1000 }).items;
  } finally {
    store.close();
  }
}

async function withWorkers(count, fn) {
  const workers = Array.from({ length: count }, () => startWorker());
  try {
    await fn(workers);
  } finally {
    await Promise.all(workers.map(worker => worker.stop()));
  }
}

async function run() {
  let passed = 0;
  let failed = 0;
  async function test(name, fn) {
    try {
      await withDatabase(fn);
      console.log(`  PASS ${name}`);
      passed += 1;
    } catch (error) {
      console.log(`  FAIL ${name}\n    ${error.message}`);
      failed += 1;
    }
  }

  console.log('\n=== Testing state-store concurrency ===\n');

  await test('closing an old reader preserves a task saved by the real CLI', async dbPath => {
    const reader = await createStateStore({ dbPath });
    try {
      assert.strictEqual(reader.listWorkItems().items.length, 0);
      const result = spawnSync(process.execPath, [WORK_ITEMS, 'upsert', 'cli-task',
        '--title', 'Task saved while dashboard is open', '--db', dbPath, '--json'],
      { encoding: 'utf8', timeout: 30000 });
      assert.strictEqual(result.status, 0, result.stderr);
    } finally {
      reader.close();
    }
    assert.ok((await readItems(dbPath)).some(item => item.id === 'cli-task'),
      'Closing the older reader must not remove the CLI task');
  });

  await test('long-lived handles preserve each other\'s writes and return current data', async dbPath => {
    const first = await createStateStore({ dbPath });
    const second = await createStateStore({ dbPath });
    try {
      first.upsertWorkItem({ id: 'a', source: 'manual', title: 'First task', status: 'open' });
      second.upsertWorkItem({ id: 'b', source: 'manual', title: 'Second task', status: 'open' });
      first.upsertWorkItem({ id: 'c', source: 'manual', title: 'Third task', status: 'open' });
      assert.deepStrictEqual(second.listWorkItems().items.map(item => item.id).sort(), ['a', 'b', 'c']);
    } finally {
      first.close();
      second.close();
    }
    assert.deepStrictEqual((await readItems(dbPath)).map(item => item.id).sort(), ['a', 'b', 'c']);
  });

  await test('independent processes retain every task after all handles open before writing', async dbPath => {
    const initial = await createStateStore({ dbPath });
    initial.close();
    await withWorkers(3, async workers => {
      // IPC acknowledgements form a barrier: every handle exists before any write.
      await Promise.all(workers.map(worker => worker.request('open', { dbPath })));
      await Promise.all(workers.map((worker, index) => worker.request('write', { worker: `worker-${index}`, count: 4 })));
      await Promise.all(workers.map(worker => worker.request('close')));
    });
    const actual = (await readItems(dbPath)).map(item => item.id).sort();
    const expected = Array.from({ length: 3 }, (_, worker) =>
      Array.from({ length: 4 }, (_, item) => `worker-${worker}-${item}`)).flat().sort();
    assert.deepStrictEqual(actual, expected, 'Every acknowledged task must survive all worker exits');
  });

  await test('read-modify-write transactions from concurrent processes retain every increment', async dbPath => {
    const initial = await createStateStore({ dbPath });
    initial.upsertWorkItem({ id: 'counter', source: 'manual', title: 'Completed jobs', status: 'open', metadata: { value: 0 } });
    initial.close();
    await withWorkers(3, async workers => {
      await Promise.all(workers.map(worker => worker.request('open', { dbPath })));
      await Promise.all(workers.map(worker => worker.request('increment', { count: 4 })));
      await Promise.all(workers.map(worker => worker.request('close')));
    });
    const counter = (await readItems(dbPath)).find(item => item.id === 'counter');
    assert.strictEqual(counter.metadata.value, 12, 'No committed increment may be lost');
  });

  await test('concurrent first opens complete migrations and accept all writers', async dbPath => {
    assert.strictEqual(fs.existsSync(dbPath), false);
    await withWorkers(3, async workers => {
      await Promise.all(workers.map(worker => worker.request('open', { dbPath })));
      await Promise.all(workers.map((worker, index) => worker.request('write', { worker: `fresh-${index}` })));
      await Promise.all(workers.map(worker => worker.request('close')));
    });
    const store = await createStateStore({ dbPath });
    try {
      const migrations = store.getAppliedMigrations();
      assert.ok(migrations.length > 0);
      assert.strictEqual(new Set(migrations.map(migration => migration.version)).size, migrations.length);
      assert.deepStrictEqual(store.listWorkItems().items.map(item => item.id).sort(), ['fresh-0-0', 'fresh-1-0', 'fresh-2-0']);
    } finally {
      store.close();
    }
  });

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exitCode = failed > 0 ? 1 : 0;
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
