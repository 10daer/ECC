/** Synthetic legacy migration: both install roots stay locked across build/apply. */
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { applyInstallPlan } = require('../../scripts/lib/install/apply');
const { repairInstalledStates } = require('../../scripts/lib/install-lifecycle');
const { createInstallState, readInstallState, writeInstallState } = require('../../scripts/lib/install-state');
const { withOpenCodeInstallLocks } = require('../../scripts/lib/install/opencode-install-lock');

const SOURCE_RELATIVE_PATH = path.join('skills', 'skill-comply', 'SKILL.md');
const SKILL_CONTENT = '---\nname: skill-comply\ndescription: Synthetic migration fixture.\n---\n\n# Inert fixture\n';
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const lockPath = root => path.join(root, 'ecc-install-state.json.ecc.lock');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function privateFixture(callback) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-legacy-consent-lock-')));
  const sourceRoot = path.join(root, 'source');
  const homeDir = path.join(root, 'home');
  const legacyRoot = path.join(homeDir, '.opencode');
  const canonicalRoot = path.join(homeDir, '.config', 'opencode');
  const sourcePath = path.join(sourceRoot, SOURCE_RELATIVE_PATH);
  const legacyFile = path.join(legacyRoot, SOURCE_RELATIVE_PATH);
  const legacyStatePath = path.join(legacyRoot, 'ecc-install-state.json');
  const canonicalStatePath = path.join(canonicalRoot, 'ecc-install-state.json');
  const adapter = { id: 'opencode-home', target: 'opencode', kind: 'home' };
  try {
    writeJson(path.join(sourceRoot, 'package.json'), { name: 'synthetic-ecc-lock-fixture', version: '2.2.2' });
    writeJson(path.join(sourceRoot, 'manifests', 'install-modules.json'), {
      version: 1,
      modules: [{ id: 'workflow-quality', kind: 'skills', description: 'Inert test skill.',
        paths: [SOURCE_RELATIVE_PATH], targets: ['opencode'], dependencies: [],
        defaultInstall: false, cost: 'light', stability: 'stable' }],
    });
    writeJson(path.join(sourceRoot, 'manifests', 'install-profiles.json'), { version: 1, profiles: {} });
    writeJson(path.join(sourceRoot, 'manifests', 'install-components.json'), { version: 1, components: [] });
    for (const filePath of [sourcePath, legacyFile]) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, SKILL_CONTENT);
    }
    const operation = { kind: 'copy-file', moduleId: 'workflow-quality',
      sourceRelativePath: SOURCE_RELATIVE_PATH, destinationPath: legacyFile,
      strategy: 'preserve-relative-path', ownership: 'managed', scaffoldOnly: false,
      contentSha256: sha256(SKILL_CONTENT) };
    const stateOptions = {
      adapter,
      request: { profile: null, modules: ['workflow-quality'], includeComponents: [],
        excludeComponents: [], legacyLanguages: [], legacyMode: false, hookConsent: null },
      resolution: { selectedModules: ['workflow-quality'], skippedModules: [] },
      source: { repoVersion: '2.2.2', repoCommit: 'synthetic-legacy-lock-fixture', manifestVersion: 1 },
    };
    writeInstallState(legacyStatePath, createInstallState({ ...stateOptions,
      targetRoot: legacyRoot, installStatePath: legacyStatePath, operations: [operation] }));
    const canonicalOperation = { ...operation, sourcePath,
      destinationPath: path.join(canonicalRoot, SOURCE_RELATIVE_PATH) };
    const canonicalPlan = {
      target: 'opencode', adapter, sourceRoot, homeDir, targetRoot: canonicalRoot,
      installRoot: canonicalRoot, installStatePath: canonicalStatePath,
      selectedModuleIds: ['workflow-quality'], operations: [canonicalOperation], warnings: [],
      statePreview: createInstallState({ ...stateOptions, targetRoot: canonicalRoot,
        installStatePath: canonicalStatePath, operations: [canonicalOperation] }),
    };
    const sourceFiles = ['package.json', 'manifests/install-modules.json',
      'manifests/install-profiles.json', 'manifests/install-components.json', SOURCE_RELATIVE_PATH];
    const sourceSnapshot = new Map(sourceFiles.map(relative => [relative,
      fs.readFileSync(path.join(sourceRoot, relative))]));
    callback({ root, homeDir, sourceRoot, sourcePath, sourceSnapshot, legacyRoot, canonicalRoot,
      legacyFile, legacyStatePath, canonicalStatePath, canonicalPlan });
  } finally {
    // The generated payload and all install paths are inside this fixture.
    // No repository assets, compiler output, real user home or providers are used.
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function repair(value, buildOpencodePayload) {
  return repairInstalledStates({ repoRoot: value.sourceRoot, homeDir: value.homeDir,
    projectRoot: value.homeDir, targets: ['opencode'], env: {}, buildOpencodePayload });
}

function assertSourceUnchanged(value) {
  for (const [relative, bytes] of value.sourceSnapshot) {
    assert.deepStrictEqual(fs.readFileSync(path.join(value.sourceRoot, relative)), bytes, relative);
  }
}

function assertHeldAndIndependentWritersRefused(value) {
  const lockBytes = [value.canonicalRoot, value.legacyRoot].map(targetRoot => {
    const bytes = fs.readFileSync(lockPath(targetRoot));
    assert.strictEqual(JSON.parse(bytes).pid, process.pid);
    return bytes;
  });
  const legacyBytes = fs.readFileSync(value.legacyStatePath);
  assert.throws(() => applyInstallPlan(value.canonicalPlan, {
    beforeInstallStateRead() { assert.fail('Independent apply reached state read while migration held both locks'); },
  }), /Another ECC process.*OpenCode/);
  let nestedBuilds = 0;
  const nested = repair(value, () => {
    nestedBuilds++;
    assert.fail('Independent repair reached build while migration held both locks');
  });
  assert.strictEqual(nested.results.length, 1, JSON.stringify(nested));
  assert.strictEqual(nested.results[0].status, 'error');
  assert.match(nested.results[0].error, /Another ECC process.*OpenCode/);
  assert.strictEqual(nestedBuilds, 0);
  assert.strictEqual(fs.existsSync(value.canonicalStatePath), false);
  assert.deepStrictEqual(fs.readFileSync(value.legacyStatePath), legacyBytes);
  [value.canonicalRoot, value.legacyRoot].forEach((targetRoot, index) => {
    assert.deepStrictEqual(fs.readFileSync(lockPath(targetRoot)), lockBytes[index]);
  });
}

function assertBothLocksReleased(value) {
  for (const targetRoot of [value.canonicalRoot, value.legacyRoot]) {
    assert.strictEqual(fs.existsSync(lockPath(targetRoot)), false);
  }
  withOpenCodeInstallLocks([value.canonicalRoot, value.legacyRoot], () => {
    assert.ok(fs.existsSync(lockPath(value.canonicalRoot)));
    assert.ok(fs.existsSync(lockPath(value.legacyRoot)));
  });
  for (const targetRoot of [value.canonicalRoot, value.legacyRoot]) {
    assert.strictEqual(fs.existsSync(lockPath(targetRoot)), false);
  }
}

function runTests() {
  let passed = 0;
  let failed = 0;
  function test(name, callback) {
    try { privateFixture(callback); passed++; console.log(`  PASS ${name}`); }
    catch (error) { failed++; console.error(`  FAIL ${name}: ${error.stack}`); }
  }
  test('legacy repair holds both roots before build and releases them after a throwing builder', value => {
    const beforeState = fs.readFileSync(value.legacyStatePath);
    let builds = 0;
    const result = repair(value, sourceRoot => {
      builds++;
      assert.strictEqual(sourceRoot, value.sourceRoot);
      assertHeldAndIndependentWritersRefused(value);
      throw new Error('Synthetic builder failure before any source mutation');
    });
    assert.strictEqual(builds, 1);
    assert.strictEqual(result.results.length, 1, JSON.stringify(result));
    assert.strictEqual(result.results[0].status, 'error');
    assert.match(result.results[0].error, /Synthetic builder failure before any source mutation/);
    assert.strictEqual(result.results[0].stateRefreshed, undefined);
    assert.deepStrictEqual(fs.readFileSync(value.legacyStatePath), beforeState);
    assert.strictEqual(fs.readFileSync(value.legacyFile, 'utf8'), SKILL_CONTENT);
    assert.strictEqual(fs.existsSync(value.canonicalStatePath), false);
    assert.strictEqual(fs.existsSync(path.join(value.sourceRoot, '.opencode', 'dist')), false);
    assertSourceUnchanged(value);
    assertBothLocksReleased(value);
  });
  test('legacy repair reuses its opaque lease for canonical apply after an inert synthetic build', value => {
    let builds = 0;
    const result = repair(value, sourceRoot => {
      builds++;
      assert.strictEqual(sourceRoot, value.sourceRoot);
      assertHeldAndIndependentWritersRefused(value);
      const dist = path.join(sourceRoot, '.opencode', 'dist');
      fs.mkdirSync(path.join(dist, 'plugins'), { recursive: true });
      fs.mkdirSync(path.join(dist, 'tools'), { recursive: true });
      fs.writeFileSync(path.join(dist, 'index.js'), 'module.exports = {};\n');
    });
    assert.strictEqual(builds, 1);
    assert.strictEqual(result.summary.errorCount, 0, JSON.stringify(result));
    assert.strictEqual(result.results.length, 1, JSON.stringify(result));
    assert.strictEqual(result.results[0].status, 'repaired');
    assert.strictEqual(result.results[0].stateRefreshed, true);
    assert.strictEqual(result.results[0].installStatePath, value.canonicalStatePath);
    const state = readInstallState(value.canonicalStatePath);
    assert.strictEqual(state.target.root, value.canonicalRoot);
    assert.deepStrictEqual(state.resolution.selectedModules, ['workflow-quality']);
    assert.notStrictEqual(state.request.hookConsent, 'enabled');
    assert.strictEqual(state.operations.length, 1);
    assert.strictEqual(state.operations[0].contentSha256, sha256(SKILL_CONTENT));
    assert.strictEqual(fs.readFileSync(path.join(value.canonicalRoot, SOURCE_RELATIVE_PATH), 'utf8'), SKILL_CONTENT);
    assert.strictEqual(fs.existsSync(value.legacyStatePath), false);
    assert.strictEqual(fs.existsSync(value.legacyFile), false);
    assertSourceUnchanged(value);
    assertBothLocksReleased(value);
  });
  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  return { passed, failed };
}

if (require.main === module) process.exitCode = runTests().failed ? 1 : 0;
module.exports = { runTests };
