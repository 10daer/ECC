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
  ['.cc', 'cpp'], ['.cpp', 'cpp'], ['.cxx', 'cpp'], ['.hpp', 'cpp'], ['.hh', 'cpp'], ['.hxx', 'cpp'],
  ['.sh', 'shell'], ['.bash', 'shell'], ['.zsh', 'shell'],
  ['.ps1', 'powershell'], ['.psm1', 'powershell'],
  ['.bat', 'batch'], ['.cmd', 'batch']
]);

// --- Lexing ---
// see docs/gateguard/design-notes.md#trivial-edits

const C_FAMILY = { lineComment: '//', blockComment: true, quotes: '"\'', indentSensitive: false };

const LEX_SPECS = {
  js: { ...C_FAMILY, forbiddenCode: '`/', jsx: true },
  go: { ...C_FAMILY, forbiddenCode: '`' },
  rust: { ...C_FAMILY, quotes: '"', rustChars: true, rawPrefixes: 'r#', rustDocs: true },
  java: { ...C_FAMILY, tripleQuotes: true },
  kotlin: { ...C_FAMILY, tripleQuotes: true, noDollarInStrings: true },
  csharp: { ...C_FAMILY, tripleQuotes: true, rawPrefixes: '@$' },
  c: { ...C_FAMILY, rawPrefixes: 'R' },
  cpp: { ...C_FAMILY, rawPrefixes: 'R' },
  python: { lineComment: '#', blockComment: false, quotes: '"\'', indentSensitive: true, tripleQuotes: true, fStrings: true },
  shell: { lexer: shCodeLines, normalize: line => normalizeShellLine(line, '\\') },
  powershell: { lexer: psCodeLines, normalize: line => normalizeShellLine(line, '`') },
  batch: { lexer: batchCodeLines, normalize: line => line }
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

// --- Directive comments ---
// see docs/gateguard/design-notes.md#directive-comments

const DIRECTIVE_LEADS = ['@', '#', '<', '+', '!', 'type:', 'global ', 'globals ', 'exported ', 'requires'];
const DIRECTIVE_RAW_LEADS = ['!', '/', 'go:', 'export ', 'extern ', 'line '];
const DIRECTIVE_WORDS = [
  'lint', 'jshint', 'ts-', 'noqa', 'nosec', 'semgrep', 'sonar', 'noinspection', 'pragma', 'coding:', 'coding=', 'fmt:', 'isort:',
  'mypy:', 'pyright:', 'pyre-', 'yapf:', 'ruff:', 'flake8', 'bandit', 'no cover', 'nocover', 'istanbul', 'c8 ', 'v8 ',
  'prettier-', 'biome-', 'deno-', 'dprint-', 'rome-', 'webpack', 'vite-', '__pure__', '__no_side_effects__',
  '__inline__', '@preserve', '@license', 'sourcemappingurl', 'sourceurl', '+build', 'cgo', 'clang-', 'cppcheck',
  'coverity', 'iwyu', 'fallthrough', 'fall through', 'fall-through', 'fallthru', 'fall thru', 'shellcheck',
  'psscriptanalyzer', 'suppress', 'jscs', 'checkstyle', 'spotbugs', 'findbugs', 'nopmd', 'codeql', 'lgtm', 'gitleaks',
  'trufflehog', 'detect-secrets', 'allowlist', 'vim:', 'vi:', ' ex:', '-*-', 'code generated', 'do not edit',
  'rubocop', 'swiftlint', 'resharper', '@ts-', '@type', '@typedef', '@template', '@satisfies', '@import', '@callback',
  '@overload', '@enum', '@this', '@implements', '@extends', '@augments', '@jsx', '@flow', '@noflow', '@generated',
  'compdef', 'autoload', 'output:'
];

function isDirectiveComment(body, spec) {
  if (spec.rustDocs && (body[0] === '/' || body[0] === '!' || body[0] === '*')) return true;
  if (DIRECTIVE_RAW_LEADS.some(lead => body.startsWith(lead))) return true;
  const lower = body.toLowerCase();
  let start = 0;
  while (start < lower.length && (isSpace(lower[start]) || lower[start] === '*' || lower[start] === '/')) start++;
  const lead = lower.slice(start);
  if (DIRECTIVE_LEADS.some(word => lead.startsWith(word))) return true;
  if (DIRECTIVE_WORDS.some(word => lower.includes(word))) return true;
  return lower.includes('@') && lower.includes('{');
}

function directiveMarker(body, spec) {
  return isDirectiveComment(body, spec) ? ` \u0001${Buffer.from(body, 'utf8').toString('hex')}\u0001 ` : '';
}

function endsWithContinuation(code) {
  let end = code.length;
  while (end > 0 && isSpace(code[end - 1])) end--;
  return code[end - 1] === '\\';
}

function lexCodeLines(text, spec) {
  const lines = [];
  let code = '';
  let state = 'code';
  let quote = '';
  let stringBody = '';
  let commentStart = 0;
  const endComment = end => {
    const marker = directiveMarker(text.slice(commentStart, end), spec);
    if (marker) code += marker;
  };
  const endLine = () => {
    if (endsWithContinuation(code)) return false;
    lines.push(code);
    code = '';
    return true;
  };
  if (spec.jsx !== undefined && text.startsWith('#!')) state = 'line';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\n' || ch === '\r') {
      if (state === 'string') return null;
      if (state === 'line') {
        if (text.slice(commentStart, i).trimEnd().endsWith('\\')) return null;
        endComment(i);
        state = 'code';
      }
      if (state === 'block') {
        lines.push(code);
        code = '';
      } else if (!endLine()) {
        return null;
      }
      if (ch === '\r' && text[i + 1] === '\n') i++;
      continue;
    }
    if (state === 'line') continue;
    if (state === 'block') {
      if (ch === '*' && text[i + 1] === '/') {
        endComment(i);
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
      commentStart = i + 2;
      i++;
      continue;
    }
    if (spec.lineComment === '#' && ch === '#') {
      state = 'line';
      commentStart = i + 1;
      continue;
    }
    if (spec.blockComment && ch === '/' && text[i + 1] === '*') {
      state = 'block';
      commentStart = i + 2;
      i++;
      continue;
    }
    if (spec.forbiddenCode && spec.forbiddenCode.includes(ch)) return null;
    if (spec.jsx && ch === '<' && (isLetter(text[i + 1]) || text[i + 1] === '/' || text[i + 1] === '>' || text[i + 1] === '!')) return null;
    if (spec.jsx !== undefined && ch === '-' && text[i + 1] === '-' && text[i + 2] === '>') return null;
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
  if (state === 'line') {
    if (text.slice(commentStart).trimEnd().endsWith('\\')) return null;
    endComment(text.length);
  }
  return endLine() ? lines : null;
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
  const lines = spec.lexer ? spec.lexer(text) : lexCodeLines(text, spec);
  if (lines === null) return null;
  const signature = [];
  for (const line of lines) {
    if (hasSpaceAfterContinuation(line)) return null;
    const normalized = spec.normalize ? spec.normalize(line) : normalizeCodeLine(line, spec);
    if (normalized === null) return null;
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

// --- Shell lexing ---
// see docs/gateguard/design-notes.md#shell-scripts

const SHELL_SPEC = Object.freeze({});

function isLineStart(text, i) {
  return i === 0 || text[i - 1] === '\n' || text[i - 1] === '\r';
}

function hashStartsComment(text, i) {
  if (isLineStart(text, i)) return true;
  const prev = text[i - 1];
  if (prev === ' ' || prev === '\t' || prev === ';') return true;
  return '()|&<>'.includes(prev) ? null : false;
}

function shDoubleQuoteEnd(text, i) {
  for (let j = i + 1; j < text.length; j++) {
    const ch = text[j];
    if (ch === '"') return j;
    if (ch === '\n' || ch === '\r' || ch === '`') return -1;
    if (ch === '\\') {
      if (j + 1 >= text.length || text[j + 1] === '\n' || text[j + 1] === '\r') return -1;
      j++;
    } else if (ch === '$' && text[j + 1] === '(') {
      return -1;
    } else if (ch === '$' && text[j + 1] === '{') {
      const close = text.indexOf('}', j + 2);
      if (close === -1) return -1;
      for (let k = j + 2; k < close; k++) {
        if ('"\'\n\r'.includes(text[k])) return -1;
      }
      j = close;
    }
  }
  return -1;
}

function hasLoneCarriageReturn(text) {
  for (let at = text.indexOf('\r'); at !== -1; at = text.indexOf('\r', at + 1)) {
    if (text[at + 1] !== '\n') return true;
  }
  return false;
}

function isBlank(ch) {
  return ch === ' ' || ch === '\t';
}

function shCodeLines(text) {
  if (text.includes('<<') || text.includes('`') || hasLoneCarriageReturn(text)) return null;
  const lines = [];
  let code = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\n' || ch === '\r') {
      lines.push(code);
      code = '';
      if (ch === '\r' && text[i + 1] === '\n') i++;
      continue;
    }
    if (ch === '\\') {
      const next = text[i + 1];
      if (next === undefined || next === '\n' || next === '\r') return null;
      code += ch + next;
      i++;
      continue;
    }
    if (ch === "'") {
      if (text[i - 1] === '$') return null;
      const end = text.indexOf("'", i + 1);
      if (end === -1) return null;
      const body = text.slice(i, end + 1);
      if (body.includes('\n') || body.includes('\r')) return null;
      code += body;
      i = end;
      continue;
    }
    if (ch === '"') {
      const end = shDoubleQuoteEnd(text, i);
      if (end === -1) return null;
      code += text.slice(i, end + 1);
      i = end;
      continue;
    }
    if (ch === '#') {
      const starts = hashStartsComment(text, i);
      if (starts === null) return null;
      if (starts) {
        const start = i + 1;
        while (i + 1 < text.length && text[i + 1] !== '\n' && text[i + 1] !== '\r') i++;
        code += directiveMarker(text.slice(start, i + 1), SHELL_SPEC);
        continue;
      }
    }
    code += ch;
  }
  lines.push(code);
  return lines;
}

const PS_SMART_QUOTES = /[\u2018\u2019\u201a\u201b\u201c\u201d\u201e]/;

function psHashStartsComment(text, i) {
  if (isLineStart(text, i)) return true;
  const prev = text[i - 1];
  return prev === ' ' || prev === '\t' || prev === ';';
}

function psQuoteEnd(text, i) {
  const quote = text[i];
  for (let j = i + 1; j < text.length; j++) {
    const ch = text[j];
    if (ch === '\n' || ch === '\r') return -1;
    if (quote === '"' && ch === '`') {
      if (j + 1 >= text.length || text[j + 1] === '\n' || text[j + 1] === '\r') return -1;
      j++;
    } else if (quote === '"' && ch === '$' && text[j + 1] === '(') {
      return -1;
    } else if (ch === quote) {
      if (text[j + 1] !== quote) return j;
      j++;
    }
  }
  return -1;
}

function psCodeLines(text) {
  if (text.includes('@"') || text.includes("@'") || PS_SMART_QUOTES.test(text)) return null;
  const lines = [];
  let code = '';
  let block = false;
  let blockStart = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\n' || ch === '\r') {
      lines.push(code);
      code = '';
      if (ch === '\r' && text[i + 1] === '\n') i++;
      continue;
    }
    if (block) {
      if (ch === '<' && text[i + 1] === '#') return null;
      if (ch === '#' && text[i + 1] === '>') {
        block = false;
        code += directiveMarker(text.slice(blockStart, i), SHELL_SPEC) || ' ';
        i++;
      }
      continue;
    }
    if (ch === '`') {
      const next = text[i + 1];
      if (next === undefined || next === '\n' || next === '\r') return null;
      code += ch + next;
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const end = psQuoteEnd(text, i);
      if (end === -1) return null;
      code += text.slice(i, end + 1);
      i = end;
      continue;
    }
    if (ch === '<' && text[i + 1] === '#') {
      if (!psHashStartsComment(text, i)) return null;
      block = true;
      blockStart = i + 2;
      i++;
      continue;
    }
    if (ch === '#') {
      if (!psHashStartsComment(text, i)) return null;
      const start = i + 1;
      while (i + 1 < text.length && text[i + 1] !== '\n' && text[i + 1] !== '\r') i++;
      code += directiveMarker(text.slice(start, i + 1), SHELL_SPEC);
      continue;
    }
    code += ch;
  }
  if (block) return null;
  lines.push(code);
  return lines;
}

