/**
 * Tests for scripts/hooks/stop-verify-gate.js (Stop)
 *
 * The gate must block the turn while checks covering changed files fail, stop
 * blocking after the consecutive-block cap, and fail open everywhere else.
 *
 * Run with: node tests/hooks/stop-verify-gate.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOOK_PATH = path.join(__dirname, '..', '..', 'scripts', 'hooks', 'stop-verify-gate.js');

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    return true;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${err.message}`);
    return false;
  }
}

function gitIn(cwd, args) {
  const result = spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
}

function freshRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-verify-gate-repo-'));
  gitIn(dir, ['init', '-q']);
  fs.writeFileSync(path.join(dir, 'README.txt'), 'seed\n');
  gitIn(dir, ['add', '.']);
  gitIn(dir, ['commit', '-q', '-m', 'seed']);
  return dir;
}

function writeFile(dir, rel, content) {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function runTests() {
  console.log('\n=== Testing stop-verify-gate ===\n');
  let passed = 0;
  let failed = 0;

  const originalGate = process.env.ECC_STOP_VERIFY_GATE;
  const originalStateDir = process.env.ECC_STOP_VERIFY_STATE_DIR;
  delete process.env.ECC_STOP_VERIFY_GATE;
  process.env.ECC_STOP_VERIFY_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-verify-gate-state-'));
  const hook = require(HOOK_PATH);

  if (test('mirroredTest maps scripts/** to tests/**', () => {
    assert.strictEqual(hook.mirroredTest('scripts/lib/utils.js'), 'tests/lib/utils.test.js');
    assert.strictEqual(hook.mirroredTest('scripts/hooks/a-b.js'), 'tests/hooks/a-b.test.js');
    assert.strictEqual(hook.mirroredTest('agents/x.md'), null);
  })) passed++; else failed++;

  if (test('planChecks picks validators, mirrored tests, and linters for the change set', () => {
    const present = new Set([
      'scripts/ci/validate-agents.js',
      'scripts/ci/validate-hooks.js',
      'scripts/ci/check-hooks-schema-keys.js',
      'tests/lib/utils.test.js',
      'node_modules/eslint/bin/eslint.js',
      'node_modules/markdownlint-cli/markdownlint.js'
    ]);
    const checks = hook.planChecks(
      ['agents/code-reviewer.md', 'hooks/hooks.json', 'scripts/lib/utils.js', 'scripts/lib/untested.js'],
      rel => present.has(rel)
    );
    assert.deepStrictEqual(checks.map(c => c.label), [
      'scripts/ci/validate-agents.js',
      'scripts/ci/validate-hooks.js',
      'scripts/ci/check-hooks-schema-keys.js',
      'tests/lib/utils.test.js',
      'eslint',
      'markdownlint'
    ]);
    assert.deepStrictEqual(checks.find(c => c.label === 'markdownlint').args.slice(1), ['agents/code-reviewer.md']);
  })) passed++; else failed++;

  if (test('planChecks returns nothing for files no check covers', () => {
    assert.deepStrictEqual(hook.planChecks(['docs/image.png'], () => true), []);
  })) passed++; else failed++;

  if (test('fails open on unparseable stdin and when disabled', () => {
    assert.strictEqual(hook.run('not json').exitCode, 0);
    process.env.ECC_STOP_VERIFY_GATE = 'off';
    try {
      assert.strictEqual(hook.run('{}').exitCode, 0);
    } finally {
      delete process.env.ECC_STOP_VERIFY_GATE;
    }
  })) passed++; else failed++;

  if (test('fails open outside a git repository', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-verify-gate-nogit-'));
    assert.strictEqual(hook.run(JSON.stringify({ cwd: dir })).exitCode, 0);
  })) passed++; else failed++;

  if (test('blocks on a failing changed test, then releases after the cap', () => {
    const dir = freshRepo();
    writeFile(dir, 'tests/broken.test.js', "console.log('boom-marker'); process.exit(1);\n");
    const input = JSON.stringify({ cwd: dir });

    for (let attempt = 1; attempt <= 3; attempt++) {
      const result = hook.run(input);
      assert.strictEqual(result.exitCode, 2, `attempt ${attempt} should block`);
      assert.ok(result.stderr.includes('tests/broken.test.js'));
      assert.ok(result.stderr.includes('boom-marker'));
      assert.ok(result.stderr.includes(`attempt ${attempt}/3`));
    }
    const released = hook.run(input);
    assert.strictEqual(released.exitCode, 0);
    assert.ok(released.stderr.includes('still failing'));
  })) passed++; else failed++;

  if (test('passes when changed checks pass and re-checks after a later edit', () => {
    const dir = freshRepo();
    writeFile(dir, 'tests/ok.test.js', 'process.exit(0);\n');
    const input = JSON.stringify({ cwd: dir });
    assert.strictEqual(hook.run(input).exitCode, 0);

    writeFile(dir, 'tests/ok.test.js', 'process.exit(1); // now failing\n');
    assert.strictEqual(hook.run(input).exitCode, 2);
  })) passed++; else failed++;

  if (originalGate === undefined) delete process.env.ECC_STOP_VERIFY_GATE;
  else process.env.ECC_STOP_VERIFY_GATE = originalGate;
  if (originalStateDir === undefined) delete process.env.ECC_STOP_VERIFY_STATE_DIR;
  else process.env.ECC_STOP_VERIFY_STATE_DIR = originalStateDir;

  console.log('\n========================================');
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  console.log('========================================\n');
  return failed === 0;
}

if (require.main === module) {
  process.exit(runTests() ? 0 : 1);
}

module.exports = { runTests };
