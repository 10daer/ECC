'use strict';

const path = require('path');
const { Worker } = require('worker_threads');

const MAX_ACTIVE_MUTATIONS = 2;
let activeMutations = 0;

/** Bound live workers process-wide; excess mutations are rejected, not queued. */
function runWorkItemMutation(dbPath, action, args) {
  return new Promise((resolve, reject) => {
    if (activeMutations >= MAX_ACTIVE_MUTATIONS) {
      reject(Object.assign(new Error('Too many work-item mutations are running. Retry after an operation finishes.'),
        { code: 'STATE_STORE_BUSY' }));
      return;
    }
    activeMutations += 1;
    let worker;
    try {
      worker = new Worker(path.join(__dirname, 'work-item-worker.js'), {
        workerData: { dbPath, action, args }
      });
    } catch (error) {
      activeMutations -= 1;
      reject(error);
      return;
    }
    let response;
    let workerError;
    worker.once('message', message => { response = message; });
    worker.once('error', error => { workerError = error; });
    worker.once('exit', code => {
      // Keep the slot until the thread is gone, even after a message/error.
      activeMutations -= 1;
      if (workerError) reject(workerError);
      else if (code !== 0 || !response) reject(new Error(`Work-item worker exited without a successful result (${code})`));
      else if (response.ok) resolve(response.result);
      else reject(Object.assign(new Error(response.error.message), { code: response.error.code }));
    });
    // Let the worker exit naturally after closing the store. Terminating it on
    // a client disconnect could interrupt a write and abandon its file lock.
  });
}

module.exports = { runWorkItemMutation };
