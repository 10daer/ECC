'use strict';
/**
 * Tests for scripts/lib/gateguard-change-profile.js.
 *
 * Run with: node tests/lib/gateguard-change-profile.test.js
 */

const assert = require('assert');
const path = require('path');

const { profileChange, languageFor, UNKNOWN_PROFILE, MAX_SIDE_BYTES } = require(
  path.join(__dirname, '..', '..', 'scripts', 'lib', 'gateguard-change-profile.js')
);

console.log('=== Testing gateguard-change-profile.js ===\n');

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

const edit = (filePath, oldString, newString) => profileChange({ filePath, tool: 'Edit', edits: [{ old_string: oldString, new_string: newString }] });
const write = (filePath, content) => profileChange({ filePath, tool: 'Write', content });
const surface = (filePath, oldString, newString) => edit(filePath, oldString, newString).touchesPublicSurface;
const data = (filePath, oldString, newString) => edit(filePath, oldString, newString).touchesData;
const trivial = (filePath, oldString, newString) => edit(filePath, oldString, newString).trivial;

// ── languages and bounds ──
console.log('languages and bounds:');

test('supported extensions map to a language; others do not', () => {
  const expected = {
    'a.js': 'js', 'a.mjs': 'js', 'a.cjs': 'js', 'a.jsx': 'js', 'a.ts': 'js', 'a.tsx': 'js', 'a.mts': 'js', 'a.cts': 'js',
    'a.py': 'python', 'a.pyi': 'python', 'a.go': 'go', 'a.rs': 'rust', 'a.java': 'java', 'a.kt': 'kotlin', 'a.kts': 'kotlin',
    'a.cs': 'csharp', 'a.c': 'c', 'a.h': 'c', 'a.cc': 'cpp', 'a.cpp': 'cpp', 'a.cxx': 'cpp', 'a.hpp': 'cpp', 'a.hh': 'cpp',
    'SRC\\A.PY': 'python'
  };
  for (const [file, lang] of Object.entries(expected)) assert.strictEqual(languageFor(file), lang, file);
  for (const file of ['a.rb', 'a.sh', 'Makefile', 'a.mk', 'a.yaml', 'a.md', 'a', 'a.swift', '', null]) {
    assert.strictEqual(languageFor(file), null, String(file));
  }
});

test('unknown language, bad shapes, and over-bound input give the unknown profile', () => {
  const big = 'x'.repeat(MAX_SIDE_BYTES + 1);
  const cases = [
    edit('a.rb', '# a', '# b'),
    edit('Makefile', '# a', '# b'),
    profileChange({ filePath: 'a.js', tool: 'Edit', edits: [] }),
    profileChange({ filePath: 'a.js', tool: 'Edit', edits: [{ old_string: 1, new_string: 'x' }] }),
    profileChange({ filePath: 'a.js', tool: 'Edit', edits: 'nope' }),
    profileChange({ filePath: 'a.js', tool: 'Write', content: 42 }),
    profileChange({ filePath: 'a.js', tool: 'Read', content: 'x' }),
    profileChange(null),
    profileChange({ filePath: 'a.js', tool: 'Edit', edits: Array.from({ length: 65 }, () => ({ old_string: 'a', new_string: 'b' })) }),
    edit('a.js', big, '// x'),
    edit('a.js', '// x', big),
    write('a.js', big),
    edit('a.js', 'é'.repeat(MAX_SIDE_BYTES / 2 + 1), 'x')
  ];
  for (const [index, profile] of cases.entries()) {
    assert.deepStrictEqual(profile, UNKNOWN_PROFILE, `case ${index}`);
  }
  assert.deepStrictEqual(UNKNOWN_PROFILE, { known: false, language: null, touchesPublicSurface: true, touchesData: true, trivial: false });
  assert.ok(Object.isFrozen(UNKNOWN_PROFILE));
});

test('a combined MultiEdit over the total bound is unknown', () => {
  const chunk = 'y'.repeat(MAX_SIDE_BYTES - 16);
  const edits = Array.from({ length: 5 }, () => ({ old_string: chunk, new_string: chunk }));
  assert.deepStrictEqual(profileChange({ filePath: 'a.js', tool: 'Edit', edits }), UNKNOWN_PROFILE);
});

// ── public surface ──
console.log('\npublic surface:');

