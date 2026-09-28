'use strict';

const workerThreads = require('worker_threads');
const OriginalWorker = workerThreads.Worker;
const metrics = { active: 0, peak: 0, started: 0, exited: 0, received: 0, disconnected: 0 };
function report() { process.send({ type: 'workers', ...metrics }); }
workerThreads.Worker = class ObservedWorker extends OriginalWorker {
  constructor(...args) {
    super(...args);
    metrics.active += 1;
    metrics.started += 1;
    metrics.peak = Math.max(metrics.peak, metrics.active);
    report();
    this.once('exit', () => { metrics.active -= 1; metrics.exited += 1; report(); });
  }
};
const { createControlPaneServer } = require('../../../scripts/lib/control-pane/server');

async function main() {
  const app = createControlPaneServer({
    host: '127.0.0.1', port: 0, stateDbPath: process.argv[2],
    dbPath: `${process.argv[2]}.ecc2`, allowActions: process.argv[3] !== 'read-only'
  });
  app.server.prependListener('request', (req, res) => {
    if (req.method === 'POST') {
      metrics.received += 1;
      report();
      process.send({ type: 'mutation-received' });
      res.once('close', () => {
        if (!res.writableFinished) { metrics.disconnected += 1; report(); }
      });
    }
  });
  await app.listen();
  process.send({ type: 'ready', url: app.url });
  process.on('message', async message => {
    if (message === 'close') {
      await app.close();
      process.disconnect();
    }
  });
}
main().catch(error => {
  console.error(error);
  process.exitCode = 1;
  if (process.connected) process.disconnect();
});
