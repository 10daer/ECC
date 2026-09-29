'use strict';
/**
 * Tests for scripts/lib/gateguard-search-evidence.js.
 *
 * Run with: node tests/lib/gateguard-search-evidence.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const hookPath = path.join(__dirname, '..', '..', 'scripts', 'hooks', 'gateguard-fact-force.js');
const { scanCurrentTurn } = require(path.join(__dirname, '..', '..', 'scripts', 'lib', 'gateguard-turn-scan.js'));

console.log('=== Testing gateguard-search-evidence.js ===\n');

let passed = 0;
let failed = 0;

function test(desc, fn) {
  try {
    fn();
    console.log(`  ✓ ${desc}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${desc}: ${e.message}`);
    failed++;
  }
}

function loadHook() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateguard-search-evidence-state-'));
  const savedStateDir = process.env.GATEGUARD_STATE_DIR;
  process.env.GATEGUARD_STATE_DIR = stateDir;
  try {
    return require(hookPath);
  } finally {
    if (savedStateDir === undefined) delete process.env.GATEGUARD_STATE_DIR;
    else process.env.GATEGUARD_STATE_DIR = savedStateDir;
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
}

const root = '/proj-search';
const transcriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateguard-search-evidence-'));
let seq = 0;
let uuidSeq = 0;
const nextUuid = () => `uuid-${++uuidSeq}`;
const human = text => ({ type: 'user', uuid: nextUuid(), message: { role: 'user', content: text } });
const toolUse = (id, name, input) => ({
  type: 'assistant',
  uuid: nextUuid(),
  message: { id: `msg_${id}`, role: 'assistant', content: [{ type: 'tool_use', id, name, input }] }
});
const toolResult = id => ({
  type: 'user',
  uuid: nextUuid(),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: false, content: 'ok' }] }
});
const search = (id, name, input) => [toolUse(id, name, input), toolResult(id)];
const writeTranscript = records => {
  seq += 1;
  const file = path.join(transcriptDir, `t-${seq}.jsonl`);
  fs.writeFileSync(file, records.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  return file;
};

test('credits by Glob literal-prefix directory and stem, folding case only for Windows paths', () => {
  const { findCreditingSearch } = loadHook();
  const boundary = human('go');
  const t = writeTranscript([human('old'), boundary, ...search('toolu_u1', 'Glob', { pattern: '**/*.md' }), toolUse('toolu_u2', 'Grep', { pattern: 'pending' })]);
  const scan = scanCurrentTurn(t);
  assert.strictEqual(scan.turnId, boundary.uuid, 'turnId is the boundary uuid');
  assert.deepStrictEqual(scan.searches.map(s => [s.name, s.callsAgo]), [['Glob', 2]]);
  assert.strictEqual(scanCurrentTurn(path.join(transcriptDir, 'missing.jsonl')), null);
  const data = { cwd: root };
  assert.strictEqual(findCreditingSearch(scan, `${root}/new-notes.md`, true, data), null, 'Glob **/*.md gives no dir credit');
  const docsScan = scanCurrentTurn(
    writeTranscript([human('go'), ...search('toolu_u3', 'Glob', { pattern: 'docs/*.md' }), toolUse('toolu_u4', 'Grep', { pattern: 'x' })])
  );
  assert.ok(findCreditingSearch(docsScan, `${root}/docs/new-notes.md`, true, data), 'Glob literal prefix names the dir');
  assert.strictEqual(findCreditingSearch(docsScan, `${root}/docs/sub/new-notes.md`, true, data), null, 'not a subdirectory');
  assert.strictEqual(findCreditingSearch(scan, `${root}/new-notes.md`, false, data), null, 'Edit needs a stem match');
  assert.strictEqual(findCreditingSearch(null, `${root}/x.md`, true, data), null);
  const winScan = { turnId: null, searches: [{ name: 'LS', input: { path: 'C:\\Proj\\Src' }, callsAgo: 1, messageId: 'msg_w' }] };
  assert.ok(findCreditingSearch(winScan, 'c:/proj/src/new_file.js', true, { cwd: 'C:\\proj' }), 'win32 dir match folds case');
  const posixScan = { turnId: null, searches: [{ name: 'LS', input: { path: '/Proj/Src' }, callsAgo: 1, messageId: 'msg_p' }] };
  assert.strictEqual(findCreditingSearch(posixScan, '/proj/src/new_file.js', true, { cwd: '/proj' }), null, 'posix is case-sensitive');
});

