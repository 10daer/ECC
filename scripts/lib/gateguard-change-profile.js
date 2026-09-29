'use strict';

// see docs/gateguard/design-notes.md#change-profile

const MAX_SIDE_BYTES = 64 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024;
const MAX_EDITS = 64;

const UNKNOWN_PROFILE = Object.freeze({ known: false, language: null, touchesPublicSurface: true, touchesData: true, trivial: false });

const LANGUAGE_BY_EXT = new Map([
  ['.js', 'js'], ['.mjs', 'js'], ['.cjs', 'js'], ['.jsx', 'js'], ['.ts', 'js'], ['.tsx', 'js'], ['.mts', 'js'], ['.cts', 'js'],
  ['.py', 'python'], ['.pyi', 'python'],
  ['.go', 'go'],
  ['.rs', 'rust'],
  ['.java', 'java'],
  ['.kt', 'kotlin'], ['.kts', 'kotlin'],
  ['.cs', 'csharp'],
  ['.c', 'c'], ['.h', 'c'],
  ['.cc', 'cpp'], ['.cpp', 'cpp'], ['.cxx', 'cpp'], ['.hpp', 'cpp'], ['.hh', 'cpp'], ['.hxx', 'cpp']
]);

// --- Lexing ---
// see docs/gateguard/design-notes.md#trivial-edits

const C_FAMILY = { lineComment: '//', blockComment: true, quotes: '"\'', indentSensitive: false };

const LEX_SPECS = {
  js: { ...C_FAMILY, forbiddenCode: '`/', jsx: true },
  go: { ...C_FAMILY, forbiddenCode: '`' },
  rust: { ...C_FAMILY, quotes: '"', rustChars: true, rawPrefixes: 'r#' },
  java: { ...C_FAMILY, tripleQuotes: true },
  kotlin: { ...C_FAMILY, tripleQuotes: true, noDollarInStrings: true },
  csharp: { ...C_FAMILY, tripleQuotes: true, rawPrefixes: '@$' },
  c: { ...C_FAMILY, rawPrefixes: 'R' },
  cpp: { ...C_FAMILY, rawPrefixes: 'R' },
  python: { lineComment: '#', blockComment: false, quotes: '"\'', indentSensitive: true, tripleQuotes: true, fStrings: true }
};

function isSpace(ch) {
  return ch === ' ' || ch === '\t' || ch === '\f' || ch === '\v';
}

function isIdentChar(ch) {
  return ch !== undefined && ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch === '_' || ch === '$');
}

function isLetter(ch) {
  return ch !== undefined && ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z'));
}

function rustCharEnd(text, i) {
  if (text[i + 1] === '\\') {
    if (text[i + 2] === "'") return text[i + 3] === "'" ? i + 3 : -1;
    const end = text.indexOf("'", i + 3);
    return end !== -1 && end <= i + 12 ? end : -1;
  }
  const cp = text.codePointAt(i + 1);
  if (cp === undefined || text[i + 1] === '\n' || text[i + 1] === '\r' || text[i + 1] === "'") return -1;
  const end = i + (cp > 0xffff ? 3 : 2);
  return text[end] === "'" ? end : -1;
}

function stringPrefixIsUnsafe(code, spec) {
  const last = code[code.length - 1];
  if (spec.rawPrefixes && last !== undefined && spec.rawPrefixes.includes(last)) return true;
  if (!spec.fStrings || !isLetter(last)) return false;
  const prefix = isLetter(code[code.length - 2]) ? code.slice(-2) : last;
  return prefix.toLowerCase().includes('f');
}

