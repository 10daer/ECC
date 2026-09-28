'use strict';

const { parentPort, workerData } = require('worker_threads');
const { createStateStore } = require('../state-store');
const { claimWorkItem, moveWorkItem } = require('./work-item-mutations');

/** Complete one board mutation away from the HTTP event loop, then close. */
async function mutate() {
  const { dbPath, action, args } = workerData;
  const mutation = action === 'claim' ? claimWorkItem : action === 'move' ? moveWorkItem : null;
  if (!mutation) throw new Error('Unknown work-item mutation');
  const store = await createStateStore({ dbPath });
  try {
    return store._database.transaction(() => mutation(store, args))();
  } finally {
    store.close();
  }
}

mutate().then(
  result => parentPort.postMessage({ ok: true, result }),
  error => parentPort.postMessage({ ok: false, error: { message: error.message, code: error.code } })
);
