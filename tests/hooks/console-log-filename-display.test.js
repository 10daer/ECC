const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');

const source = fs.readFileSync(path.join(__dirname, '../../scripts/hooks/check-console-log.js'), 'utf8');
const filename = '普通\n[Hook] WARNING: console.log found in missing.ts\x1b[2J\t\x85\u2028\u2029.ts';
const newlinePath = 'different\n.ts';
const literalPath = 'different\\u000a.ts';
const modifiedPaths = ['ordinary.ts', filename, newlinePath, literalPath];
const payload = '{"stop_hook_active":false}\n';
const filesRead = [];
const filesChecked = [];
const warnings = [];
const stdin = new EventEmitter();
stdin.setEncoding = () => {};
let output = '';
let exitCode = null;

// Windows disallows control characters in filenames. Exercise the hook's
// display boundary with exact paths supplied by the Git utility instead.
vm.runInNewContext(source, {
  Buffer,
  require(name) {
    if (name === 'fs') return { existsSync(file) { filesChecked.push(file); return true; } };
    if (name === '../lib/utils') return {
      isGitRepo: () => true,
      getGitModifiedFiles: () => modifiedPaths,
      readFile(file) { filesRead.push(file); return 'console.log(value);'; },
      log: message => warnings.push(message),
    };
    throw new Error(`Unexpected import: ${name}`);
  },
  process: {
    stdin,
    stdout: { write(value, callback) { output += value; callback(); } },
    exit(code) { exitCode = code; },
  },
});
stdin.emit('data', payload);
stdin.emit('end');

assert.deepStrictEqual(filesChecked, modifiedPaths);
assert.deepStrictEqual(filesRead, modifiedPaths);
assert.strictEqual(warnings.length, 5);
assert.strictEqual(warnings[0], '[Hook] WARNING: console.log found in ordinary.ts');
assert.ok(warnings[1].includes('普通\\u000a'));
assert.ok(warnings[1].includes('missing.ts\\u001b[2J\\u0009\\u0085\\u2028\\u2029.ts'));
// eslint-disable-next-line no-control-regex
assert.ok(!/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(warnings[1]));
assert.notStrictEqual(warnings[2], warnings[3], 'newline and literal escape filenames must remain distinct');
assert.strictEqual(warnings[2], '[Hook] WARNING: console.log found in different\\u000a.ts');
assert.strictEqual(warnings[3], '[Hook] WARNING: console.log found in different\\\\u000a.ts');
assert.strictEqual(output, payload);
assert.strictEqual(exitCode, 0);
console.log('Passed: 1\nFailed: 0');
