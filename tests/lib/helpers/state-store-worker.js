'use strict';

const { createStateStore } = require('../../../scripts/lib/state-store');

let store;
process.on('message', async ({ id, action, dbPath, worker, count = 1 }) => {
  try {
    if (action === 'open') {
      store = await createStateStore({ dbPath });
    } else if (action === 'write') {
      for (let index = 0; index < count; index += 1) {
        store.upsertWorkItem({
          id: `${worker}-${index}`, source: 'manual', title: `Task ${worker}-${index}`, status: 'open'
        });
      }
    } else if (action === 'increment') {
      for (let index = 0; index < count; index += 1) {
        store._database.transaction(() => {
          const item = store.getWorkItemById('counter');
          // Widen real transaction overlap without assuming which worker wins.
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15);
          store.upsertWorkItem({ ...item, metadata: { value: item.metadata.value + 1 } });
        })();
      }
    } else if (action === 'close') {
      store.close();
      store = null;
    } else {
      throw new Error(`Unknown fixture action: ${action}`);
    }
    process.send({ id, ok: true });
  } catch (error) {
    process.send({ id, ok: false, error: error.stack });
  }
});
process.send({ ready: true });
