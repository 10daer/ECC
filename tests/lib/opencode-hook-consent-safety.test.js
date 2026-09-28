'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { applyInstallPlan } = require('../../scripts/lib/install/apply');
const { withHookConsent } = require('../../scripts/lib/install/hook-consent');
const { createInstallState, readInstallState, writeInstallState } = require('../../scripts/lib/install-state');
const { buildDoctorReport, repairInstalledStates } = require('../../scripts/lib/install-lifecycle');

const REPO_ROOT = path.resolve(__dirname, '../..');
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

function fixture(callback, enabled = false) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-opencode-write-')));
  const homeDir = path.join(root, 'home');
  const sourceRoot = path.join(root, 'source');
  const targetRoot = path.join(homeDir, '.config', 'opencode');
  const adapter = { id: 'opencode-home', target: 'opencode', kind: 'home' };
  try {
    fs.mkdirSync(path.join(sourceRoot, 'manifests'), { recursive: true });
    for (const name of ['install-modules.json', 'install-components.json', 'install-profiles.json']) {
      fs.copyFileSync(path.join(REPO_ROOT, 'manifests', name), path.join(sourceRoot, 'manifests', name));
    }
    fs.copyFileSync(path.join(REPO_ROOT, 'package.json'), path.join(sourceRoot, 'package.json'));
    const operations = ['opencode.json', 'plugins/ecc-hooks.ts'].map(relativePath => {
      const sourceRelativePath = `.opencode/${relativePath}`;
      const sourcePath = path.join(sourceRoot, sourceRelativePath);
      const destinationPath = path.join(targetRoot, relativePath);
      const content = relativePath === 'opencode.json'
        ? '{"plugin":["./plugins"],"userSetting":true}\n'
        : 'export default async () => ({ "session.created": () => {} });\n';
      fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
      fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
      fs.writeFileSync(sourcePath, content);
      fs.writeFileSync(destinationPath, content);
      return { kind: 'copy-file', moduleId: 'platform-configs', sourceRelativePath, sourcePath,
        destinationPath, ownership: 'managed', scaffoldOnly: false,
        strategy: 'preserve-relative-path', contentSha256: sha256(content) };
    });
    const dist = path.join(sourceRoot, '.opencode', 'dist');
    fs.mkdirSync(path.join(dist, 'plugins'), { recursive: true });
    fs.mkdirSync(path.join(dist, 'tools'), { recursive: true });
    fs.writeFileSync(path.join(dist, 'index.js'), 'module.exports = {};\n');
    const installStatePath = path.join(targetRoot, 'ecc-install-state.json');
    const state = createInstallState({
      adapter, targetRoot, installStatePath,
      request: { modules: ['platform-configs'], legacyMode: true,
        hookConsent: enabled ? 'enabled' : null },
      resolution: { selectedModules: enabled ? ['platform-configs', 'hooks-runtime'] : ['platform-configs'],
        skippedModules: [] },
      operations, source: { repoVersion: '2.2.2', manifestVersion: 1 },
    });
    writeInstallState(installStatePath, state);
    const basePlan = { target: 'opencode', adapter, homeDir, sourceRoot, targetRoot,
      installRoot: targetRoot, installStatePath, operations, warnings: [],
      selectedModuleIds: state.resolution.selectedModules, statePreview: state };
    callback({ root, homeDir, sourceRoot, targetRoot, installStatePath, state, basePlan,
      declinePlan: withHookConsent(basePlan, 'declined') });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function repair(value, extra = {}) {
  return repairInstalledStates({ repoRoot: value.sourceRoot, homeDir: value.homeDir,
    projectRoot: value.homeDir, targets: ['opencode'],
    buildOpencodePayload() { throw new Error('Unexpected compiler execution'); }, ...extra });
}

function withWritableOpenMutation(filePath, mutate, callback) {
  const originalOpen = fs.openSync;
  const originalClose = fs.closeSync;
  let injected = false;
  const descriptors = new Set();
  fs.openSync = function (candidate, flags, ...rest) {
    const writable = typeof flags === 'number'
      ? Boolean(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR))
      : /[wa+]/.test(flags);
    const matches = typeof candidate === 'string' && path.resolve(candidate) === path.resolve(filePath);
    if (matches && writable && !injected) {
      injected = true;
      mutate();
    }
    const fd = originalOpen.call(fs, candidate, flags, ...rest);
    if (matches && writable) descriptors.add(fd);
    return fd;
  };
  fs.closeSync = function (fd) {
    descriptors.delete(fd);
    return originalClose.call(fs, fd);
  };
  try {
    callback();
    assert.ok(injected, 'The destination writable-open boundary must be exercised');
    assert.strictEqual(descriptors.size, 0, 'Every owned writable descriptor must close');
  } finally {
    fs.openSync = originalOpen;
    fs.closeSync = originalClose;
  }
}