function batchCodeLines(text) {
  const lines = [];
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (line.endsWith('^')) return null;
    let start = 0;
    while (isBlank(line[start])) start++;
    if (line[start] === '@') start++;
    while (isBlank(line[start])) start++;
    const word = line.slice(start, start + 3).toLowerCase();
    const after = line[start + 3];
    if (word === 'rem' && (after === undefined || isBlank(after))) {
      if (/[%^&|<>()]/.test(line)) return null;
      lines.push(directiveMarker(line.slice(start + 4), SHELL_SPEC));
    } else {
      lines.push(line.trim() ? line : '');
    }
  }
  return lines;
}

function normalizeShellLine(line, escape) {
  let out = '';
  let pendingSpace = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (isBlank(ch)) {
      pendingSpace = true;
      continue;
    }
    if (pendingSpace && out) out += ' ';
    pendingSpace = false;
    if (ch === escape && i + 1 < line.length) {
      out += ch + line[++i];
    } else if (ch === "'" || ch === '"') {
      const end = escape === '`' ? psQuoteEnd(line, i) : ch === "'" ? line.indexOf("'", i + 1) : shDoubleQuoteEnd(line, i);
      if (end === -1) return null;
      out += line.slice(i, end + 1);
      i = end;
    } else {
      out += ch;
    }
  }
  return out;
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
  if (start !== 0) return false;
  const name = identifierAt(t, 0);
  const rest = skipSpaces(t, name.length);
  const after = t[rest];
  const assigned = (after === '=' && t[rest + 1] !== '=') || (after === ':' && skipSpaces(t, rest + 1) < t.length);
  if (!name || !isLetter(name[0]) || !assigned) return false;
  return index > 0 ? pythonNameIsPublic(name) : name === name.toUpperCase();
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

