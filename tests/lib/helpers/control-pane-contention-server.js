'use strict';

const { createControlPaneServer } = require('../../../scripts/lib/control-pane/server');

async function main() {
  const app = createControlPaneServer({
    host: '127.0.0.1', port: 0, stateDbPath: process.argv[2],
    dbPath: `${process.argv[2]}.ecc2`, allowActions: process.argv[3] !== 'read-only'
  });
  app.server.prependListener('request', req => {
    if (req.method === 'POST') process.send({ type: 'mutation-received' });
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
