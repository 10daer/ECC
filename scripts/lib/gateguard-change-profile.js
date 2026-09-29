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

const C_CONTEXT = { ...C_FAMILY, startsFresh: cFamilyStartsFresh };

const LEX_SPECS = {
  js: { ...C_CONTEXT, flavor: 'js', forbiddenCode: '`/', jsx: true },
  go: { ...C_CONTEXT, flavor: 'go', forbiddenCode: '`' },
  rust: { ...C_CONTEXT, flavor: 'rust', quotes: '"', rustChars: true, rawPrefixes: 'r#', rustDocs: true },
  java: { ...C_CONTEXT, flavor: 'java', tripleQuotes: true },
  kotlin: { ...C_CONTEXT, flavor: 'kotlin', tripleQuotes: true, noDollarInStrings: true },
  csharp: { ...C_CONTEXT, flavor: 'csharp', tripleQuotes: true, rawPrefixes: '@$' },
  c: { ...C_CONTEXT, flavor: 'c', rawPrefixes: 'R' },
  cpp: { ...C_CONTEXT, flavor: 'c', rawPrefixes: 'R' },
  python: { lineComment: '#', blockComment: false, quotes: '"\'', indentSensitive: true, tripleQuotes: true, fStrings: true, startsFresh: pythonStartsFresh },
  shell: { lexer: shCodeLines, normalize: line => normalizeShellLine(line, '\\'), startsFresh: shStartsFresh },
  powershell: { lexer: psCodeLines, normalize: line => normalizeShellLine(line, '`'), startsFresh: psStartsFresh },
  batch: { lexer: batchCodeLines, normalize: line => line, startsFresh: batchStartsFresh }
};
const TS_EXTS = new Set(['.ts', '.mts', '.cts']);
const TS_SPEC = { ...LEX_SPECS.js, jsx: false };