function shellFunctionName(t) {
  let end = 0;
  while (end < t.length && (isIdentChar(t[end]) || t[end] === '-' || t[end] === ':' || t[end] === '.')) end++;
  if (end === 0) return false;
  const open = skipSpaces(t, end);
  return t[open] === '(' && t[skipSpaces(t, open + 1)] === ')';
}

function shellLineIsSurface(line) {
  const t = line.slice(skipSpaces(line, 0));
  if (leadingWord(t, 'export') || leadingWord(t, 'function')) return true;
  if (leadingWord(t, 'declare') || leadingWord(t, 'typeset')) {
    const flags = t.slice(skipSpaces(t, 7));
    return flags[0] === '-' && identifierAt(flags, 1).includes('x');
  }
  return shellFunctionName(t);
}

const POWERSHELL_SURFACE_WORDS = ['function', 'filter', 'workflow', 'class', 'enum', 'param', 'export-modulemember', '[cmdletbinding', '$global:'];

function powershellLineIsSurface(line) {
  const t = line.slice(skipSpaces(line, 0)).toLowerCase();
  return POWERSHELL_SURFACE_WORDS.some(word => t.startsWith(word) && (word.endsWith(':') || !isIdentChar(t[word.length])));
}

const SURFACE_BY_LANGUAGE = {
  js: jsLineIsSurface,
  python: pythonLineIsSurface,
  go: goLineIsSurface,
  rust: rustLineIsSurface,
  shell: shellLineIsSurface,
  powershell: powershellLineIsSurface
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

const SHELL_LANGUAGES = new Set(['shell', 'powershell', 'batch']);
const SHELL_DATA_WORDS = new Set(['curl', 'wget', 'jq', 'yq', 'xmllint', 'psql', 'tee', 'iwr', 'irm', 'clixml']);
const SHELL_DATA_PAIRS = [['out', 'file'], ['get', 'content'], ['set', 'content'], ['add', 'content'], ['web', 'request'], ['rest', 'method']];
const NULL_TARGETS = ['/dev/null', '/dev/stdout', '/dev/stderr', '$null', 'nul'];

function redirectTargetIsFile(text, at) {
  const start = skipSpaces(text, at);
  const ch = text[start];
  if (ch === undefined || ch === '\n' || ch === '\r' || ch === '&') return false;
  const rest = text.slice(start, start + 12).toLowerCase();
  return !NULL_TARGETS.some(target => rest.startsWith(target) && !isIdentChar(rest[target.length]) && rest[target.length] !== '.');
}

function shellRedirectsFile(text) {
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '>') {
      const prev = text[i - 1];
      if (prev === '-' || prev === '=' || prev === '>') continue;
      let at = i + 1;
      if (text[at] === '>' || text[at] === '|') at++;
      if (text[at] === '=' || text[at] === '&') continue;
      if (redirectTargetIsFile(text, at)) return true;
    } else if (ch === '<') {
      const next = text[i + 1];
      if (text[i - 1] === '<' || next === '<' || next === '(' || next === '&' || next === '#' || next === '=') continue;
      if (redirectTargetIsFile(text, i + 1)) return true;
    }
  }
  return false;
}

function textTouchesData(text, language) {
  const shell = SHELL_LANGUAGES.has(language);
  if (shell && shellRedirectsFile(text)) return true;
  const seen = new Set();
  let previous = '';
  for (const { word, call } of words(text)) {
    if (DATA_WORDS.has(word)) return true;
    if (shell && (SHELL_DATA_WORDS.has(word) || SHELL_DATA_PAIRS.some(([a, b]) => previous === a && word === b))) return true;
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
    const touchesData = texts.sides.some(side => textTouchesData(side, language));
    const spec = LEX_SPECS[language];
    const trivial = input.tool === 'Edit' && texts.pairs.every(([oldString, newString]) => isTrivialEdit(oldString, newString, spec));
    return Object.freeze({ known: true, language, touchesPublicSurface, touchesData, trivial });
  } catch (_) {
    return UNKNOWN_PROFILE;
  }
}

module.exports = { MAX_SIDE_BYTES, MAX_TOTAL_BYTES, MAX_EDITS, UNKNOWN_PROFILE, languageFor, profileChange };
