'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createStateStore } = require('../../scripts/lib/state-store');
const { withStateStoreLock } = require('../../scripts/lib/state-store/file-lock');

const item = id => ({ id, source: 'manual', title: id, status: 'open' });

async function run() {
  let passed = 0;
  let failed = 0;
  async function test(name, callback) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-state-persistence-'));
    try {
      await callback(path.join(directory, 'state.db'));
      console.log(`  PASS ${name}`);
      passed += 1;
    } catch (error) {
      console.log(`  FAIL ${name}\n    ${error.stack}`);
      failed += 1;
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }

  await test('queries, migration inspection and closing never rewrite an existing database', async dbPath => {
    const initial = await createStateStore({ dbPath });
    initial.upsertWorkItem(item('saved'));
    initial.close();
    const before = fs.readFileSync(dbPath);
    const rename = fs.renameSync;
    let writes = 0;
    fs.renameSync = (from, to) => {
      if (to === dbPath) writes += 1;
      return rename(from, to);
    };
    try {
      const reader = await createStateStore({ dbPath });
      try {
        assert.ok(reader.getWorkItemById('saved'));
        reader.listWorkItems();
        reader.getStatus();
        assert.strictEqual(reader.getAppliedMigrations().length, 2);
      } finally { reader.close(); }
    } finally { fs.renameSync = rename; }
    assert.strictEqual(writes, 0);
    assert.deepStrictEqual(fs.readFileSync(dbPath), before);
  });

  await test('persistent PRAGMA changes survive snapshot reload and reopening', async dbPath => {
    const store = await createStateStore({ dbPath });
    try {
      assert.strictEqual(store._database.pragma('user_version = 3252'), undefined);
      assert.strictEqual(store._database.prepare('PRAGMA user_version').get().user_version, 3252);
      store._database.pragma('application_id(2468)');
    } finally { store.close(); }
    const reopened = await createStateStore({ dbPath });
    try {
      assert.strictEqual(reopened._database.prepare('PRAGMA user_version').get().user_version, 3252);
      assert.strictEqual(reopened._database.prepare('PRAGMA application_id').get().application_id, 2468);
    } finally { reopened.close(); }
  });

  await test('read-only and connection-local PRAGMAs never rewrite database bytes', async dbPath => {
    const store = await createStateStore({ dbPath });
    const before = fs.readFileSync(dbPath);
    const rename = fs.renameSync;
    let writes = 0;
    fs.renameSync = (from, to) => {
      if (to === dbPath) writes += 1;
      return rename(from, to);
    };
    try {
      store._database.pragma('user_version');
      store._database.pragma('table_info(work_items)');
      store._database.pragma('integrity_check');
      store._database.transaction(() => {
        store._database.pragma('user_version');
        store._database.pragma('table_info(work_items)');
      })();
      store._database.withSnapshot(() => {
        store._database.pragma('cache_size = 256');
        assert.strictEqual(store._database.prepare('PRAGMA cache_size').get().cache_size, 256);
      });
      assert.strictEqual(writes, 0);
      assert.deepStrictEqual(fs.readFileSync(dbPath), before);
    } finally {
      fs.renameSync = rename;
      store.close();
    }
  });

  await test('PRAGMA persistence waits for commit and never commits a rolled-back transaction', async dbPath => {
    const store = await createStateStore({ dbPath });
    try {
      store._database.transaction(() => {
        store.upsertWorkItem(item('committed-pragma'));
        store._database.pragma('table_info(work_items)');
        store._database.pragma('user_version = 3252');
      })();
      store._database.transaction(() => store._database.pragma('application_id(2468)'))();
      assert.strictEqual(store._database.prepare('PRAGMA application_id').get().application_id, 2468);
      const before = fs.readFileSync(dbPath);
      assert.throws(() => store._database.transaction(() => {
        store.upsertWorkItem(item('rolled-back-pragma'));
        store._database.pragma('user_version = 9999');
        throw new Error('abort PRAGMA transaction');
      })(), /abort PRAGMA transaction/);
      assert.deepStrictEqual(fs.readFileSync(dbPath), before);
      assert.strictEqual(store._database.prepare('PRAGMA user_version').get().user_version, 3252);
      assert.deepStrictEqual(store.listWorkItems().items.map(row => row.id), ['committed-pragma']);
    } finally { store.close(); }
  });

  await test('failed persistence is discarded, releases the lock and cannot overwrite a later writer', async dbPath => {
    const first = await createStateStore({ dbPath });
    const second = await createStateStore({ dbPath });
    const before = fs.readFileSync(dbPath);
    const rename = fs.renameSync;
    const failure = new Error('simulated disk failure');
    try {
      fs.renameSync = (from, to) => {
        if (to === dbPath) throw failure;
        return rename(from, to);
      };
      try {
        assert.throws(() => first.upsertWorkItem(item('failed')), error => error === failure);
      } finally { fs.renameSync = rename; }
      assert.deepStrictEqual(fs.readFileSync(dbPath), before);
      assert.strictEqual(fs.existsSync(`${dbPath}.ecc-state.lock`), false);
      second.upsertWorkItem(item('other-process'));
      first.upsertWorkItem(item('retry'));
      assert.deepStrictEqual(first.listWorkItems().items.map(row => row.id).sort(), ['other-process', 'retry']);
    } finally {
      first.close();
      second.close();
    }
  });

  await test('transaction exceptions roll back, preserve the error and release the writer lock', async dbPath => {
    const store = await createStateStore({ dbPath });
    const before = fs.readFileSync(dbPath);
    const failure = new Error('cancel this transaction');
    try {
      assert.throws(() => store._database.transaction(() => {
        store.upsertWorkItem(item('rolled-back'));
        throw failure;
      })(), error => error === failure);
      assert.deepStrictEqual(fs.readFileSync(dbPath), before);
      assert.strictEqual(fs.existsSync(`${dbPath}.ecc-state.lock`), false);
      store.upsertWorkItem(item('next'));
      assert.deepStrictEqual(store.listWorkItems().items.map(row => row.id), ['next']);
    } finally { store.close(); }
  });

  await test('reloading a snapshot preserves foreign-key enforcement', async dbPath => {
    const store = await createStateStore({ dbPath });
    try {
      store._database.exec('CREATE TABLE parent (id INTEGER PRIMARY KEY); CREATE TABLE child (parent_id INTEGER REFERENCES parent(id));');
      assert.throws(() => store._database.exec('INSERT INTO child VALUES (42)'), /FOREIGN KEY constraint failed/);
      store._database.exec('INSERT INTO parent VALUES (42)');
      store._database.exec('INSERT INTO child VALUES (42)');
      assert.strictEqual(store._database.prepare('SELECT COUNT(*) AS count FROM child').get().count, 1);
    } finally { store.close(); }
  });

  await test('in-memory transactions roll back and closed handles cannot reopen silently', async () => {
    const store = await createStateStore({ dbPath: ':memory:' });
    store.upsertWorkItem(item('keep'));
    assert.throws(() => store._database.transaction(() => {
      store.upsertWorkItem(item('discard'));
      throw new Error('abort');
    })(), /abort/);
    assert.deepStrictEqual(store.listWorkItems().items.map(row => row.id), ['keep']);
    store.close();
    store.close();
    assert.throws(() => store.listWorkItems(), /closed/);
  });

  await test('failed rollback keeps the primary error and invalidates an uncertain in-memory handle', async () => {
    const store = await createStateStore({ dbPath: ':memory:' });
    const failure = new Error('application error after explicit rollback');
    assert.throws(() => store._database.transaction(() => {
      store._database.exec('ROLLBACK');
      throw failure;
    })(), error => error === failure && error.rollbackError instanceof Error);
    assert.throws(() => store.listWorkItems(), /closed/);
    store.close();
  });

  await test('live and abandoned locks time out without stealing ownership or touching the database', async dbPath => {
    const lock = `${dbPath}.ecc-state.lock`;
    fs.writeFileSync(dbPath, 'untouched');
    for (const metadata of [{ pid: process.pid }, { pid: 999999999 }, null]) {
      const bytes = JSON.stringify(metadata);
      fs.writeFileSync(lock, bytes);
      fs.utimesSync(lock, new Date(0), new Date(0));
      assert.throws(() => withStateStoreLock(dbPath, () => assert.fail('lock was stolen'), { timeoutMs: 20 }),
        error => error.code === 'STATE_STORE_BUSY' && error.message.includes(lock));
      assert.strictEqual(fs.readFileSync(lock, 'utf8'), bytes);
      assert.strictEqual(fs.readFileSync(dbPath, 'utf8'), 'untouched');
      fs.unlinkSync(lock);
    }
  });

  await test('failed lock metadata writes release the owned file', async dbPath => {
    const write = fs.writeFileSync;
    const failure = new Error('metadata write failure');
    fs.writeFileSync = () => { throw failure; };
    try {
      assert.throws(() => withStateStoreLock(dbPath, () => assert.fail('callback should not run')), error => error === failure);
    } finally { fs.writeFileSync = write; }
    assert.strictEqual(fs.existsSync(`${dbPath}.ecc-state.lock`), false);
    assert.strictEqual(withStateStoreLock(dbPath, () => 'retry'), 'retry');
  });

  await test('callback failure remains primary even when lock cleanup also fails', async dbPath => {
    const unlink = fs.unlinkSync;
    const primary = new Error('operation failed');
    const cleanup = new Error('cleanup failed');
    const lock = `${dbPath}.ecc-state.lock`;
    fs.unlinkSync = file => {
      if (file === lock) throw cleanup;
      return unlink(file);
    };
    try {
      assert.throws(() => withStateStoreLock(dbPath, () => { throw primary; }),
        error => error === primary && error.releaseError === cleanup);
    } finally {
      fs.unlinkSync = unlink;
      unlink(lock);
    }
    let caught = false;
    try { withStateStoreLock(dbPath, () => { throw null; }); }
    catch (error) { caught = true; assert.strictEqual(error, null); }
    assert.ok(caught, 'even falsy thrown values must propagate');
  });

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exitCode = failed ? 1 : 0;
}

run().catch(error => { console.error(error); process.exitCode = 1; });