test('JS/TS: export, module.exports, exports., and public members touch the surface', () => {
  assert.strictEqual(surface('a.js', 'export function f(a) {', 'export function f(a, b) {'), true);
  assert.strictEqual(surface('a.ts', 'const x = 1;', 'export const x = 1;'), true);
  assert.strictEqual(surface('a.js', 'module.exports = { a };', 'module.exports = { a, b };'), true);
  assert.strictEqual(surface('a.js', 'exports.a = a;', 'exports.a = b;'), true);
  assert.strictEqual(surface('a.ts', '  public run(): void {', '  public run(x: number): void {'), true);
  assert.strictEqual(surface('a.ts', 'export default class A {}', 'export default class B {}'), true);
  assert.strictEqual(surface('types.d.ts', 'type A = string;', 'type A = number;'), true, 'declaration files are all surface');
});

test('JS/TS: body-only changes and look-alike words do not touch the surface', () => {
  assert.strictEqual(surface('a.js', '  return a + 1;', '  return a + 2;'), false);
  assert.strictEqual(surface('a.js', 'const exported = 1;', 'const exported = 2;'), false);
  assert.strictEqual(surface('a.js', 'function exporter() {}', 'function exporter(a) {}'), false);
  assert.strictEqual(surface('a.js', 'const publicKey = k;', 'const publicKey = j;'), false);
});

test('Python: public def/class, dunders, __all__ and __init__.py touch the surface', () => {
  assert.strictEqual(surface('a.py', 'def load(path):', 'def load(path, strict):'), true);
  assert.strictEqual(surface('a.py', '    async def fetch(self):', '    async def fetch(self, x):'), true);
  assert.strictEqual(surface('a.py', 'class Loader:', 'class Loader(Base):'), true);
  assert.strictEqual(surface('a.py', '    def __init__(self):', '    def __init__(self, x):'), true);
  assert.strictEqual(surface('a.py', "__all__ = ['a']", "__all__ = ['a', 'b']"), true);
  assert.strictEqual(surface('pkg/__init__.py', 'x = 1', 'x = 2'), true, '__init__.py is all surface');
  assert.strictEqual(surface('a.py', 'x = 1\nLIMIT = 3', 'x = 1\nLIMIT = 4'), true, 'module-level public name');
});

test('Python: private definitions and bodies do not touch the surface', () => {
  assert.strictEqual(surface('a.py', 'def _helper(a):', 'def _helper(a, b):'), false);
  assert.strictEqual(surface('a.py', '    return a + 1', '    return a + 2'), false);
  assert.strictEqual(surface('a.py', '    x = 1', '    x = 2'), false, 'indented assignment');
  assert.strictEqual(surface('a.py', 'x = 1\n_limit = 3', 'x = 1\n_limit = 4'), false, 'module-level private name');
});

test('Go: capitalised declarations touch the surface; lowercase ones do not', () => {
  assert.strictEqual(surface('a.go', 'func Load(p string) error {', 'func Load(p string, s bool) error {'), true);
  assert.strictEqual(surface('a.go', 'func (s *Store) Get(k string) {', 'func (s *Store) Get(k int) {'), true);
  assert.strictEqual(surface('a.go', 'type Config struct {', 'type Config struct { // x'), true);
  assert.strictEqual(surface('a.go', '\tName string', '\tName int'), true, 'exported field');
  assert.strictEqual(surface('a.go', 'func load(p string) {', 'func load(p int) {'), false);
  assert.strictEqual(surface('a.go', 'func (s *store) get() {', 'func (s *store) get(k int) {'), false);
  assert.strictEqual(surface('a.go', '\treturn x + 1', '\treturn x + 2'), false);
});

test('Rust: pub items, impl/trait blocks and macro exports touch the surface', () => {
  assert.strictEqual(surface('a.rs', 'pub fn load() {', 'pub fn load(x: u8) {'), true);
  assert.strictEqual(surface('a.rs', 'pub(crate) fn load() {', 'pub(crate) fn load(x: u8) {'), true);
  assert.strictEqual(surface('a.rs', 'impl Display for A {', 'impl Debug for A {'), true);
  assert.strictEqual(surface('a.rs', '#[macro_export]\nmacro_rules! m {', '#[macro_export]\nmacro_rules! n {'), true);
  assert.strictEqual(surface('a.rs', 'fn load() {', 'fn load(x: u8) {'), false);
  assert.strictEqual(surface('a.rs', '    x + 1', '    x + 2'), false);
  assert.strictEqual(surface('a.rs', 'let publish = 1;', 'let publish = 2;'), false);
});

