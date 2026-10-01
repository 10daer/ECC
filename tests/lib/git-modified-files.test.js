const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const utilsPath = require.resolve('../../scripts/lib/utils');

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-git-filenames-'));
const hook = path.resolve(__dirname, '../../scripts/hooks/check-console-log.js');
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX'].includes(key)
));

function git(...args) {
  const result = spawnSync('git', args, { cwd: fixture, env, encoding: 'utf8' });
  assert.strictEqual(result.status, 0, result.stderr);
}

function modifiedFiles(patterns = []) {
  const result = spawnSync(process.execPath, ['-e',
    'process.stdout.write(JSON.stringify(require(process.argv[1]).getGitModifiedFiles(JSON.parse(process.argv[2]))))',
    utilsPath, JSON.stringify(patterns)
  ], { cwd: fixture, env, encoding: 'utf8' });
  assert.strictEqual(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed++;
    console.error(`  ✗ ${name}: ${error.message}`);
  }
}

try {
  git('init');
  git('config', 'core.quotePath', 'true');
  const names = ['普通.js', ' leading.js', 'with space.tsx', 'ordinary.jsx', 'notes.md'];
  for (const name of names) fs.writeFileSync(path.join(fixture, name), 'const value = 1;\n');
  git('add', '--all');
  git('-c', 'user.name=Filename Test', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture');
  for (const name of names) fs.appendFileSync(path.join(fixture, name), 'console.log(value);\n');

  test('preserves exact Unicode and whitespace paths from real Git output', () => {
    assert.deepStrictEqual(modifiedFiles().sort(), [...names].sort());
  });
  test('filters extensions after decoding paths', () => {
    assert.deepStrictEqual(modifiedFiles(['\\.tsx?$', '\\.jsx?$']).sort(),
      names.filter(name => name !== 'notes.md').sort());
  });
  test('console-log hook warns for Unicode paths and preserves stdin', () => {
    const payload = '{"stop_hook_active":false}\n';
    const result = spawnSync(process.execPath, [hook], {
      cwd: fixture, env, input: payload, encoding: 'utf8'
    });
    assert.strictEqual(result.status, 0, result.stderr);
    assert.strictEqual(result.stdout, payload);
    for (const name of names.filter(name => name !== 'notes.md')) {
      assert.ok(result.stderr.includes(`console.log found in ${name}`), result.stderr);
    }
    assert.ok(!result.stderr.includes('console.log found in notes.md'));
  });
} finally {
  fs.rmSync(fixture, { recursive: true, force: true });
}

console.log(`Passed: ${passed}\nFailed: ${failed}`);
process.exitCode = failed > 0 ? 1 : 0;
