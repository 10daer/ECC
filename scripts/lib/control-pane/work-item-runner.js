'use strict';

const path = require('path');
const { Worker } = require('worker_threads');

/** Await a one-shot worker without blocking unrelated HTTP requests on a lock. */
function runWorkItemMutation(dbPath, action, args) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'work-item-worker.js'), {
      workerData: { dbPath, action, args }
    });
    let responded = false;
    worker.once('message', message => {
      responded = true;
      if (message.ok) resolve(message.result);
      else reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
    });
    worker.once('error', reject);
    worker.once('exit', code => {
      if (!responded) reject(new Error(`Work-item worker exited without a result (${code})`));
    });
    // Let the worker exit naturally after closing the store. Terminating it on
    // a client disconnect could interrupt a write and abandon its file lock.
  });
}

module.exports = { runWorkItemMutation };