test('Java, Kotlin, C#, C and C++ always count as touching the surface', () => {
  for (const file of ['a.java', 'a.kt', 'a.cs', 'a.c', 'a.cpp']) {
    const profile = edit(file, 'x = 1;', 'x = 2;');
    assert.strictEqual(profile.known, true, file);
    assert.strictEqual(profile.touchesPublicSurface, true, file);
  }
});

test('Write always touches the surface', () => {
  const profile = write('a.js', 'const x = 1;\n');
  assert.strictEqual(profile.known, true);
  assert.strictEqual(profile.touchesPublicSurface, true);
  assert.strictEqual(profile.trivial, false);
});

// ── data ──
console.log('\ndata:');

test('file I/O, serialisation, SQL, schema and date handling touch data', () => {
  const hits = [
    ['a.js', 'const cfg = JSON.parse(raw);'],
    ['a.js', "const text = fs.readFileSync(p, 'utf8');"],
    ['a.ts', 'await writeFile(out, body);'],
    ['a.py', "with open(path) as fh:"],
    ['a.py', 'rows = csv.reader(fh)'],
    ['a.py', 'doc = yaml.safe_load(fh)'],
    ['a.py', "stamp = datetime.now().strftime('%Y')"],
    ['a.js', 'const when = new Date(ts).toISOString();'],
    ['a.go', 'err := json.Unmarshal(b, &v)'],
    ['a.go', 'f, err := os.Open(p)'],
    ['a.rs', 'let s = std::fs::read_to_string(p)?;'],
    ['a.rs', 'let v: T = serde_json::from_str(&s)?;'],
    ['a.java', 'rs = stmt.executeQuery("select id from users");'],
    ['a.py', 'cur.execute("INSERT INTO t VALUES (1)")'],
    ['a.ts', 'const schema = z.object({});'],
    ['a.py', 'df = pd.read_parquet(p)'],
    ['a.cs', 'var created = DateTime.UtcNow;'],
    ['a.kt', 'val ts = Instant.now().toEpochMilli() // timestamp']
  ];
  for (const [file, text] of hits) {
    assert.strictEqual(edit(file, 'x = 1', `${text}\n`).touchesData, true, `${file}: ${text}`);
  }
});

test('ordinary logic and look-alike words do not touch data', () => {
  const misses = [
    ['a.js', 'return a + b;'],
    ['a.js', 'const updated = validate(candidate);'],
    ['a.py', 'total = sum(values) / count'],
    ['a.go', 'if n > limit { return errTooMany }'],
    ['a.rs', 'let reopened = retry(opener);'],
    ['a.js', 'button.opened = true;']
  ];
  for (const [file, text] of misses) {
    assert.strictEqual(data(file, 'x = 1', text), false, `${file}: ${text}`);
  }
});

test('data is judged on both sides of an Edit and on Write content', () => {
  assert.strictEqual(data('a.js', 'JSON.parse(x)', 'parse(x)'), true, 'removed data handling still counts');
  assert.strictEqual(write('a.py', 'import json\n').touchesData, true);
  assert.strictEqual(write('a.py', 'def f():\n    return 1\n').touchesData, false);
});

// ── trivial ──
console.log('\ntrivial:');

