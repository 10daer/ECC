/** Cooperative OpenCode installation lock scopes, without child processes. */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { acquireOpenCodeInstallLocks, withOpenCodeInstallLocks } = require('../../scripts/lib/install/opencode-install-lock');
const { acquireSettingsLock, getSettingsLockIdentity, sameFileIdentity } = require('../../scripts/lib/install/claude-settings-lock');
let passed = 0;
let failed = 0;
const lockPath = root => path.join(root, 'ecc-install-state.json.ecc.lock');
function test(name, callback) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-opencode-lock-')));
  try { callback(root); passed++; console.log(`  PASS ${name}`); }
  catch (error) { failed++; console.error(`  FAIL ${name}: ${error.stack}`); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}
test('same target refuses an independent writer and releases on success', root => {
  assert.strictEqual(withOpenCodeInstallLocks([root], lease => {
    assert.ok(Object.isFrozen(lease));
    assert.ok(fs.existsSync(lockPath(root)));
    assert.throws(() => acquireOpenCodeInstallLocks([root]), /Another ECC process.*OpenCode/);
    return 'done';
  }), 'done');
  assert.strictEqual(fs.existsSync(lockPath(root)), false);
});
test('different roots can be held independently', root => {
  const other = path.join(root, 'other');
  withOpenCodeInstallLocks([root], () => withOpenCodeInstallLocks([other], () => {
    assert.ok(fs.existsSync(lockPath(root)) && fs.existsSync(lockPath(other)));
  }));
  assert.strictEqual(fs.existsSync(lockPath(other)), false);
});
test('roots are deduplicated, sorted and released in reverse order', root => {
  const a = path.join(root, 'a');
  const b = path.join(root, 'b');
  const linked = [];
  const renamed = [];
  const originalLink = fs.linkSync;
  const originalRename = fs.renameSync;
  fs.linkSync = (from, to) => { linked.push(to); return originalLink(from, to); };
  fs.renameSync = (from, to) => { renamed.push(from); return originalRename(from, to); };
  try { withOpenCodeInstallLocks([b, a, b], () => {}); }
  finally { fs.linkSync = originalLink; fs.renameSync = originalRename; }
  assert.deepStrictEqual(linked, [lockPath(a), lockPath(b)]);
  assert.deepStrictEqual(renamed, [lockPath(b), lockPath(a)]);
});
test('nested use requires a real active lease with full coverage', root => {
  const holder = acquireOpenCodeInstallLocks([root]);
  const nested = acquireOpenCodeInstallLocks([root], holder.lease);
  assert.strictEqual(nested.lease, holder.lease);
  nested.release();
  assert.ok(fs.existsSync(lockPath(root)));
  assert.throws(() => acquireOpenCodeInstallLocks([path.join(root, 'missing')], holder.lease), /cover/);
  assert.throws(() => acquireOpenCodeInstallLocks([root], true), /lease/);
  assert.throws(() => acquireOpenCodeInstallLocks([root], {}), /lease/);
  holder.release();
  holder.release();
  assert.throws(() => acquireOpenCodeInstallLocks([root], holder.lease), /lease/);
});
test('callback error retains identity and releases', root => {
  const primary = new Error('callback failure');
  assert.throws(() => withOpenCodeInstallLocks([root], () => { throw primary; }), error => error === primary);
  assert.strictEqual(fs.existsSync(lockPath(root)), false);
});
test('second lock failure releases the first without disturbing the other owner', root => {
  const a = path.join(root, 'a');
  const b = path.join(root, 'b');
  const other = acquireOpenCodeInstallLocks([b]);
  const bytes = fs.readFileSync(lockPath(b));
  try { assert.throws(() => acquireOpenCodeInstallLocks([b, a]), /Another ECC process/); }
  finally { assert.deepStrictEqual(fs.readFileSync(lockPath(b)), bytes); other.release(); }
  assert.strictEqual(fs.existsSync(lockPath(a)), false);
});
test('a replaced lock invalidates nested reuse and is preserved on release', root => {
  const holder = acquireOpenCodeInstallLocks([root]);
  fs.renameSync(lockPath(root), `${lockPath(root)}.owned`);
  fs.writeFileSync(lockPath(root), 'replacement');
  assert.throws(() => acquireOpenCodeInstallLocks([root], holder.lease), /changed/);
  assert.throws(() => holder.release(), /changed/);
  assert.strictEqual(fs.readFileSync(lockPath(root), 'utf8'), 'replacement');
});
test('release failure is attached without hiding the callback failure', root => {
  const primary = new Error('primary');
  assert.throws(() => withOpenCodeInstallLocks([root], () => {
    fs.renameSync(lockPath(root), `${lockPath(root)}.owned`);
    fs.writeFileSync(lockPath(root), 'replacement');
    throw primary;
  }), error => error === primary && /changed/.test(error.releaseError.message));
  assert.strictEqual(fs.readFileSync(lockPath(root), 'utf8'), 'replacement');
});
test('invalid root and non-file lock paths refuse before callback', root => {
  for (const roots of [null, ['relative'], [true], ['']]) {
    assert.throws(() => acquireOpenCodeInstallLocks(roots), /root/);
  }
  fs.mkdirSync(lockPath(root));
  assert.throws(() => withOpenCodeInstallLocks([root], () => assert.fail('must refuse')), /lock/);
});
test('lock engine still recovers a stale malformed lock', root => {
  fs.writeFileSync(lockPath(root), 'stale');
  const old = new Date(Date.now() - 600000);
  fs.utimesSync(lockPath(root), old, old);
  withOpenCodeInstallLocks([root], () => assert.match(fs.readFileSync(lockPath(root), 'utf8'), /"pid"/));
  assert.strictEqual(fs.existsSync(lockPath(root)), false);
});
test('a root or lock reported as a symlink refuses without callback or outside access', root => {
  for (const target of [root, lockPath(root)]) {
    if (target !== root) fs.writeFileSync(target, 'unrelated target');
    const original = fs.lstatSync;
    fs.lstatSync = (...args) => {
      const stats = original(...args);
      if (args[0] === target) {
        const symlink = Object.create(stats);
        symlink.isSymbolicLink = () => true;
        return symlink;
      }
      return stats;
    };
    try {
      assert.throws(() => withOpenCodeInstallLocks([root], () => assert.fail('must refuse')), /symlink/);
    } finally { fs.lstatSync = original; }
    if (target !== root) assert.strictEqual(fs.readFileSync(target, 'utf8'), 'unrelated target');
  }
});
test('permission errors remain permission errors', root => {
  const original = fs.lstatSync;
  const denied = Object.assign(new Error('permission denied'), { code: 'EACCES' });
  fs.lstatSync = (...args) => { if (args[0] === lockPath(root)) throw denied; return original(...args); };
  try { assert.throws(() => acquireOpenCodeInstallLocks([root]), error => error === denied); }
  finally { fs.lstatSync = original; }
  assert.strictEqual(fs.existsSync(lockPath(root)), false);
});
test('releasing all roots continues after one replaced lock and rejects later lease reuse', root => {
  const a = path.join(root, 'a');
  const b = path.join(root, 'b');
  const holder = acquireOpenCodeInstallLocks([a, b]);
  fs.renameSync(lockPath(b), `${lockPath(b)}.owned`);
  fs.writeFileSync(lockPath(b), 'replacement');
  assert.throws(() => holder.release(), /changed/);
  assert.strictEqual(fs.existsSync(lockPath(a)), false);
  assert.strictEqual(fs.readFileSync(lockPath(b), 'utf8'), 'replacement');
  assert.throws(() => acquireOpenCodeInstallLocks([a], holder.lease), /lease/);
});
test('a root replaced during a held scope is preserved while other roots release and the lease expires', root => {
  const a = path.join(root, 'a');
  const b = path.join(root, 'b');
  const movedRoot = path.join(root, 'b-original');
  const replacementState = path.join(b, 'ecc-install-state.json');
  let heldLease;
  let originalLockBytes;
  assert.throws(() => withOpenCodeInstallLocks([a, b], lease => {
    heldLease = lease;
    originalLockBytes = fs.readFileSync(lockPath(b));
    fs.renameSync(b, movedRoot);
    fs.mkdirSync(b);
    fs.writeFileSync(lockPath(b), 'replacement root lock');
    fs.writeFileSync(replacementState, 'replacement root state');
    return 'release must refuse instead of returning this result';
  }), /Refusing changed OpenCode install lock root/);
  assert.strictEqual(fs.existsSync(lockPath(a)), false);
  assert.strictEqual(fs.readFileSync(lockPath(b), 'utf8'), 'replacement root lock');
  assert.strictEqual(fs.readFileSync(replacementState, 'utf8'), 'replacement root state');
  assert.deepStrictEqual(fs.readdirSync(b).sort(), ['ecc-install-state.json', 'ecc-install-state.json.ecc.lock']);
  assert.deepStrictEqual(fs.readFileSync(lockPath(movedRoot)), originalLockBytes);
  assert.throws(() => acquireOpenCodeInstallLocks([a, b], heldLease), /Invalid or inactive OpenCode install lease/);
  withOpenCodeInstallLocks([a], () => assert.ok(fs.existsSync(lockPath(a))));
  assert.strictEqual(fs.existsSync(lockPath(a)), false);
});
test('an absent callback is rejected before a lock is created', root => {
  assert.throws(() => withOpenCodeInstallLocks([root], null), /callback/);
  assert.strictEqual(fs.existsSync(lockPath(root)), false);
});
test('a replacement immediately after lock publication cannot enter the protected callback', root => {
  const target = lockPath(root);
  const originalLink = fs.linkSync;
  let callbacks = 0;
  let replacements = 0;
  fs.linkSync = (from, to) => {
    originalLink(from, to);
    if (to === target) {
      replacements++;
      fs.renameSync(target, `${target}.owned`);
      fs.writeFileSync(target, 'replacement at acquisition boundary');
    }
  };
  try {
    assert.throws(() => withOpenCodeInstallLocks([root], () => { callbacks++; }), /changed .*lock/);
  } finally { fs.linkSync = originalLink; }
  assert.strictEqual(replacements, 1);
  assert.strictEqual(callbacks, 0, 'A pathname replacement must never become the acquired identity');
  assert.strictEqual(fs.readFileSync(target, 'utf8'), 'replacement at acquisition boundary');
  assert.strictEqual(JSON.parse(fs.readFileSync(`${target}.owned`, 'utf8')).pid, process.pid);
});
test('a transient post-acquisition validation failure releases authentic locks and preserves the primary error', root => {
  const a = path.join(root, 'a');
  const b = path.join(root, 'b');
  const primary = Object.assign(new Error('one-shot validation error'), { code: 'EIO' });
  const originalLink = fs.linkSync;
  const originalStat = fs.lstatSync;
  let published = false;
  let faults = 0;
  let callbacks = 0;
  let caught;
  fs.linkSync = (from, to) => {
    originalLink(from, to);
    if (to === lockPath(b)) published = true;
  };
  fs.lstatSync = (...args) => {
    if (published && args[0] === b && faults === 0) { faults++; throw primary; }
    return originalStat(...args);
  };
  try {
    try { withOpenCodeInstallLocks([a, b], () => { callbacks++; }); }
    catch (error) { caught = error; }
  } finally { fs.linkSync = originalLink; fs.lstatSync = originalStat; }
  assert.strictEqual(faults, 1);
  assert.strictEqual(callbacks, 0);
  assert.strictEqual(caught, primary);
  assert.strictEqual(caught.releaseError, undefined, 'Cleanup must not dereference a missing identity');
  assert.strictEqual(fs.existsSync(lockPath(a)), false);
  assert.strictEqual(fs.existsSync(lockPath(b)), false);
});
test('engine ownership metadata is immutable and derived from the acquired descriptor', root => {
  const settingsPath = path.join(root, 'settings.json');
  const release = acquireSettingsLock(settingsPath);
  try {
    const identity = getSettingsLockIdentity(release);
    assert.ok(Object.isFrozen(identity));
    assert.deepStrictEqual(Object.keys(identity).sort(), ['dev', 'ino']);
    assert.ok(sameFileIdentity(identity, fs.lstatSync(`${settingsPath}.ecc.lock`, { bigint: true })));
    assert.throws(() => { identity.ino = 0n; }, TypeError);
    assert.throws(() => getSettingsLockIdentity(() => {}), /identity/);
  } finally { release(); }
  assert.strictEqual(fs.existsSync(`${settingsPath}.ecc.lock`), false);
});
console.log(`Results: Passed: ${passed}, Failed: ${failed}`);
process.exitCode = failed ? 1 : 0;
