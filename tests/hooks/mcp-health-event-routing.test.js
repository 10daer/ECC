/** Regression coverage for native MCP hook events through the production runner. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '../..');
const runner = path.join(root, 'scripts/hooks/run-with-flags.js');
let passed = 0;
let failed = 0;

function test(name, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-mcp-event-'));
  try {
    fn(dir);
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed++;
    console.error(`  ✗ ${name}: ${error.message}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function runHook(dir, input, legacyEvent) {
  const statePath = path.join(dir, 'health.json');
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(ECC_|CLAUDE_)/i.test(key)) delete env[key];
  }
  Object.assign(env, {
    HOME: dir,
    USERPROFILE: dir,
    ECC_PLUGIN_ROOT: root,
    ECC_HOOK_PROFILE: 'standard',
    ECC_MCP_CONFIG_PATH: path.join(dir, 'missing-config.json'),
    ECC_MCP_HEALTH_STATE_PATH: statePath,
    ECC_MCP_HEALTH_BACKOFF_MS: '60000'
  });
  if (legacyEvent) env.CLAUDE_HOOK_EVENT_NAME = legacyEvent;
  const raw = JSON.stringify(input);
  const result = spawnSync(process.execPath, [
    runner,
    input.hook_event_name === 'PreToolUse' ? 'pre:mcp-health-check' : 'post:mcp-health-check',
    'scripts/hooks/mcp-health-check.js',
    'standard,strict'
  ], { cwd: dir, env, input: raw, encoding: 'utf8', timeout: 10000 });
  assert.ifError(result.error);
  assert.strictEqual(result.signal, null);
  assert.strictEqual(result.stdout, raw);
  return { result, statePath };
}

function assertRecordedFailure(dir, legacyEvent, includeNativeEvent = true) {
  const input = { tool_name: 'mcp__routing__query', tool_input: {}, error: '401 Unauthorized' };
  if (includeNativeEvent) input.hook_event_name = 'PostToolUseFailure';
  const { result, statePath } = runHook(dir, input, legacyEvent);
  assert.strictEqual(result.status, 0, result.stderr);
  assert.match(result.stderr, /routing reported 401/);
  const server = JSON.parse(fs.readFileSync(statePath, 'utf8')).servers.routing;
  assert.strictEqual(server.status, 'unhealthy');
  assert.strictEqual(server.lastFailureCode, 401);
  assert.strictEqual(server.failureCount, 1);
  assert.ok(server.nextRetryAt > server.checkedAt);
}

test('native PostToolUseFailure records backoff without a legacy event variable', dir => {
  assertRecordedFailure(dir);
});

test('native failure event takes precedence over a conflicting legacy variable', dir => {
  assertRecordedFailure(dir, 'PreToolUse');
});

test('legacy failure event remains supported when the payload omits the event', dir => {
  assertRecordedFailure(dir, 'PostToolUseFailure', false);
});

test('native PreToolUse retains preflight blocking despite a legacy failure event', dir => {
  const statePath = path.join(dir, 'health.json');
  const before = JSON.stringify({ version: 1, servers: { routing: {
    status: 'unhealthy', failureCount: 1, nextRetryAt: Date.now() + 60000
  } } });
  fs.writeFileSync(statePath, before);
  const { result } = runHook(dir, {
    hook_event_name: 'PreToolUse', tool_name: 'mcp__routing__query', tool_input: {}
  }, 'PostToolUseFailure');
  assert.strictEqual(result.status, 2, result.stderr);
  assert.match(result.stderr, /marked unhealthy/);
  assert.strictEqual(fs.readFileSync(statePath, 'utf8'), before);
});

console.log(`\nPassed: ${passed}\nFailed: ${failed}`);
process.exitCode = failed ? 1 : 0;