function assertPriorOwnership(value, filePath) {
  const after = readInstallState(value.installStatePath);
  const prior = value.state.operations.find(operation => operation.destinationPath === filePath);
  const current = after.operations.find(operation => operation.destinationPath === filePath);
  assert.strictEqual(current.contentSha256, prior.contentSha256, 'Do not adopt raced bytes');
  assert.strictEqual(after.request.hookConsent, value.state.request.hookConsent);
}

function runTests() {
  let passed = 0;
  let failed = 0;
  const test = (name, callback) => {
    try { callback(); passed++; console.log(`  PASS ${name}`); }
    catch (error) { failed++; console.error(`  FAIL ${name}: ${error.stack}`); }
  };
  for (const relativePath of ['plugins/ecc-hooks.ts', 'opencode.json']) {
    for (const mode of ['apply', 'repair']) {
      test(`${mode} preserves a same-inode ${relativePath} edit at writable open`, () => fixture(value => {
        const destination = path.join(value.targetRoot, relativePath);
        const content = relativePath === 'opencode.json'
          ? '{"plugin":["./plugins"],"userEdit":"keep"}\n' : '// user edit: preserve this\n';
        withWritableOpenMutation(destination, () => fs.writeFileSync(destination, content), () => {
          if (mode === 'apply') {
            assert.throws(() => applyInstallPlan(value.declinePlan), /changed after preflight/i);
          } else {
            const result = repair(value).results[0];
            assert.strictEqual(result.status, 'error');
            assert.match(result.error, /changed after preflight/i);
            assert.notStrictEqual(result.stateRefreshed, true);
          }
          assert.strictEqual(fs.readFileSync(destination, 'utf8'), content);
          assertPriorOwnership(value, destination);
        });
      }, mode === 'apply'));
    }
  }
  for (const mode of ['apply', 'repair']) {
    test(`${mode} preserves a file created after expected absence`, () => fixture(value => {
      const destination = path.join(value.targetRoot, 'plugins/ecc-hooks.ts');
      fs.unlinkSync(destination);
      const content = '// newly created user file\n';
      withWritableOpenMutation(destination, () => fs.writeFileSync(destination, content), () => {
        if (mode === 'apply') assert.throws(() => applyInstallPlan(value.declinePlan), /EEXIST|changed after preflight/i);
        else assert.strictEqual(repair(value).results[0].status, 'error');
        assert.strictEqual(fs.readFileSync(destination, 'utf8'), content);
        assertPriorOwnership(value, destination);
      });
    }, mode === 'apply'));
    test(`${mode} does not recreate an expected existing file removed at open`, () => fixture(value => {
      const destination = path.join(value.targetRoot, 'opencode.json');
      withWritableOpenMutation(destination, () => fs.unlinkSync(destination), () => {
        if (mode === 'apply') assert.throws(() => applyInstallPlan(value.declinePlan), /ENOENT|changed after preflight/i);
        else assert.strictEqual(repair(value).results[0].status, 'error');
        assert.strictEqual(fs.existsSync(destination), false);
        assertPriorOwnership(value, destination);
      });
    }, mode === 'apply'));
  }
  for (const mode of ['apply', 'doctor', 'repair']) {
    test(`${mode} reports malformed activation config with source context`, () => fixture(value => {
      const destination = path.join(value.targetRoot, 'opencode.json');
      fs.writeFileSync(destination, '{ malformed');
      const before = fs.readFileSync(value.installStatePath);
      if (mode === 'apply') assert.throws(() => applyInstallPlan(value.declinePlan), /Failed to parse .*opencode\.json/);
      else if (mode === 'repair') assert.match(repair(value).results[0].error, /Failed to parse .*opencode\.json/);
      else {
        const result = buildDoctorReport({ repoRoot: value.sourceRoot, homeDir: value.homeDir,
          projectRoot: value.homeDir, targets: ['opencode'] }).results[0];
        assert.match(JSON.stringify(result.issues), /Failed to parse .*opencode\.json/);
      }
      assert.strictEqual(fs.readFileSync(destination, 'utf8'), '{ malformed');
      assert.deepStrictEqual(fs.readFileSync(value.installStatePath), before);
    }));
  }
  test('apply rejects another enabled writer and repair while holding its target lease', () => fixture(value => {
    let checked = false;
    applyInstallPlan(value.declinePlan, {
      beforeOperationWrite() {
        if (checked) return;
        checked = true;
        assert.throws(() => applyInstallPlan(withHookConsent(value.basePlan, 'enabled')), /Another ECC process|OpenCode.*lock/i);
        assert.strictEqual(repair(value).results[0].status, 'error');
      },
    });
    assert.ok(checked);
    assert.strictEqual(fs.existsSync(`${value.installStatePath}.ecc.lock`), false);
    assert.strictEqual(applyInstallPlan(value.declinePlan).applied, true);
  }));
  test('repair preserves ownership for a destination-classified activation with a recorded transform', () => fixture(value => {
    const operation = value.state.operations.find(entry => entry.sourceRelativePath.endsWith('ecc-hooks.ts'));
    const oldDestination = operation.destinationPath;
    operation.sourceRelativePath = '.opencode/tools/fixture.js';
    operation.contentTransform = 'opencode-disable-plugin-entrypoint';
    operation.destinationPath = path.join(value.targetRoot, 'plugins', 'custom.js');
    const source = path.join(value.sourceRoot, operation.sourceRelativePath);
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.copyFileSync(oldDestination, source);
    fs.unlinkSync(oldDestination);
    writeInstallState(value.installStatePath, value.state);
    const content = '// preserve unowned new custom plugin\n';
    withWritableOpenMutation(operation.destinationPath, () => fs.writeFileSync(operation.destinationPath, content), () => {
      const result = repair(value).results[0];
      assert.strictEqual(result.status, 'error');
      assert.match(result.error, /changed after preflight/i);
      assert.strictEqual(fs.readFileSync(operation.destinationPath, 'utf8'), content);
      assertPriorOwnership(value, operation.destinationPath);
    });
  }));
  test('repair completes historical deactivation with exact inert bytes and releases its lock', () => fixture(value => {
    const result = repair(value).results[0];
    assert.strictEqual(result.status, 'repaired', result.error);
    assert.strictEqual(result.stateRefreshed, true);
    assert.strictEqual(fs.readFileSync(path.join(value.targetRoot, 'plugins/ecc-hooks.ts'), 'utf8'),
      'export default async () => ({});\n');
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(value.targetRoot, 'opencode.json'))),
      { plugin: [], userSetting: true });
    assert.strictEqual(fs.existsSync(`${value.installStatePath}.ecc.lock`), false);
  }));
  test('repair preserves the primary failure and replacement lock when release also fails', () => fixture(value => {
    const destination = path.join(value.targetRoot, 'opencode.json');
    const lock = `${value.installStatePath}.ecc.lock`;
    withWritableOpenMutation(destination, () => {
      fs.writeFileSync(destination, '{"userEdit":true}');
      fs.renameSync(lock, `${lock}.owned`);
      fs.writeFileSync(lock, 'replacement lock');
    }, () => {
      const result = repair(value).results[0];
      assert.strictEqual(result.status, 'error');
      assert.match(result.error, /changed after preflight/i);
      assert.match(result.releaseError, /changed OpenCode install lock/);
      assert.strictEqual(fs.readFileSync(lock, 'utf8'), 'replacement lock');
      assertPriorOwnership(value, destination);
    });
  }));
  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  return { passed, failed };
}

if (require.main === module) process.exitCode = runTests().failed ? 1 : 0;
module.exports = { runTests };