test('findClosestMiss reports a reason code for the nearest non-qualifying search', () => {
  const { findClosestMiss } = loadHook();
  const data = { cwd: root };
  const target = `${root}/src/widget_factory.py`;
  const scanOf = (searches, extra = {}) => ({ turnId: null, searches, batchIds: new Map(), newestMessageId: null, shellCommands: [], reads: [], ...extra });
  const s = (name, input, messageId = 'msg_1') => ({ name, input, callsAgo: 1, messageId });
  const reason = (scan, allowDir = false, file = target) => (findClosestMiss(scan, file, allowDir, data) || {}).reason || null;
  assert.strictEqual(reason(scanOf([s('Grep', { pattern: 'widget_factory', path: `${root}/docs` })])), 'out-of-scope');
  assert.strictEqual(reason(scanOf([s('Grep', { pattern: 'widget_factory', glob: '!*.py' })])), 'excluded');
  assert.strictEqual(reason(scanOf([s('Grep', { pattern: 'widget_factory', glob: '*.md' })])), 'excluded', 'include globs that miss');
  assert.strictEqual(reason(scanOf([s('Grep', { pattern: 'widget_factory' }, 'msg_b')], { newestMessageId: 'msg_b' })), 'same-batch');
  assert.strictEqual(reason(scanOf([s('Bash', { command: 'git diff | grep widget_factory' })])), 'stdin-only');
  assert.strictEqual(reason(scanOf([s('Bash', { command: 'cat src/widget_factory.py' })])), 'not-a-search');
  assert.strictEqual(reason(scanOf([], { reads: [{ name: 'Read', path: 'src/widget_factory.py', callsAgo: 1 }] })), 'not-a-search');
  assert.strictEqual(reason(scanOf([s('Grep', { pattern: 'index' })]), false, `${root}/src/index.py`), 'generic-stem');
  assert.strictEqual(reason(scanOf([s('Grep', { pattern: 'unrelated' })])), null);
  assert.strictEqual(reason(scanOf([s('Grep', { pattern: 'widget_factory' })])), null, 'a crediting search is not a miss');
  assert.strictEqual(reason(scanOf([s('LS', { path: `${root}/src` })]), true, `${root}/src/brand_new.py`), null, 'dir credit is not a miss');
  assert.strictEqual(
    reason(scanOf([s('Grep', { pattern: 'widget_factory', path: `${root}/docs` }), s('Grep', { pattern: 'widget_factory', glob: '!*.py' })])),
    'excluded',
    'excluded outranks out-of-scope'
  );
  const miss = findClosestMiss(scanOf([s('Grep', { pattern: 'widget_factory', path: `${root}/docs` })]), target, false, data);
  assert.deepStrictEqual(Object.keys(miss).sort(), ['detail', 'name', 'reason']);
  for (const bad of [null, {}, { searches: 'x' }, scanOf([null, { name: 'Grep' }]), scanOf([], { reads: [null, { path: 5 }] })]) {
    assert.strictEqual(findClosestMiss(bad, target, false, data), null);
  }
  assert.strictEqual(findClosestMiss(scanOf([s('Grep', { pattern: 'widget_factory', path: '/elsewhere' })]), '', false, data), null);
});

fs.rmSync(transcriptDir, { recursive: true, force: true });

console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
