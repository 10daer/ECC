#!/usr/bin/env node
'use strict';

/**
 * Tests for scripts/lib/instinct-store.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const storePath = path.join(__dirname, '..', '..', 'scripts', 'lib', 'instinct-store.js');
const sessionStartPath = path.join(__dirname, '..', '..', 'scripts', 'hooks', 'session-start.js');

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    return true;
  } catch (error) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${error.message}`);
    return false;
  }
}

function loadStore() {
  delete require.cache[require.resolve(storePath)];
  return require(storePath);
}

function withEnv(env, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(env)) {
    previous[key] = Object.prototype.hasOwnProperty.call(process.env, key)
      ? process.env[key]
      : undefined;
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function writeInstinct(filePath, instinct) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const confidence = Object.prototype.hasOwnProperty.call(instinct, 'confidence')
    ? `confidence: ${instinct.confidence}\n`
    : '';
  const trigger = instinct.trigger ? `trigger: ${instinct.trigger}\n` : '';
  const domain = instinct.domain ? `domain: ${instinct.domain}\n` : '';
  fs.writeFileSync(
    filePath,
    `---\nid: ${instinct.id}\n${trigger}${confidence}${domain}---\n${instinct.content || ''}\n`
  );
}

function runTests() {
  console.log('\n=== Testing instinct-store ===\n');

  let passed = 0;
  let failed = 0;

  if (test('session-start requires instinct-store and does not keep a local parseInstinctFile', () => {
    const source = fs.readFileSync(sessionStartPath, 'utf8');
    assert.ok(source.includes("require('../lib/instinct-store')"), 'session-start.js should require instinct-store');
    assert.ok(!/function parseInstinctFile\(/.test(source), 'parseInstinctFile should live only in instinct-store.js');
    assert.ok(!/function getInstinctConfidenceThreshold\(/.test(source), 'getInstinctConfidenceThreshold should live only in instinct-store.js');
    assert.ok(!/function readInstinctsFromDir\(/.test(source), 'readInstinctsFromDir should live only in instinct-store.js');
  })) passed++; else failed++;

  if (test('parses a SessionStart-accepted fixture with id, confidence, and trigger', () => {
    const { parseInstinctFile } = loadStore();
    const parsed = parseInstinctFile(
      '---\nid: max-instinct-1\nconfidence: 0.9\ntrigger: when changing tests\n---\n## Action\nDo configurable thing number 1.\n'
    );
    assert.strictEqual(parsed.length, 1);
    assert.strictEqual(parsed[0].id, 'max-instinct-1');
    assert.strictEqual(parsed[0].confidence, 0.9);
    assert.strictEqual(parsed[0].trigger, 'when changing tests');
    assert.ok(parsed[0].content.includes('Do configurable thing number 1.'));
  })) passed++; else failed++;

  if (test('strips quoted values and defaults missing confidence to 0.5', () => {
    const { parseInstinctFile } = loadStore();
    const quoted = parseInstinctFile(
      '---\nid: "quoted-id"\ntrigger: "when writing new functions"\nconfidence: "0.91"\ndomain: \'code-style\'\n---\nbody\n'
    );
    assert.strictEqual(quoted[0].id, 'quoted-id');
    assert.strictEqual(quoted[0].trigger, 'when writing new functions');
    assert.strictEqual(quoted[0].confidence, 0.91);
    assert.strictEqual(quoted[0].domain, 'code-style');

    const missing = parseInstinctFile('---\nid: no-confidence\ntrigger: when editing\n---\nKeep going.\n');
    assert.strictEqual(missing[0].confidence, 0.5);

    const invalid = parseInstinctFile('---\nid: bad-confidence\nconfidence: not-a-number\n---\nKeep going.\n');
    assert.strictEqual(invalid[0].confidence, 0.5);
  })) passed++; else failed++;

  if (test('loadInstincts lets project instincts override global ids', () => {
    const homunculusDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-instinct-store-'));
    try {
      writeInstinct(path.join(homunculusDir, 'instincts', 'personal', 'shared.yaml'), {
        id: 'shared-rule',
        confidence: 0.8,
        trigger: '"global trigger"',
        content: 'NEVER globalToken in payloads',
      });
      writeInstinct(path.join(homunculusDir, 'projects', 'abc123', 'instincts', 'personal', 'shared.yaml'), {
        id: 'shared-rule',
        confidence: 0.95,
        trigger: '"project trigger"',
        content: 'NEVER projectToken in payloads',
      });

      withEnv({ CLV2_HOMUNCULUS_DIR: homunculusDir }, () => {
        const { loadInstincts } = loadStore();
        const loaded = loadInstincts({
          isGlobal: false,
          projectDir: path.join(homunculusDir, 'projects', 'abc123'),
        });
        assert.strictEqual(loaded.global.length, 1);
        assert.strictEqual(loaded.project.length, 1);
        assert.strictEqual(loaded.merged.length, 1);
        assert.strictEqual(loaded.merged[0].confidence, 0.95);
        assert.strictEqual(loaded.merged[0]._scopeLabel, 'project');
        assert.ok(loaded.merged[0].content.includes('projectToken'));
      });
    } finally {
      fs.rmSync(homunculusDir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (test('matchInstincts hits NEVER tokens, quoted identifiers, and domain path tokens', () => {
    const { matchInstincts } = loadStore();
    const neverInstinct = {
      id: 'no-foo-prefix',
      confidence: 0.91,
      trigger: 'when naming new modules',
      content: 'NEVER foo prefix on new modules',
    };
    const quotedInstinct = {
      id: 'no-widget-name',
      confidence: 0.8,
      trigger: 'when writing `"fooWidget"` helpers',
      content: 'Avoid the forbidden helper name.',
    };
    const domainInstinct = {
      id: 'code-style-domain',
      confidence: 0.88,
      domain: 'code-style',
      trigger: 'when editing style files',
      content: 'Keep the house style.',
    };

    const neverHits = matchInstincts([neverInstinct], {
      file_path: '/src/fooWidget.js',
      contents: 'export function fooWidget() {}',
    });
    assert.strictEqual(neverHits.length, 1);
    assert.strictEqual(neverHits[0].id, 'no-foo-prefix');

    const quotedHits = matchInstincts([quotedInstinct], {
      file_path: '/src/helpers.js',
      new_string: 'function fooWidget() { return 1; }',
    });
    assert.strictEqual(quotedHits[0].id, 'no-widget-name');

    const domainHits = matchInstincts([domainInstinct], {
      file_path: '/src/code-style/button.css',
      contents: '.button {}',
    });
    assert.strictEqual(domainHits[0].id, 'code-style-domain');

    const misses = matchInstincts([neverInstinct, quotedInstinct, domainInstinct], {
      file_path: '/src/unrelated.js',
      command: 'rm -rf /tmp/scratch',
      contents: 'export const ok = true;\n',
    }, { minConfidence: 0.7, limit: 3 });
    assert.deepStrictEqual(misses, []);
  })) passed++; else failed++;

  if (test('getInstinctConfidenceThreshold rejects hex and exponent overrides', () => {
    withEnv({ ECC_INSTINCT_CONFIDENCE_THRESHOLD: undefined }, () => {
      const { getInstinctConfidenceThreshold, DEFAULT_INSTINCT_CONFIDENCE_THRESHOLD } = loadStore();
      assert.strictEqual(getInstinctConfidenceThreshold(), DEFAULT_INSTINCT_CONFIDENCE_THRESHOLD);
    });
    withEnv({ ECC_INSTINCT_CONFIDENCE_THRESHOLD: '0.5' }, () => {
      const { getInstinctConfidenceThreshold } = loadStore();
      assert.strictEqual(getInstinctConfidenceThreshold(), 0.5);
    });
    withEnv({ ECC_INSTINCT_CONFIDENCE_THRESHOLD: '0x1' }, () => {
      const { getInstinctConfidenceThreshold, DEFAULT_INSTINCT_CONFIDENCE_THRESHOLD } = loadStore();
      assert.strictEqual(getInstinctConfidenceThreshold(), DEFAULT_INSTINCT_CONFIDENCE_THRESHOLD);
    });
    withEnv({ ECC_INSTINCT_CONFIDENCE_THRESHOLD: '1e2' }, () => {
      const { getInstinctConfidenceThreshold, DEFAULT_INSTINCT_CONFIDENCE_THRESHOLD } = loadStore();
      assert.strictEqual(getInstinctConfidenceThreshold(), DEFAULT_INSTINCT_CONFIDENCE_THRESHOLD);
    });
  })) passed++; else failed++;

  console.log(`\nPassed: ${passed}`);
  console.log(`Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