test('comment-only and whitespace-only edits are trivial in every supported language', () => {
  const cases = [
    ['a.js', '// old note\nfoo();', '// new note\nfoo();'],
    ['a.js', 'foo(); // old', 'foo(); // new'],
    ['a.js', '/* a\n * b\n */\nfoo();', '/* a\n * c\n */\nfoo();'],
    ['a.js', 'if (x) {\n  foo();\n}', 'if (x) {\n    foo();\n}'],
    ['a.js', 'foo(a,  b);', 'foo(a, b);   '],
    ['a.js', 'foo();\n\nbar();', 'foo();\nbar();'],
    ['a.js', 'foo();', '// added\nfoo();'],
    ['a.ts', "const s = 'x'; // why", "const s = 'x'; // because"],
    ['a.py', '# old\nx = 1', '# new\nx = 1'],
    ['a.py', 'x = 1  # old', 'x = 1  # new'],
    ['a.py', "s = 'a#b'  # old", "s = 'a#b'  # new"],
    ['a.go', '\t// Load loads.\n\treturn nil', '\t// Load reads.\n\treturn nil'],
    ['a.rs', "fn f<'a>(x: &'a str) {} // old", "fn f<'a>(x: &'a str) {} // new"],
    ['a.rs', "let c = '\"'; // old", "let c = '\"'; // new"],
    ['a.java', 'int x = 1; // old', 'int x = 1; // new'],
    ['a.kt', 'val x = "a" // old', 'val x = "a" // new'],
    ['a.cs', 'var x = "a"; // old', 'var x = "a"; // new'],
    ['a.c', '#include <stdio.h>\n/* old */', '#include <stdio.h>\n/* new */'],
    ['a.cpp', "char c = 'x'; // old", "char c = 'x'; // new"]
  ];
  for (const [file, before, after] of cases) {
    assert.strictEqual(trivial(file, before, after), true, `${file}: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
  }
});

test('a comment change that also edits code is not trivial', () => {
  assert.strictEqual(trivial('a.js', '// old\nfoo(1);', '// new\nfoo(2);'), false);
  assert.strictEqual(trivial('a.py', 'x = 1  # old', 'x = 2  # new'), false);
  assert.strictEqual(trivial('a.js', 'foo();', 'foo();\nbar();'), false);
  assert.strictEqual(trivial('a.js', 'foo(); bar();', 'foo();\nbar();'), false, 'line structure is code');
});

test('whitespace inside strings and between tokens is code', () => {
  assert.strictEqual(trivial('a.js', "s = 'a b';", "s = 'a  b';"), false);
  assert.strictEqual(trivial('a.js', 'x = a+b;', 'x = a + b;'), false);
  assert.strictEqual(trivial('a.py', 'x = f"a"', 'x = f "a"'), false);
  assert.strictEqual(trivial('a.c', 'int x;', 'intx;'), false);
  assert.strictEqual(trivial('a.c', 'a/* c */b', 'ab'), false);
});

test('indentation changes are never trivial in Python', () => {
  assert.strictEqual(trivial('a.py', 'if x:\n    y()', 'if x:\n        y()'), false);
  assert.strictEqual(trivial('a.py', 'if x:\n    y()', 'if x:\n\ty()'), false);
  assert.strictEqual(trivial('a.py', 'if x:\n    y()\n    # note', 'if x:\n    y()\n        # note moved'), true, 'comment lines carry no indentation');
});

test('C preprocessor lines are code', () => {
  assert.strictEqual(trivial('a.c', '#define LIMIT 1', '#define LIMIT 2'), false);
  assert.strictEqual(trivial('a.h', '#include "a.h"', '#include "b.h"'), false);
  assert.strictEqual(trivial('a.c', '#if 0\nx();\n#endif', '#if 1\nx();\n#endif'), false);
});

test('multi-line strings, templates and raw strings are never trivial', () => {
  const cases = [
    ['a.js', 'const s = `\n// a\n`;', 'const s = `\n// b\n`;'],
    ['a.js', '// a\n`;', '// b\n`;'],
    ['a.go', 'q := `\n// a\n`', 'q := `\n// b\n`'],
    ['a.py', 'x = """\n# a\n"""', 'x = """\n# b\n"""'],
    ['a.py', "x = '''# a'''", "x = '''# b'''"],
    ['a.py', 'x = f"{d["#"]}"  # old', 'x = f"{d["#"]}"  # new'],
    ['a.java', 'String s = """\n// a\n""";', 'String s = """\n// b\n""";'],
    ['a.kt', 'val s = "${m["//"]}" // a', 'val s = "${m["//"]}" // b'],
    ['a.cs', 'var s = @"a\n// a";', 'var s = @"a\n// b";'],
    ['a.cs', 'var s = $"{d["//"]}"; // a', 'var s = $"{d["//"]}"; // b'],
    ['a.rs', 'let s = r#"// a"#;', 'let s = r#"// b"#;'],
    ['a.rs', 'let s = "line\n// a";', 'let s = "line\n// b";'],
    ['a.cpp', 'auto s = R"(// a)";', 'auto s = R"(// b)";'],
    ['a.c', 'char *s = "a\\\n// a";', 'char *s = "a\\\n// b";']
  ];
  for (const [file, before, after] of cases) {
    assert.strictEqual(trivial(file, before, after), false, `${file}: ${JSON.stringify(before)}`);
  }
});

test('ambiguous JS syntax is never trivial', () => {
  assert.strictEqual(trivial('a.js', "x = /'/; y = '//'", "x = /'/; y = '//x'"), false, 'regex literal');
  assert.strictEqual(trivial('a.js', 'x = a / b; // old', 'x = a / b; // new'), false, 'division');
  assert.strictEqual(trivial('a.jsx', '<p>// old</p>', '<p>// new</p>'), false, 'JSX text');
  assert.strictEqual(trivial('a.js', 'x = 1;\n--> old', 'x = 1;\n--> new'), false, 'HTML close comment');
});

test('comment tricks that can hide code are never trivial', () => {
  assert.strictEqual(trivial('a.c', '// note\nx();', '// note \\\nx();'), false, 'backslash continues a C line comment');
  assert.strictEqual(trivial('a.c', '// note\nx();', '// note ??/\nx();'), false, 'trigraph continuation');
  assert.strictEqual(trivial('a.rs', '/* a /* b */ */', '/* a /* c */ */'), false, 'nested block comment');
  assert.strictEqual(trivial('a.js', '/* open', '/* still open'), false, 'unterminated block comment');
  assert.strictEqual(trivial('a.js', "s = 'open", "s = 'open2"), false, 'unterminated string');
  assert.strictEqual(trivial('a.py', 'x = a \\\n  + b', 'x = a \\  \n  + b'), false, 'whitespace after a line continuation');
});

test('Write, unknown languages and MultiEdit with any non-trivial entry are not trivial', () => {
  assert.strictEqual(write('a.js', '// only a comment\n').trivial, false);
  assert.strictEqual(trivial('a.rb', '# a', '# b'), false);
  assert.strictEqual(trivial('a.sh', '# a', '# b'), false);
  const multi = edits => profileChange({ filePath: 'a.js', tool: 'Edit', edits });
  assert.strictEqual(multi([{ old_string: '// a', new_string: '// b' }, { old_string: '// c', new_string: '// d' }]).trivial, true);
  assert.strictEqual(multi([{ old_string: '// a', new_string: '// b' }, { old_string: 'f(1)', new_string: 'f(2)' }]).trivial, false);
});

test('comments that mention exports or data do not stop an edit from being trivial', () => {
  const profile = edit('a.js', '// export JSON later\nfoo();', '// export JSON soon\nfoo();');
  assert.strictEqual(profile.trivial, true);
  assert.strictEqual(profile.known, true);
});

// ── bounded work ──
console.log('\nbounded work:');

test('64 KiB adversarial inputs profile in linear time', () => {
  const size = MAX_SIDE_BYTES;
  const inputs = [
    '/*'.repeat(size / 2),
    '//'.repeat(size / 2),
    "'".repeat(size),
    '"\\'.repeat(size / 2),
    '\\\n'.repeat(size / 2),
    'a'.repeat(size),
    ' '.repeat(size - 1) + 'x',
    '\n'.repeat(size),
    'export '.repeat(Math.floor(size / 7)),
    'def _'.repeat(Math.floor(size / 5)),
    'aA'.repeat(size / 2),
    '# \\'.repeat(Math.floor(size / 3)),
    'func ('.repeat(Math.floor(size / 6)),
    'select from '.repeat(Math.floor(size / 12))
  ];
  for (const [index, input] of inputs.entries()) {
    for (const file of ['a.js', 'a.py', 'a.go', 'a.rs', 'a.c']) {
      const start = process.hrtime.bigint();
      edit(file, input, `${input} `);
      write(file, input);
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      assert.ok(ms < 250, `input ${index} in ${file} took ${ms.toFixed(1)} ms`);
    }
  }
});

test('never throws on hostile shapes', () => {
  const hostile = [
    { filePath: 'a.js', tool: 'Edit', edits: [null, { old_string: 'a', new_string: 'b' }] },
    { filePath: 'a.js', tool: 'Edit', edits: [{ get old_string() { throw new Error('boom'); }, new_string: 'b' }] },
    { filePath: { toString() { throw new Error('boom'); } }, tool: 'Edit', edits: [] },
    { filePath: 'a.js', tool: 'Write', get content() { throw new Error('boom'); } }
  ];
  for (const input of hostile) assert.deepStrictEqual(profileChange(input), UNKNOWN_PROFILE);
});

console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
