#!/usr/bin/env node
/**
 * Stop Hook: verification gate for the working tree
 *
 * Cross-platform (Windows, macOS, Linux)
 *
 * Runs the checks that cover the files changed since HEAD (validators, the
 * matching unit tests, eslint, markdownlint) and blocks the turn from ending
 * (exit 2) while any of them fail, so Claude fixes the failure instead of
 * declaring the work done. Intended for repo-local wiring in
 * .claude/settings.json, not for the distributed plugin hooks.
 *
 * Guardrails:
 * - A passing change set is fingerprinted, so unchanged trees skip re-running.
 * - After MAX_CONSECUTIVE_BLOCKS failed stops the gate warns and lets the turn
 *   end, so a check Claude cannot fix never traps the session.
 * - ECC_STOP_VERIFY_GATE=off disables it; parse and git errors fail open.
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const MAX_CONSECUTIVE_BLOCKS = 3;
const MAX_TEST_FILES = 10;
const CHECK_TIMEOUT_MS = 120000;
const OUTPUT_TAIL_LINES = 30;

const VALIDATORS = [
  { pattern: /^agents\/[^/]+\.md$/, script: 'scripts/ci/validate-agents.js' },
  { pattern: /^skills\//, script: 'scripts/ci/validate-skills.js' },
  { pattern: /^commands\/[^/]+\.md$/, script: 'scripts/ci/validate-commands.js' },
  { pattern: /^rules\//, script: 'scripts/ci/validate-rules.js' },
  { pattern: /^hooks\/hooks\.json$/, script: 'scripts/ci/validate-hooks.js' },
  { pattern: /^hooks\/hooks\.json$/, script: 'scripts/ci/check-hooks-schema-keys.js' }
];

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) return null;
  return result.stdout.split('\n').map(s => s.trim()).filter(Boolean);
}

function getChangedFiles(cwd) {
  const tracked = git(cwd, ['diff', '--name-only', 'HEAD']);
  if (tracked === null) return null;
  const untracked = git(cwd, ['ls-files', '--others', '--exclude-standard']) || [];
  return [...new Set([...tracked, ...untracked])]
    .map(f => f.replace(/\\/g, '/'))
    .filter(f => fs.existsSync(path.join(cwd, f)));
}

/** Map a scripts/** source file to its mirrored tests/** test file. */
function mirroredTest(file) {
  const match = file.match(/^scripts\/(.+)\.js$/);
  return match ? `tests/${match[1]}.test.js` : null;
}

/**
 * Decide which checks cover a change set. Pure, for testability:
 * `exists(relPath)` reports whether a repo-relative path exists.
 */
function planChecks(files, exists) {
  const checks = [];
  const seen = new Set();
  const add = (label, args) => {
    const key = args.join(' ');
    if (seen.has(key)) return;
    seen.add(key);
    checks.push({ label, args });
  };

  for (const { pattern, script } of VALIDATORS) {
    if (exists(script) && files.some(f => pattern.test(f))) add(script, [script]);
  }

  const tests = new Set();
  for (const f of files) {
    if (/^tests\/.+\.test\.js$/.test(f)) tests.add(f);
    const mirror = mirroredTest(f);
    if (mirror && exists(mirror)) tests.add(mirror);
  }
  for (const t of [...tests].slice(0, MAX_TEST_FILES)) add(t, [t]);

  const jsFiles = files.filter(f => /\.(c|m)?js$/.test(f));
  const eslintBin = 'node_modules/eslint/bin/eslint.js';
  if (jsFiles.length && exists(eslintBin)) add('eslint', [eslintBin, ...jsFiles]);

  const mdFiles = files.filter(f => /\.md$/.test(f));
  const mdlintBin = 'node_modules/markdownlint-cli/markdownlint.js';
  if (mdFiles.length && exists(mdlintBin)) add('markdownlint', [mdlintBin, ...mdFiles]);

  return checks;
}

function fingerprint(cwd, files) {
  const hash = crypto.createHash('sha256');
  for (const f of [...files].sort()) {
    const stat = fs.statSync(path.join(cwd, f));
    hash.update(`${f}:${stat.size}:${stat.mtimeMs}\n`);
  }
  return hash.digest('hex');
}

function statePath(cwd) {
  const dir = process.env.ECC_STOP_VERIFY_STATE_DIR || path.join(os.tmpdir(), 'ecc-stop-verify-gate');
  const key = crypto.createHash('sha256').update(path.resolve(cwd)).digest('hex').slice(0, 16);
  return path.join(dir, `${key}.json`);
}

function readState(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { passedFingerprint: null, consecutiveBlocks: 0 };
  }
}

function writeState(file, state) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state));
  } catch {
    // State is an optimization; losing it only means re-running checks.
  }
}

function tail(text) {
  return String(text || '').trim().split('\n').slice(-OUTPUT_TAIL_LINES).join('\n');
}

function runCheck(cwd, check) {
  const result = spawnSync(process.execPath, check.args, {
    cwd,
    encoding: 'utf8',
    timeout: CHECK_TIMEOUT_MS,
    env: { ...process.env, ECC_STOP_VERIFY_GATE: 'off' }
  });
  if (result.status === 0) return null;
  const reason = result.error ? result.error.message : `exit ${result.status}`;
  return `✗ ${check.label} (${reason})\n${tail(`${result.stdout || ''}\n${result.stderr || ''}`)}`;
}

function run(rawInput) {
  if (/^(off|0|false)$/i.test(String(process.env.ECC_STOP_VERIFY_GATE || ''))) return { exitCode: 0 };

  let input = {};
  try {
    input = rawInput ? JSON.parse(rawInput) : {};
  } catch {
    return { exitCode: 0, stderr: '[StopVerifyGate] unparseable stdin; skipping' };
  }

  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const files = getChangedFiles(cwd);
  if (!files || files.length === 0) return { exitCode: 0 };

  const checks = planChecks(files, rel => fs.existsSync(path.join(cwd, rel)));
  if (checks.length === 0) return { exitCode: 0 };

  const stateFile = statePath(cwd);
  const state = readState(stateFile);
  const print = fingerprint(cwd, files);
  if (state.passedFingerprint === print) return { exitCode: 0 };

  const failures = checks.map(check => runCheck(cwd, check)).filter(Boolean);
  if (failures.length === 0) {
    writeState(stateFile, { passedFingerprint: print, consecutiveBlocks: 0 });
    return { exitCode: 0 };
  }

  const blocks = (state.consecutiveBlocks || 0) + 1;
  if (blocks > MAX_CONSECUTIVE_BLOCKS) {
    writeState(stateFile, { passedFingerprint: null, consecutiveBlocks: 0 });
    return {
      exitCode: 0,
      stderr: `[StopVerifyGate] checks still failing after ${MAX_CONSECUTIVE_BLOCKS} attempts; letting the turn end. Report the failures to the user.`
    };
  }

  writeState(stateFile, { passedFingerprint: null, consecutiveBlocks: blocks });
  return {
    exitCode: 2,
    stderr: [
      `[StopVerifyGate] ${failures.length} of ${checks.length} check(s) failed for the changed files (attempt ${blocks}/${MAX_CONSECUTIVE_BLOCKS}).`,
      'Fix the root cause (do not suppress the check), re-run it, and show the passing output.',
      '',
      ...failures
    ].join('\n')
  };
}

module.exports = { run, planChecks, mirroredTest };
