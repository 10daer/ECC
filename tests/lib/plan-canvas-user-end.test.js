'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createSessionStore } = require('../../scripts/lib/plan-canvas/sessions');
const { createPlanCanvasServer } = require('../../scripts/lib/plan-canvas/server');

function request(port, method, route, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: route, agent: false,
      headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {},
    }, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(text) }); } catch (error) { reject(error); }
      });
      res.on('error', reject);
    });
    req.setTimeout(5000, () => req.destroy(new Error('request timed out')));
    req.on('error', reject);
    req.end(payload);
  });
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-canvas-user-end-'));
  const store = createSessionStore({ stateDir: path.join(root, 'state') });
  const server = createPlanCanvasServer({ store, idleTimeoutMs: 0 });
  let listening = false;
  try {
    const { port } = await server.listen(0);
    listening = true;
    for (const endMode of ['end', 'feedback']) {
      const file = path.join(root, `${endMode}.md`);
      fs.writeFileSync(file, '# Review\n');
      const opened = await request(port, 'POST', '/api/sessions', { file });
      assert.strictEqual(opened.status, 200);
      const key = opened.body.key;
      const ended = await request(port, 'POST', `/api/session/${key}/${endMode}`,
        endMode === 'feedback' ? { items: [{ kind: 'chat', text: 'Final feedback' }], endSession: true } : {});
      assert.strictEqual(ended.status, 200);
      const before = fs.readFileSync(store.stateFile, 'utf8');
      const repeated = await request(port, 'POST', '/api/end', { file });
      assert.strictEqual(repeated.status, 200);
      assert.strictEqual(repeated.body.endedBy, 'user');
      assert.strictEqual(fs.readFileSync(store.stateFile, 'utf8'), before);
      const reloaded = createSessionStore({ stateDir: store.stateDir });
      assert.strictEqual(reloaded.open(file).refused, true);
      const feedback = await request(port, 'GET', `/api/await?key=${key}&timeoutMs=0`);
      assert.strictEqual(feedback.body.endedBy, 'user');
      if (endMode === 'feedback') assert.strictEqual(feedback.body.items[0].text, 'Final feedback');
      assert.strictEqual((await request(port, 'POST', '/api/sessions', { file })).status, 409);
      assert.strictEqual((await request(port, 'POST', '/api/sessions', { file, reopen: true })).status, 200);
      assert.strictEqual((await request(port, 'POST', '/api/end', { file })).body.endedBy, 'agent');
      assert.strictEqual((await request(port, 'POST', '/api/sessions', { file })).status, 200);
      console.log(`PASS ${endMode}: user closure survives repeated program end; explicit reopen still works`);
    }
  } finally {
    if (listening) await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