function lexCodeLines(text, spec) {
  const lines = [];
  let code = '';
  let state = 'code';
  let quote = '';
  let stringBody = '';
  let commentTail = '';
  const endLine = () => {
    lines.push(code);
    code = '';
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\n' || ch === '\r') {
      if (state === 'string') return null;
      if (state === 'line') {
        if (commentTail.endsWith('\\')) return null;
        state = 'code';
      }
      endLine();
      if (ch === '\r' && text[i + 1] === '\n') i++;
      continue;
    }
    if (state === 'line') {
      if (!isSpace(ch)) commentTail = commentTail.length > 8 ? commentTail.slice(-4) + ch : commentTail + ch;
      continue;
    }
    if (state === 'block') {
      if (ch === '*' && text[i + 1] === '/') {
        state = 'code';
        code += ' ';
        i++;
      } else if (ch === '/' && text[i + 1] === '*') {
        return null;
      }
      continue;
    }
    if (state === 'string') {
      code += ch;
      if (ch === '\\') {
        const next = text[i + 1];
        if (next === undefined || next === '\n' || next === '\r') return null;
        code += next;
        i++;
      } else if (ch === quote) {
        if (spec.noDollarInStrings && stringBody.includes('$')) return null;
        state = 'code';
      } else {
        stringBody += ch;
      }
      continue;
    }
    if (spec.lineComment === '//' && ch === '/' && text[i + 1] === '/') {
      state = 'line';
      commentTail = '';
      i++;
      continue;
    }
    if (spec.lineComment === '#' && ch === '#') {
      state = 'line';
      commentTail = '';
      continue;
    }
    if (spec.blockComment && ch === '/' && text[i + 1] === '*') {
      state = 'block';
      i++;
      continue;
    }
    if (spec.forbiddenCode && spec.forbiddenCode.includes(ch)) return null;
    if (spec.jsx && ch === '<' && (isLetter(text[i + 1]) || text[i + 1] === '/' || text[i + 1] === '>' || text[i + 1] === '!')) return null;
    if (spec.jsx && ch === '-' && text[i + 1] === '-' && text[i + 2] === '>') return null;
    if (ch === "'" && spec.rustChars) {
      const end = rustCharEnd(text, i);
      code += end === -1 ? ch : text.slice(i, end + 1);
      if (end !== -1) i = end;
      continue;
    }
    if (spec.quotes.includes(ch)) {
      if (spec.tripleQuotes && text[i + 1] === ch && text[i + 2] === ch) return null;
      if (stringPrefixIsUnsafe(code, spec)) return null;
      state = 'string';
      quote = ch;
      stringBody = '';
      code += ch;
      continue;
    }
    code += ch;
  }
  if (state === 'string' || state === 'block') return null;
  if (state === 'line' && commentTail.endsWith('\\')) return null;
  endLine();
  return lines;
}

function normalizeCodeLine(line, spec) {
  let out = '';
  let pendingSpace = false;
  let quote = '';
  let indent = '';
  let leading = true;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      out += ch;
      if (ch === '\\' && i + 1 < line.length) out += line[++i];
      else if (ch === quote) quote = '';
      continue;
    }
    if (isSpace(ch)) {
      if (leading) indent += ch;
      else pendingSpace = true;
      continue;
    }
    leading = false;
    if (pendingSpace && out) out += ' ';
    pendingSpace = false;
    if (ch === "'" && spec.rustChars) {
      const end = rustCharEnd(line, i);
      out += end === -1 ? ch : line.slice(i, end + 1);
      if (end !== -1) i = end;
      continue;
    }
    if (spec.quotes.includes(ch)) quote = ch;
    out += ch;
  }
  if (!out) return '';
  return spec.indentSensitive ? `${indent}\u0000${out}` : out;
}

function hasSpaceAfterContinuation(line) {
  let end = line.length;
  while (end > 0 && isSpace(line[end - 1])) end--;
  return end < line.length && line[end - 1] === '\\';
}

function codeSignature(text, spec) {
  const lines = lexCodeLines(text, spec);
  if (lines === null) return null;
  const signature = [];
  for (const line of lines) {
    if (hasSpaceAfterContinuation(line)) return null;
    const normalized = normalizeCodeLine(line, spec);
    if (normalized) signature.push(normalized);
  }
  return signature;
}

function isTrivialEdit(oldString, newString, spec) {
  if (spec.lineComment === '//' && (oldString.includes('??/') || newString.includes('??/'))) return false;
  const before = codeSignature(oldString, spec);
  if (before === null) return false;
  const after = codeSignature(newString, spec);
  if (after === null || before.length !== after.length) return false;
  return before.every((line, index) => line === after[index]);
}

// --- Public surface ---

function leadingWord(text, word) {
  return text.startsWith(word) && !isIdentChar(text[word.length]);
}

function containsWord(text, word) {
  for (let at = text.indexOf(word); at !== -1; at = text.indexOf(word, at + 1)) {
    if (!isIdentChar(text[at - 1]) && !isIdentChar(text[at + word.length])) return true;
  }
  return false;
}

function identifierAt(text, start) {
  let end = start;
  while (end < text.length && isIdentChar(text[end])) end++;
  return text.slice(start, end);
}

function skipSpaces(text, at) {
  while (at < text.length && isSpace(text[at])) at++;
  return at;
}

function isUpper(ch) {
  return ch !== undefined && ch >= 'A' && ch <= 'Z';
}

