const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');

const source = fs.readFileSync(path.join(__dirname, '../../scripts/hooks/check-console-log.js'), 'utf8');
const filename = '普通\n[Hook] WARNING: console.log found in missing.ts\x1b[2J\t\x85\u2028\u2029.ts';
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
      getGitModifiedFiles: () => ['ordinary.ts', filename],
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

assert.deepStrictEqual(filesChecked, ['ordinary.ts', filename]);
assert.deepStrictEqual(filesRead, ['ordinary.ts', filename]);
assert.strictEqual(warnings.length, 3);
assert.strictEqual(warnings[0], '[Hook] WARNING: console.log found in ordinary.ts');
assert.ok(warnings[1].includes('普通\\u000a'));
assert.ok(warnings[1].includes('missing.ts\\u001b[2J\\u0009\\u0085\\u2028\\u2029.ts'));
// eslint-disable-next-line no-control-regex
assert.ok(!/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(warnings[1]));
assert.strictEqual(output, payload);
assert.strictEqual(exitCode, 0);
console.log('Passed: 1\nFailed: 0');
