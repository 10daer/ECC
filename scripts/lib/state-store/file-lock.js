'use strict';

const fs = require('fs');
const os = require('os');
const { performance } = require('perf_hooks');

const WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));
const DEFAULT_TIMEOUT_MS = 5000;

function sameIdentity(left, right) {
  return left.ino === right.ino
    && (left.dev === right.dev || (process.platform === 'win32' && (!left.dev || !right.dev)));
}

function releaseOwnedLock(lockPath, descriptor, identity) {
  let current;
  try {
    current = fs.lstatSync(lockPath, { bigint: true });
  } finally {
    fs.closeSync(descriptor);
  }
  if (!current.isFile() || current.isSymbolicLink() || !sameIdentity(identity, current)) {
    throw new Error(`State-store lock changed; refusing to remove it: ${lockPath}`);
  }
  fs.unlinkSync(lockPath);
}

function acquireLock(dbPath, timeoutMs) {
  const lockPath = `${dbPath}.ecc-state.lock`;
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    let descriptor;
    try {
      descriptor = fs.openSync(lockPath, 'wx', 0o600);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const remaining = deadline - performance.now();
      if (remaining <= 0) {
        const busy = new Error(`State store is busy: ${dbPath}. Retry after the other ECC operation finishes. `
          + `If an operation terminated unexpectedly, stop all ECC processes using this database, `
          + `then inspect and remove the leftover lock: ${lockPath}`);
        busy.code = 'STATE_STORE_BUSY';
        throw busy;
      }
      Atomics.wait(WAIT_BUFFER, 0, 0, Math.min(20, remaining));
      continue;
    }
    let identity;
    try {
      identity = fs.fstatSync(descriptor, { bigint: true });
      fs.writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid, hostname: os.hostname() })}\n`);
    } catch (error) {
      try {
        if (identity) releaseOwnedLock(lockPath, descriptor, identity);
        else fs.closeSync(descriptor);
      } catch (releaseError) {
        error.releaseError = releaseError;
      }
      throw error;
    }
    return () => releaseOwnedLock(lockPath, descriptor, identity);
  }
}

/** Serialize one synchronous snapshot operation, never a handle's lifetime.
 * Locks are not expired or stolen: a paused writer must not lose exclusivity.
 * An abnormal process exit can leave a lock requiring the explicit recovery
 * described by STATE_STORE_BUSY. No database bytes are changed on timeout. */
function withStateStoreLock(dbPath, callback, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const release = acquireLock(dbPath, timeoutMs);
  let result;
  let primaryError;
  let failed = false;
  try {
    result = callback();
  } catch (error) {
    failed = true;
    primaryError = error;
  }
  try {
    release();
  } catch (releaseError) {
    if (!failed) throw releaseError;
    if (primaryError instanceof Error) primaryError.releaseError = releaseError;
  }
  if (failed) throw primaryError;
  return result;
}

module.exports = { withStateStoreLock };