function lexSpecFor(filePath, language) {
  if (language !== 'js') return LEX_SPECS[language];
  const base = baseName(filePath);
  return TS_EXTS.has(base.slice(base.lastIndexOf('.'))) ? TS_SPEC : LEX_SPECS.js;
}

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
  let tail = '';
  const append = piece => {
    code += piece;
    tail = (tail + piece).slice(-2);
  };
  const endComment = end => {
    const marker = directiveMarker(text.slice(commentStart, end), spec);
    if (marker) append(marker);
  };
  const endLine = () => {
    if (endsWithContinuation(code)) return false;
    lines.push(code);
    code = '';
    tail = '';
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
        tail = '';
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
        append(' ');
        i++;
      } else if (ch === '/' && text[i + 1] === '*') {
        return null;
      }
      continue;
    }
    if (state === 'string') {
      append(ch);
      if (ch === '\\') {
        const next = text[i + 1];
        if (next === undefined || next === '\n' || next === '\r') return null;
        append(next);
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
      append(end === -1 ? ch : text.slice(i, end + 1));
      if (end !== -1) i = end;
      continue;
    }
    if (spec.quotes.includes(ch)) {
      if (spec.tripleQuotes && text[i + 1] === ch && text[i + 2] === ch) return null;
      if (stringPrefixIsUnsafe(tail, spec)) return null;
      state = 'string';
      quote = ch;
      stringBody = '';
      append(ch);
      continue;
    }
    append(ch);
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

// --- File context ---
// see docs/gateguard/design-notes.md#file-context

const REPLACEMENT_PATTERN = /\$[$&'`<0-9]/;
const MAX_FILE_CHARS = 1024 * 1024;
const MAX_WINDOW_CHARS = 128 * 1024;
const MAX_CONTEXT_WORK = 8 * 1024 * 1024;
const JS_REGEX_KEYWORDS = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
const JS_CONTROL_HEADERS = new Set(['if', 'while', 'for', 'with']);
const CPP_RAW_PREFIXES = new Set(['R', 'u8R', 'uR', 'UR', 'LR']);

function isNewline(ch) {
  return ch === '\n' || ch === '\r';
}

function lineEndAt(text, i) {
  let j = i;
  while (j < text.length && !isNewline(text[j])) j++;
  return j;
}

function quotedEnd(text, i, quote, multiline) {
  for (let j = i + 1; j < text.length; j++) {
    const ch = text[j];
    if (ch === '\\') {
      j++;
      if (text[j] === '\r' && text[j + 1] === '\n') j++;
    } else if (ch === quote) {
      return j + 1;
    } else if (isNewline(ch) && !multiline) {
      return -1;
    }
  }
  return -1;
}

function regexEnd(text, i) {
  let inClass = false;
  for (let j = i + 1; j < text.length; j++) {
    const ch = text[j];
    if (isNewline(ch)) return -1;
    if (ch === '\\') {
      if (j + 1 >= text.length || isNewline(text[j + 1])) return -1;
      j++;
    } else if (inClass) {
      if (ch === ']') inClass = false;
    } else if (ch === '[') {
      inClass = true;
    } else if (ch === '/') {
      let k = j + 1;
      while (isIdentChar(text[k])) k++;
      return k;
    }
  }
  return -1;
}

function nestedBlockEnd(text, i) {
  let depth = 0;
  for (let j = i; j + 1 < text.length; j++) {
    if (text[j] === '/' && text[j + 1] === '*') {
      depth++;
      j++;
    } else if (text[j] === '*' && text[j + 1] === '/') {
      depth--;
      j++;
      if (depth === 0) return j + 1;
    }
  }
  return -1;
}

function textBlockEnd(text, i, escapes) {
  for (let j = i + 3; j < text.length; j++) {
    if (escapes && text[j] === '\\') {
      j++;
    } else if (!escapes && text[j] === '$' && text[j + 1] === '{') {
      return -1;
    } else if (text.startsWith('"""', j)) {
      let end = j + 3;
      while (text[end] === '"') end++;
      return end;
    }
  }
  return -1;
}

function kotlinStringEnd(text, i) {
  for (let j = i + 1; j < text.length; j++) {
    const ch = text[j];
    if (ch === '\\') j++;
    else if (ch === '$' && text[j + 1] === '{') return -1;
    else if (ch === '"') return j + 1;
    else if (isNewline(ch)) return -1;
  }
  return -1;
}

function csharpStringEnd(text, i) {
  let j = i;
  let verbatim = false;
  let interpolated = false;
  while (text[j] === '@' || text[j] === '$') {
    if (text[j] === '@') verbatim = true;
    else interpolated = true;
    j++;
  }
  if (text.startsWith('"""', j)) return -1;
  for (let k = j + 1; k < text.length; k++) {
    const ch = text[k];
    if (ch === '"') {
      if (verbatim && text[k + 1] === '"') {
        k++;
        continue;
      }
      return k + 1;
    }
    if (!verbatim && ch === '\\') {
      k++;
    } else if (!verbatim && isNewline(ch)) {
      return -1;
    } else if (interpolated && ch === '{') {
      if (text[k + 1] === '{') {
        k++;
        continue;
      }
      let m = k + 1;
      while (m < text.length && text[m] !== '}') {
        if ('"\'{/\n\r'.includes(text[m])) return -1;
        m++;
      }
      if (m >= text.length) return -1;
      k = m;
    }
  }
  return -1;
}

function cppRawEnd(text, quote) {
  const open = text.indexOf('(', quote + 1);
  if (open === -1 || open - quote - 1 > 16) return -1;
  const delimiter = text.slice(quote + 1, open);
  for (const ch of delimiter) {
    if (isSpace(ch) || isNewline(ch) || '()\\"'.includes(ch)) return -1;
  }
  const end = text.indexOf(`)${delimiter}"`, open + 1);
  return end === -1 ? -1 : end + delimiter.length + 2;
}

function rustRawEnd(text, i) {
  let j = i + (text[i] === 'r' ? 1 : 2);
  let hashes = '';
  while (text[j] === '#') {
    hashes += '#';
    j++;
  }
  if (text[j] !== '"') return null;
  const end = text.indexOf(`"${hashes}`, j + 1);
  return end === -1 ? -1 : end + 1 + hashes.length;
}

function wordStart(text, i) {
  let start = i;
  while (start > 0 && isIdentChar(text[start - 1])) start--;
  return start;
}

function cFamilyStringEnd(text, i, spec) {
  const ch = text[i];
  const flavor = spec.flavor;
  if (ch === '`') {
    if (flavor === 'kotlin') return quotedEnd(text, i, '`', false);
    if (flavor !== 'go') return -1;
    const end = text.indexOf('`', i + 1);
    return end === -1 ? -1 : end + 1;
  }
  if (ch === "'") {
    if (flavor === 'rust') {
      const end = rustCharEnd(text, i);
      return end === -1 ? null : end + 1;
    }
    if (flavor === 'c' && isIdentChar(text[i - 1]) && isIdentChar(text[i + 1])) {
      const first = text[wordStart(text, i)];
      if (first >= '0' && first <= '9') return null;
    }
    return quotedEnd(text, i, "'", false);
  }
  if (flavor === 'c') {
    const start = wordStart(text, i);
    const prefix = text.slice(start, i);
    if (CPP_RAW_PREFIXES.has(prefix)) return cppRawEnd(text, i);
    if (prefix.endsWith('R')) return -1;
  }
  if (flavor === 'java' && text.startsWith('"""', i)) return textBlockEnd(text, i, true);
  if (flavor === 'kotlin') return text.startsWith('"""', i) ? textBlockEnd(text, i, false) : kotlinStringEnd(text, i);
  if (flavor === 'csharp' && text.startsWith('"""', i)) return -1;
  return quotedEnd(text, i, '"', flavor === 'rust');
}

function cFamilyStartsFresh(text, spec) {
  const js = spec.flavor === 'js';
  const frames = [{ template: false, depth: 0 }];
  const parens = [];
  let lastWord = '';
  let lastSig = 'op';
  let lineEnd = '';
  let continued = false;
  let i = js && text.startsWith('#!') ? lineEndAt(text, 0) : 0;
  while (i < text.length) {
    const frame = frames[frames.length - 1];
    const ch = text[i];
    const next = text[i + 1];
    if (frame.template) {
      if (ch === '\\') {
        i += 2;
      } else if (ch === '`') {
        frames.pop();
        lastSig = 'value';
        i++;
      } else if (ch === '$' && next === '{') {
        frames.push({ template: false, depth: 0 });
        lastSig = 'op';
        i += 2;
      } else {
        i++;
      }
      continue;
    }
    if (isNewline(ch)) {
      continued = lineEnd === '\\';
      lineEnd = '';
      i++;
      continue;
    }
    if (isSpace(ch)) {
      i++;
      continue;
    }
    if (ch === '/' && next === '/') {
      const end = lineEndAt(text, i);
      if (text.slice(i, end).trimEnd().endsWith('\\')) return false;
      i = end;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = spec.rustDocs ? nestedBlockEnd(text, i) : text.indexOf('*/', i + 2);
      if (end === -1) return false;
      i = spec.rustDocs ? end : end + 2;
      lineEnd = '';
      continue;
    }
    lineEnd = ch;
    if (js) {
      if (ch === '`') {
        frames.push({ template: true, depth: 0 });
        i++;
        continue;
      }
      if (ch === '/') {
        if (lastSig === 'op') {
          const end = regexEnd(text, i);
          if (end === -1) return false;
          lineEnd = text[end - 1];
          lastSig = 'value';
          i = end;
          continue;
        }
        if (lastSig === 'close' && /[/'"`]/.test(text.slice(i + 1, lineEndAt(text, i)))) return false;
        lastSig = 'op';
        i++;
        continue;
      }
      if (ch === '<' && (next === '!' || (spec.jsx && (isLetter(next) || next === '/' || next === '>')))) return false;
      if (ch === '-' && next === '-' && text[i + 2] === '>') return false;
      if (frames.length > 1 && ch === '{') frame.depth++;
      if (frames.length > 1 && ch === '}') {
        if (frame.depth === 0) {
          frames.pop();
          i++;
          continue;
        }
        frame.depth--;
      }
    }
    if (spec.flavor === 'csharp' && (ch === '@' || ch === '$') && /^[@$]{1,3}"/.test(text.slice(i, i + 4))) {
      const end = csharpStringEnd(text, i);
      if (end === -1) return false;
      lineEnd = '"';
      i = end;
      continue;
    }
    if (spec.flavor === 'rust' && (ch === 'r' || ((ch === 'b' || ch === 'c') && next === 'r')) && !isIdentChar(text[i - 1])) {
      const end = rustRawEnd(text, i);
      if (end === -1) return false;
      if (end !== null) {
        lineEnd = text[end - 1];
        lastSig = 'value';
        i = end;
        continue;
      }
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const end = cFamilyStringEnd(text, i, spec);
      if (end === -1) return false;
      if (end !== null) {
        lineEnd = text[end - 1];
        lastSig = 'value';
        i = end;
        continue;
      }
      i++;
      continue;
    }
    if (isIdentChar(ch)) {
      let end = i;
      while (end < text.length && isIdentChar(text[end])) end++;
      lastWord = text.slice(i, end);
      lastSig = js && JS_REGEX_KEYWORDS.has(lastWord) ? 'op' : 'value';
      lineEnd = text[end - 1];
      i = end;
      continue;
    }
    if (ch === '(') {
      parens.push(lastSig === 'value' && JS_CONTROL_HEADERS.has(lastWord));
      lastSig = 'op';
    } else if (ch === ')') {
      lastSig = parens.pop() ? 'op' : 'value';
    } else {
      lastSig = ch === '}' ? 'close' : ch === ']' ? 'value' : 'op';
    }
    lastWord = '';
    i++;
  }
  return frames.length === 1 && !continued;
}

function pythonStringEnd(text, i, prefix) {
  const quote = text[i];
  const triple = text[i + 1] === quote && text[i + 2] === quote;
  const fString = prefix.toLowerCase().includes('f');
  let depth = 0;
  for (let j = i + (triple ? 3 : 1); j < text.length; j++) {
    const ch = text[j];
    if (fString && depth > 0) {
      if (ch === '{') {
        depth++;
      } else if (ch === '}') {
        depth--;
      } else if ((ch === '"' || ch === "'") && ch !== quote) {
        let k = j + 1;
        while (k < text.length && text[k] !== ch) {
          if (text[k] === quote || text[k] === '\\' || isNewline(text[k])) return -1;
          k++;
        }
        if (k >= text.length) return -1;
        j = k;
      } else if (ch === quote || ch === '#' || ch === '\\' || isNewline(ch)) {
        return -1;
      }
      continue;
    }
    if (ch === '\\') {
      j++;
      if (text[j] === '\r' && text[j + 1] === '\n') j++;
    } else if (fString && ch === '{') {
      if (text[j + 1] === '{') j++;
      else depth = 1;
    } else if (isNewline(ch) && !triple) {
      return -1;
    } else if (ch === quote && (!triple || (text[j + 1] === quote && text[j + 2] === quote))) {
      return j + (triple ? 3 : 1);
    }
  }
  return -1;
}

function pythonStartsFresh(text) {
  let lineEnd = '';
  let continued = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (isNewline(ch)) {
      continued = lineEnd === '\\';
      lineEnd = '';
      i++;
    } else if (isSpace(ch)) {
      i++;
    } else if (ch === '#') {
      i = lineEndAt(text, i);
    } else if (ch === '"' || ch === "'") {
      const start = wordStart(text, i);
      const prefix = text.slice(start, i);
      if (prefix.length > 2 || /[^rbuf]/i.test(prefix)) return false;
      const end = pythonStringEnd(text, i, prefix);
      if (end === -1) return false;
      lineEnd = ch;
      i = end;
    } else {
      lineEnd = ch;
      i++;
    }
  }
  return !continued;
}

function heredocDelimiter(text, i) {
  let j = i + 2;
  const stripTabs = text[j] === '-';
  if (stripTabs) j++;
  while (isBlank(text[j])) j++;
  let word = '';
  while (j < text.length && !isBlank(text[j]) && !isNewline(text[j]) && !';|&<>()'.includes(text[j])) {
    if (!'\'"\\'.includes(text[j])) word += text[j];
    j++;
  }
  return word ? { word, stripTabs, end: j } : null;
}

function skipHeredocs(text, i, pending) {
  let at = i;
  for (const doc of pending) {
    for (;;) {
      if (at >= text.length) return -1;
      const end = lineEndAt(text, at);
      let line = text.slice(at, end);
      if (doc.stripTabs) line = line.replace(/^\t+/, '');
      at = end + (text[end] === '\r' && text[end + 1] === '\n' ? 2 : 1);
      if (line === doc.word) break;
    }
  }
  return at;
}

const MAX_NESTING = 8;

function shSingleQuoteEnd(text, i) {
  if (text[i - 1] === '$') return quotedEnd(text, i, "'", true);
  return text.indexOf("'", i + 1) + 1 || -1;
}

function shSubstitutionEnd(text, i, level) {
  if (level > MAX_NESTING) return -1;
  let depth = 0;
  for (let j = i + 1; j < text.length; j++) {
    const ch = text[j];
    if (ch === '\\') {
      j++;
    } else if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      depth--;
      if (depth === 0) return j + 1;
    } else if (ch === "'" || ch === '"') {
      const end = ch === "'" ? shSingleQuoteEnd(text, j) : shDoubleQuoteScan(text, j, level + 1);
      if (end === -1) return -1;
      j = end - 1;
    } else if (ch === '`' || (ch === '<' && text[j + 1] === '<') || (ch === '#' && hashStartsComment(text, j) !== false)) {
      return -1;
    } else if (ch === 'c' && text.startsWith('case', j) && !isIdentChar(text[j - 1]) && !isIdentChar(text[j + 4])) {
      return -1;
    }
  }
  return -1;
}

function shDoubleQuoteScan(text, i, level) {
  for (let j = i + 1; j < text.length; j++) {
    const ch = text[j];
    if (ch === '"') return j + 1;
    if (ch === '\\') {
      j++;
    } else if (ch === '`') {
      return -1;
    } else if (ch === '$' && text[j + 1] === '(') {
      const end = shSubstitutionEnd(text, j, level);
      if (end === -1) return -1;
      j = end - 1;
    } else if (ch === '$' && text[j + 1] === '{') {
      const close = text.indexOf('}', j + 2);
      if (close === -1 || /["'\n\r]/.test(text.slice(j + 2, close))) return -1;
      j = close;
    }
  }
  return -1;
}

function shStartsFresh(text) {
  if (hasLoneCarriageReturn(text)) return false;
  const pending = [];
  let lineEnd = '';
  let continued = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (isNewline(ch)) {
      continued = lineEnd === '\\';
      lineEnd = '';
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1;
      if (pending.length > 0) {
        i = skipHeredocs(text, i, pending);
        if (i === -1) return false;
        pending.length = 0;
      }
      continue;
    }
    if (isBlank(ch)) {
      i++;
      continue;
    }
    lineEnd = ch;
    if (ch === '\\') {
      i += isNewline(text[i + 1]) ? 1 : 2;
    } else if (ch === "'") {
      const end = shSingleQuoteEnd(text, i);
      if (end === -1) return false;
      i = end;
    } else if (ch === '"') {
      const end = shDoubleQuoteScan(text, i, 0);
      if (end === -1) return false;
      i = end;
    } else if (ch === '`') {
      const end = text.indexOf('`', i + 1);
      if (end === -1 || /['"\\#\n\r]/.test(text.slice(i + 1, end))) return false;
      i = end + 1;
    } else if (ch === '#') {
      const starts = hashStartsComment(text, i);
      if (starts === null) return false;
      i = starts ? lineEndAt(text, i) : i + 1;
      if (starts) lineEnd = '';
    } else if (ch === '<' && text[i + 1] === '<') {
      if (text[i + 2] === '<') {
        i += 3;
        continue;
      }
      const doc = heredocDelimiter(text, i);
      if (!doc) return false;
      pending.push(doc);
      i = doc.end;
    } else {
      i++;
    }
  }
  return !continued && pending.length === 0;
}

function psSingleQuoteEnd(text, i) {
  for (let j = i + 1; j < text.length; j++) {
    if (text[j] !== "'") continue;
    if (text[j + 1] !== "'") return j + 1;
    j++;
  }
  return -1;
}

function psSubexpressionEnd(text, i, level) {
  if (level > MAX_NESTING) return -1;
  let depth = 0;
  for (let j = i + 1; j < text.length; j++) {
    const ch = text[j];
    if (ch === '`') {
      j++;
    } else if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      depth--;
      if (depth === 0) return j + 1;
    } else if (ch === "'" || ch === '"') {
      const end = ch === "'" ? psSingleQuoteEnd(text, j) : psDoubleQuoteScan(text, j, level + 1);
      if (end === -1) return -1;
      j = end - 1;
    } else if (ch === '#' || (ch === '@' && (text[j + 1] === '"' || text[j + 1] === "'"))) {
      return -1;
    }
  }
  return -1;
}

function psDoubleQuoteScan(text, i, level) {
  for (let j = i + 1; j < text.length; j++) {
    const ch = text[j];
    if (ch === '`') {
      j++;
    } else if (ch === '$' && text[j + 1] === '(') {
      const end = psSubexpressionEnd(text, j, level);
      if (end === -1) return -1;
      j = end - 1;
    } else if (ch === '"') {
      if (text[j + 1] !== '"') return j + 1;
      j++;
    }
  }
  return -1;
}

function psStartsFresh(text) {
  if (PS_SMART_QUOTES.test(text)) return false;
  let lineEnd = '';
  let continued = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (isNewline(ch)) {
      continued = lineEnd === '`';
      lineEnd = '';
      i++;
      continue;
    }
    if (isBlank(ch)) {
      i++;
      continue;
    }
    lineEnd = ch;
    if (ch === '`') {
      i += isNewline(next) ? 1 : 2;
    } else if (ch === '@' && (next === '"' || next === "'")) {
      const open = lineEndAt(text, i);
      if (text.slice(i + 2, open).trim() !== '') return false;
      let at = open;
      let found = -1;
      while (at < text.length) {
        at += text[at] === '\r' && text[at + 1] === '\n' ? 2 : 1;
        if (text.startsWith(`${next}@`, at)) {
          found = at + 2;
          break;
        }
        at = lineEndAt(text, at);
      }
      if (found === -1) return false;
      i = found;
    } else if (ch === "'" || ch === '"') {
      const end = ch === "'" ? psSingleQuoteEnd(text, i) : psDoubleQuoteScan(text, i, 0);
      if (end === -1) return false;
      i = end;
    } else if (ch === '<' && next === '#') {
      if (!psHashStartsComment(text, i)) return false;
      const end = text.indexOf('#>', i + 2);
      if (end === -1) return false;
      i = end + 2;
      lineEnd = '';
    } else if (ch === '#') {
      if (psHashStartsComment(text, i)) {
        i = lineEndAt(text, i);
        lineEnd = '';
      } else if (isIdentChar(text[i - 1]) || '-.:'.includes(text[i - 1])) {
        i++;
      } else {
        return false;
      }
    } else {
      i++;
    }
  }
  return !continued;
}

function batchStartsFresh(text) {
  const lines = text.split(/\r\n|\r|\n/);
  const last = lines.length > 1 ? lines[lines.length - 2] : '';
  return !last.endsWith('^');
}

function lineStartOf(text, i) {
  let start = i;
  while (start > 0 && !isNewline(text[start - 1])) start--;
  return start;
}

function windowStart(text, at) {
  const start = lineStartOf(text, at);
  if (start === 0) return 0;
  let end = start - 1;
  if (text[end] === '\n' && text[end - 1] === '\r') end--;
  return lineStartOf(text, end);
}

function windowEnd(text, at) {
  const end = lineEndAt(text, at);
  if (end >= text.length) return text.length;
  return end + (text[end] === '\r' && text[end + 1] === '\n' ? 2 : 1);
}

function occurrences(text, needle, replaceAll) {
  const first = text.indexOf(needle);
  if (first === -1) return null;
  let last = first;
  for (let at = text.indexOf(needle, first + needle.length); at !== -1; at = text.indexOf(needle, at + needle.length)) {
    if (!replaceAll) return null;
    last = at;
  }
  return { first, last };
}

function trivialInFile(pairs, fileText, spec) {
  if (typeof fileText !== 'string' || fileText.length > MAX_FILE_CHARS || !spec.startsFresh) return false;
  if (spec.flavor === 'go' && fileText.includes('"C"')) return false;
  let text = fileText;
  let work = 0;
  for (const [oldString, newString, replaceAll] of pairs) {
    if (!oldString || REPLACEMENT_PATTERN.test(newString)) return false;
    const found = occurrences(text, oldString, replaceAll);
    if (!found) return false;
    const start = windowStart(text, found.first);
    const end = windowEnd(text, found.last + oldString.length);
    work += start + 2 * (end - start);
    if (end - start > MAX_WINDOW_CHARS || work > MAX_CONTEXT_WORK || !spec.startsFresh(text.slice(0, start), spec)) return false;
    const before = text.slice(start, end);
    const after = replaceAll
      ? before.split(oldString).join(newString)
      : `${text.slice(start, found.first)}${newString}${text.slice(found.first + oldString.length, end)}`;
    if (!isTrivialEdit(before, after, spec)) return false;
    text = `${text.slice(0, start)}${after}${text.slice(end)}`;
    if (text.length > MAX_FILE_CHARS) return false;
  }
  return true;
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
    pairs.push([oldString, newString, entry.replace_all === true]);
  }
  return { sides: pairs.flatMap(([oldString, newString]) => [oldString, newString]), pairs };
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

/** Profile of one target's change from Edit/MultiEdit entries or Write content, judged against `fileText` when given; unknown on any doubt. */
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
    const trivial = input.tool === 'Edit' && trivialInFile(texts.pairs, input.fileText, lexSpecFor(input.filePath, language));
    return Object.freeze({ known: true, language, touchesPublicSurface, touchesData, trivial });
  } catch (_) {
    return UNKNOWN_PROFILE;
  }
}

module.exports = { MAX_SIDE_BYTES, MAX_TOTAL_BYTES, MAX_EDITS, UNKNOWN_PROFILE, languageFor, profileChange };