function jsLineIsSurface(line) {
  const t = line.slice(skipSpaces(line, 0));
  return leadingWord(t, 'export') || containsWord(t, 'exports') || leadingWord(t, 'public') || leadingWord(t, 'declare');
}

function pythonNameIsPublic(name) {
  if (!name) return false;
  return !name.startsWith('_') || (name.length > 4 && name.startsWith('__') && name.endsWith('__'));
}

function pythonLineIsSurface(line, index) {
  const start = skipSpaces(line, 0);
  const t = line.slice(start);
  if (t.includes('__all__')) return true;
  for (const keyword of ['def', 'class']) {
    if (leadingWord(t, keyword)) return pythonNameIsPublic(identifierAt(t, skipSpaces(t, keyword.length)));
  }
  if (leadingWord(t, 'async')) {
    const rest = t.slice(skipSpaces(t, 5));
    if (leadingWord(rest, 'def')) return pythonNameIsPublic(identifierAt(rest, skipSpaces(rest, 3)));
  }
  if (index > 0 && start === 0) {
    const name = identifierAt(t, 0);
    const after = t[skipSpaces(t, name.length)];
    const rest = skipSpaces(t, name.length);
    const assigned = (after === '=' && t[rest + 1] !== '=') || (after === ':' && skipSpaces(t, rest + 1) < t.length);
    return Boolean(name) && isLetter(name[0]) && assigned && pythonNameIsPublic(name);
  }
  return false;
}

function goLineIsSurface(line) {
  const t = line.slice(skipSpaces(line, 0));
  if (isUpper(t[0])) return true;
  if (leadingWord(t, 'package')) return true;
  for (const keyword of ['type', 'var', 'const']) {
    if (leadingWord(t, keyword)) return isUpper(t[skipSpaces(t, keyword.length)]);
  }
  if (!leadingWord(t, 'func')) return false;
  let at = skipSpaces(t, 4);
  if (t[at] === '(') {
    const close = t.indexOf(')', at);
    if (close === -1) return true;
    at = skipSpaces(t, close + 1);
  }
  return isUpper(t[at]);
}

function rustLineIsSurface(line) {
  const t = line.slice(skipSpaces(line, 0));
  return leadingWord(t, 'pub') || leadingWord(t, 'impl') || leadingWord(t, 'trait') || t.startsWith('#[macro_export');
}

const SURFACE_BY_LANGUAGE = {
  js: jsLineIsSurface,
  python: pythonLineIsSurface,
  go: goLineIsSurface,
  rust: rustLineIsSurface
};

function baseName(filePath) {
  return String(filePath).replace(/\\/g, '/').split('/').pop().toLowerCase();
}

function wholeFileIsSurface(filePath, language) {
  const base = baseName(filePath);
  return (language === 'js' && (base.endsWith('.d.ts') || base.endsWith('.d.mts') || base.endsWith('.d.cts'))) ||
    (language === 'python' && base === '__init__.py');
}

function textTouchesSurface(text, lineIsSurface) {
  let index = 0;
  let start = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i === text.length || text[i] === '\n' || text[i] === '\r') {
      if (lineIsSurface(text.slice(start, i), index)) return true;
      index++;
      start = i + 1;
    }
  }
  return false;
}

// --- Data handling ---

const DATA_WORDS = new Set([
  'json', 'jsonl', 'ndjson', 'yaml', 'yml', 'csv', 'tsv', 'xml', 'toml', 'ini', 'parquet', 'avro', 'arrow', 'pickle', 'protobuf',
  'serde', 'serialize', 'serializer', 'serialise', 'deserialize', 'deserializer', 'deserialise', 'marshal', 'unmarshal',
  'schema', 'schemas', 'sql', 'sqlite', 'sqlite3', 'postgres', 'mysql', 'mongo', 'mongodb', 'database', 'db', 'cursor',
  'migration', 'migrations', 'orm', 'dataframe', 'pandas',
  'date', 'dates', 'datetime', 'timestamp', 'timestamps', 'strftime', 'strptime', 'isoformat', 'iso', 'iso8601', 'timezone',
  'tz', 'utc', 'epoch', 'dayjs', 'moment', 'luxon', 'instant',
  'fs', 'fopen', 'fread', 'fwrite', 'fgets', 'ioutil', 'bufio', 'pathlib', 'shutil', 'readfile', 'writefile', 'fstream',
  'ifstream', 'ofstream'
]);
const DATA_PAIRS = [
  ['read', 'file'], ['write', 'file'], ['append', 'file'], ['open', 'file'], ['read', 'text'], ['write', 'text'],
  ['read', 'bytes'], ['write', 'bytes'], ['read', 'to'], ['read', 'lines'], ['write', 'lines'], ['read', 'all'],
  ['file', 'reader'], ['file', 'writer'], ['file', 'stream'], ['read', 'csv'], ['to', 'csv']
];
const SQL_PAIRS = [['select', 'from'], ['insert', 'into'], ['delete', 'from'], ['create', 'table'], ['alter', 'table'], ['drop', 'table'], ['update', 'set']];

function* words(text) {
  let word = '';
  let prev = '';
  for (let i = 0; i <= text.length; i++) {
    const ch = text[i];
    const alnum = ch !== undefined && ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9'));
    const boundary = alnum && word && (
      (isUpper(ch) && !isUpper(prev) && !(prev >= '0' && prev <= '9')) ||
      (isUpper(ch) && isUpper(prev) && text[i + 1] >= 'a' && text[i + 1] <= 'z')
    );
    if (!alnum || boundary) {
      if (word) yield { word: word.toLowerCase(), call: !alnum && text[skipSpaces(text, i)] === '(' };
      word = alnum ? ch : '';
    } else {
      word += ch;
    }
    prev = ch;
  }
}

function textTouchesData(text) {
  const seen = new Set();
  let previous = '';
  for (const { word, call } of words(text)) {
    if (DATA_WORDS.has(word)) return true;
    if (word === 'open' && call) return true;
    if (DATA_PAIRS.some(([a, b]) => previous === a && word === b)) return true;
    seen.add(word);
    previous = word;
  }
  return SQL_PAIRS.some(([a, b]) => seen.has(a) && seen.has(b));
}

// --- Profile ---

/** Language of a target by extension, or null when unsupported. */
function languageFor(filePath) {
  if (typeof filePath !== 'string' || !filePath) return null;
  const base = baseName(filePath);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return null;
  return LANGUAGE_BY_EXT.get(base.slice(dot)) || null;
}

function changeTexts(input) {
  if (input.tool === 'Write') {
    return typeof input.content === 'string' ? { sides: [input.content], pairs: [] } : null;
  }
  if (input.tool !== 'Edit' || !Array.isArray(input.edits) || input.edits.length === 0 || input.edits.length > MAX_EDITS) return null;
  const pairs = [];
  for (const entry of input.edits) {
    if (!entry || typeof entry !== 'object') return null;
    const oldString = entry.old_string;
    const newString = entry.new_string;
    if (typeof oldString !== 'string' || typeof newString !== 'string') return null;
    pairs.push([oldString, newString]);
  }
  return { sides: pairs.flat(), pairs };
}

function withinBounds(sides) {
  let total = 0;
  for (const side of sides) {
    if (side.length > MAX_SIDE_BYTES) return false;
    const bytes = Buffer.byteLength(side, 'utf8');
    if (bytes > MAX_SIDE_BYTES) return false;
    total += bytes;
    if (total > MAX_TOTAL_BYTES) return false;
  }
  return true;
}

/** Profile of one target's change from Edit/MultiEdit entries or Write content; unknown on any doubt. */
function profileChange(input) {
  try {
    if (!input || typeof input !== 'object') return UNKNOWN_PROFILE;
    const language = languageFor(input.filePath);
    if (!language) return UNKNOWN_PROFILE;
    const texts = changeTexts(input);
    if (!texts || !withinBounds(texts.sides)) return UNKNOWN_PROFILE;
    const lineIsSurface = SURFACE_BY_LANGUAGE[language];
    const touchesPublicSurface = input.tool === 'Write' || !lineIsSurface || wholeFileIsSurface(input.filePath, language) ||
      texts.sides.some(side => textTouchesSurface(side, lineIsSurface));
    const touchesData = texts.sides.some(textTouchesData);
    const spec = LEX_SPECS[language];
    const trivial = input.tool === 'Edit' && texts.pairs.every(([oldString, newString]) => isTrivialEdit(oldString, newString, spec));
    return Object.freeze({ known: true, language, touchesPublicSurface, touchesData, trivial });
  } catch (_) {
    return UNKNOWN_PROFILE;
  }
}

module.exports = { MAX_SIDE_BYTES, MAX_TOTAL_BYTES, MAX_EDITS, UNKNOWN_PROFILE, languageFor, profileChange };
