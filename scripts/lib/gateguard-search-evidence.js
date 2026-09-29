'use strict';

const fs = require('fs');
const path = require('path');
const { WINDOWS_PATH_PATTERN } = require('./gateguard-target-class');
const { excludedBatchId } = require('./gateguard-turn-scan');

// --- Prior-search credit ---
// `Read` never counts: Claude Code already requires a Read before an Edit, so
// crediting it would disable the Edit gate. Any ambiguity or failure means no credit.

const SHELL_SEARCH_COMMANDS = new Set([
  'rg',
  'grep',
  'egrep',
  'fgrep',
  'git',
  'find',
  'fd',
  'ls',
  'tree',
  'get-childitem',
  'gci',
  'select-string',
  'sls'
]);
const GIT_SEARCH_SUBCOMMANDS = new Set(['grep', 'ls-files']);
const DIRECTORY_CHANGE_COMMANDS = new Set(['cd', 'pushd', 'popd', 'chdir', 'set-location', 'sl', 'push-location', 'pop-location']);
// Search kinds whose first positional argument is the pattern, not a path.
const PATTERN_FIRST_SEARCHES = new Set(['grep', 'egrep', 'fgrep', 'rg', 'git grep', 'select-string', 'sls', 'fd']);
const RECURSIVE_BY_DEFAULT = new Set(['rg', 'git grep', 'git ls-files', 'find', 'fd', 'tree']);
const GREP_FAMILY = new Set(['grep', 'egrep', 'fgrep']);
const POWERSHELL_SEARCHES = new Set(['get-childitem', 'gci', 'select-string', 'sls']);
// Flags whose value is the search pattern (so the first positional is a path).
const PATTERN_VALUE_FLAGS = new Set(['-e', '-f', '--regexp', '--file']);
// Flags that consume the next argument; that argument is never a path operand.
const VALUE_FLAGS = new Set([
  '-e', '-f', '-g', '-t', '-T', '-m', '-A', '-B', '-C',
  '--regexp', '--file', '--type', '--glob', '--iglob', '--include', '--exclude', '--exclude-dir', '--exclude-from',
  '--ignore-file', '--max-count', '--replace',
  '-name', '-iname', '-path', '-ipath', '-type', '-maxdepth', '-mindepth', '-newer', '-regex', '-size', '-user', '-group', '-perm'
]);
// PowerShell parameters are case-insensitive. -Path/-LiteralPath values are paths
// (they count as operands for the stdin/target-only checks) but never directory evidence.
const LS_VALUE_FLAGS = new Set(['-I', '--ignore', '--hide']);
const TREE_VALUE_FLAGS = new Set(['-L', '-P', '-I', '-o']);
// fd: `-E/--exclude <glob>` take a value (fd's `-e` is an extension, also a value).
const FD_VALUE_FLAGS = new Set([...VALUE_FLAGS, '-E']);
// Only these tools take the search pattern from -e/-f (fd's -e is an extension).
const PATTERN_FLAG_SEARCHES = new Set(['grep', 'egrep', 'fgrep', 'rg', 'git grep']);
const POWERSHELL_VALUE_FLAGS = new Set(['-path', '-literalpath', '-depth', '-pattern']);
const POWERSHELL_PATH_FLAGS = new Set(['-path', '-literalpath']);
// PowerShell binds a parameter by any unambiguous prefix, `-Name:value`, and comma lists across arguments.
const POWERSHELL_FILTER_PARAMS = new Set(['filter', 'include', 'exclude']);
const POWERSHELL_COMMON_PARAMS = [
  'verbose', 'debug', 'erroraction', 'warningaction', 'informationaction', 'progressaction',
  'errorvariable', 'warningvariable', 'informationvariable', 'outvariable', 'outbuffer', 'pipelinevariable'
];
const POWERSHELL_CHILDITEM_PARAMS = [
  'path', 'literalpath', 'filter', 'include', 'exclude', 'recurse', 'depth', 'force', 'name',
  'attributes', 'directory', 'file', 'hidden', 'readonly', 'system', 'followsymlink'
];
const POWERSHELL_SELECTSTRING_PARAMS = [
  'pattern', 'path', 'literalpath', 'inputobject', 'simplematch', 'casesensitive', 'quiet', 'list', 'noemphasis',
  'include', 'exclude', 'notmatch', 'allmatches', 'encoding', 'context', 'raw', 'culture'
];
const POWERSHELL_PARAM_ALIASES = new Set([
  's', 'ad', 'd', 'af', 'ah', 'h', 'ar', 'as', 'lp', 'pspath',
  'vb', 'db', 'ea', 'wa', 'infa', 'proga', 'ev', 'wv', 'iv', 'ov', 'ob', 'pv'
]);
const GENERIC_STEMS = new Set([
  'index',
  'main',
  'init',
  '__init__',
  'utils',
  'util',
  'types',
  'readme',
  'test',
  'tests',
  'config',
  'mod',
  'lib',
  'setup',
  'app',
  'spec',
  'helpers',
  'common'
]);
const MIN_STEM_LENGTH = 4;
const MAX_SEARCH_COMMAND_CHARS = 8192;
// Command substitution, process substitution, heredocs and PowerShell
// backtick escapes make the searched text ambiguous: never credit them.
const AMBIGUOUS_SHELL_PATTERN = /`|\$\(|[<>]\(|<</;
const GLOB_CHARS_PATTERN = /[*?[{]/;

function eligibleStem(filePath) {
  const base = String(filePath).split(/[\\/]/).pop() || '';
  const ext = path.posix.extname(base);
  const stem = (ext ? base.slice(0, -ext.length) : base).toLowerCase();
  return stem.length >= MIN_STEM_LENGTH && !GENERIC_STEMS.has(stem) ? stem : null;
}

/** Word-boundary stem matcher; an indexOf scan, never a RegExp built from untrusted text. */
function stemMatcher(stem) {
  if (!stem) return null;
  return { test: text => containsWord(String(text), stem) };
}

function isStemWordChar(ch) {
  return ch !== undefined && ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9'));
}

function containsWord(text, word) {
  for (let at = text.indexOf(word); at !== -1; at = text.indexOf(word, at + 1)) {
    if (!isStemWordChar(text[at - 1]) && !isStemWordChar(text[at + word.length])) return true;
  }
  return false;
}

/** Path-resolution context for a target; relative paths resolve against the tool `cwd`. */
function dirContext(targetPath, data) {
  const base = (data && typeof data.cwd === 'string' && data.cwd) || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const isWin = WINDOWS_PATH_PATTERN.test(base) || WINDOWS_PATH_PATTERN.test(targetPath);
  const paths = isWin ? path.win32 : path.posix;
  if (!paths.isAbsolute(base)) return null;
  const resolveNative = (...parts) => paths.resolve(base, ...parts);
  const resolveDir = (...parts) => {
    const dir = resolveNative(...parts).replace(/\\/g, '/');
    return isWin ? dir.toLowerCase() : dir;
  };
  const targetKey = resolveDir(targetPath);
  return { resolveDir, resolveNative, targetKey, targetDir: path.posix.dirname(targetKey) };
}

function isInsideDir(targetKey, dirKey) {
  return targetKey.startsWith(dirKey.endsWith('/') ? dirKey : `${dirKey}/`);
}

function isDirectoryNow(nativePath) {
  try {
    return fs.statSync(nativePath).isDirectory();
  } catch (_) {
    return false;
  }
}

function globLiteralPrefix(pattern) {
  const segments = pattern.split(/[\\/]/);
  const firstGlob = segments.findIndex(segment => GLOB_CHARS_PATTERN.test(segment));
  const literal = firstGlob === -1 ? segments.slice(0, -1) : segments.slice(0, firstGlob);
  const joined = literal.join('/');
  return joined || (literal.length > 0 && pattern.startsWith('/') ? '/' : '');
}

function stringsOf(...values) {
  return values.filter(value => typeof value === 'string' && value);
}

/** Base for relative operands after a directory change; null unless it is a plain literal `cd <dir>`. */
function baseAfterDirectoryChange(base, lead, tokens) {
  if (!['cd', 'chdir', 'set-location', 'sl'].includes(lead) || tokens.length !== 2) return null;
  const dir = tokens[1];
  if (!dir || /^[-$~]/.test(dir) || GLOB_CHARS_PATTERN.test(dir)) return null;
  if (isAbsoluteShellPath(dir)) return [dir];
  return base === null ? null : base.concat(dir);
}

function isAbsoluteShellPath(arg) {
  return path.posix.isAbsolute(arg) || WINDOWS_PATH_PATTERN.test(arg);
}

function operandScopePath(arg) {
  if (!GLOB_CHARS_PATTERN.test(arg)) return arg;
  const segments = arg.split(/[\\/]/);
  const literal = segments.slice(0, segments.findIndex(segment => GLOB_CHARS_PATTERN.test(segment)));
  if (literal.length === 0) return '.';
  return literal.join('/') || '/';
}

/** Scopes a shell segment searched; unresolvable operands (variables, `~`, unknown cwd) scope nothing. */
function shellSearchScopes(parsed, base) {
  if (parsed.operands.length === 0) return base === null ? [] : [base];
  const scopes = [];
  for (const operand of parsed.operands) {
    if (!operand || operand === '-' || /^[$~]/.test(operand)) continue;
    const scoped = operandScopePath(operand);
    if (isAbsoluteShellPath(scoped)) scopes.push([scoped]);
    else if (base !== null) scopes.push(base.concat(scoped));
  }
  return scopes;
}

function isRecursiveFlag(kind, arg) {
  const lower = arg.toLowerCase();
  if (POWERSHELL_SEARCHES.has(kind)) return (kind === 'get-childitem' || kind === 'gci') && lower.startsWith('-rec');
  if (arg === '--recursive' || arg === '--dereference-recursive') return GREP_FAMILY.has(kind) || kind === 'ls';
  if (!/^-[a-zA-Z]+$/.test(arg)) return false;
  if (GREP_FAMILY.has(kind)) return /[rR]/.test(arg);
  return kind === 'ls' && arg.includes('R');
}

function valueFlagsFor(kind) {
  if (kind === 'ls' || kind === 'git ls-files') return LS_VALUE_FLAGS;
  if (kind === 'tree') return TREE_VALUE_FLAGS;
  if (kind === 'fd') return FD_VALUE_FLAGS;
  return VALUE_FLAGS;
}

/** Arguments a flag consumes; single-dash clusters (`-rne PAT`) are read letter by letter. */
function flagEffect(kind, args, i) {
  const arg = args[i];
  if (POWERSHELL_SEARCHES.has(kind)) {
    const lower = arg.toLowerCase();
    const filter = powershellFilterArg(kind, args, i);
    const consumes = filter ? filter.end - i : POWERSHELL_VALUE_FLAGS.has(lower) ? 1 : 0;
    return { consumes, patternFlag: lower === '-pattern', pathFlag: POWERSHELL_PATH_FLAGS.has(lower) };
  }
  const values = valueFlagsFor(kind);
  const takesValue = flag => values.has(flag) || (kind === 'rg' && (flag === '-r' || flag === '--replace'));
  const isPatternFlag = flag => PATTERN_FLAG_SEARCHES.has(kind) && PATTERN_VALUE_FLAGS.has(flag);
  const name = arg.split('=')[0];
  if (arg.startsWith('--') || kind === 'find' || takesValue(arg)) {
    return { consumes: !arg.includes('=') && takesValue(name) ? 1 : 0, patternFlag: isPatternFlag(name), pathFlag: false };
  }
  for (let i = 1; i < arg.length; i++) {
    const flag = `-${arg[i]}`;
    if (takesValue(flag)) return { consumes: i === arg.length - 1 ? 1 : 0, patternFlag: isPatternFlag(flag), pathFlag: false };
  }
  return { consumes: 0, patternFlag: false, pathFlag: false };
}

/** Path operands of a search command, skipping flag values and the pattern positional. */
function parseSearchArgs(kind, args) {
  const positionals = [];
  const pathValues = [];
  let recursive = RECURSIVE_BY_DEFAULT.has(kind);
  let patternGiven = false;
  let expressionStarted = false;
  let inputRedirect = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (/^\d*[<>]/.test(arg)) {
      inputRedirect = /^\d*</.test(arg);
      break;
    }
    if (arg.includes('<')) {
      inputRedirect = true; // a quoted `<` cannot be told from a redirection
      break;
    }
    if (arg.length > 1 && arg.startsWith('-')) {
      expressionStarted = true;
      if (isRecursiveFlag(kind, arg)) recursive = true;
      const effect = flagEffect(kind, args, i);
      if (effect.patternFlag) patternGiven = true;
      if (effect.pathFlag && i + 1 < args.length) pathValues.push(args[i + 1]);
      i += effect.consumes;
      continue;
    }
    if (kind === 'find' && (expressionStarted || arg === '(' || arg === '!')) {
      expressionStarted = true;
      continue;
    }
    positionals.push(arg);
  }
  const dirOperands = PATTERN_FIRST_SEARCHES.has(kind) && !patternGiven ? positionals.slice(1) : positionals;
  const operands = dirOperands.concat(pathValues);
  return { operands, dirOperands, recursive, stdin: inputRedirect && operands.length === 0 };
}

function shellDirCandidate(arg) {
  if (!arg || /^[$~]/.test(arg)) return '';
  const dir = arg.replace(/(?:[\\/]\*\*|[\\/]\*|[\\/])+$/, '');
  if (!dir || dir === '.' || GLOB_CHARS_PATTERN.test(dir)) return '';
  return dir;
}

function evidenceInScope(item, ctx) {
  if (item.scopes) {
    const covers = parts => {
      const scope = ctx.resolveDir(...parts);
      return scope === ctx.targetKey || isInsideDir(ctx.targetKey, scope);
    };
    if (!item.scopes.some(covers)) return false;
  }
  if (item.scope) {
    const scope = ctx.resolveDir(...item.scope);
    if (scope === ctx.targetKey || !isInsideDir(ctx.targetKey, scope)) return false;
    if (item.scopeExact && ctx.targetDir !== scope) return false;
  }
  if (item.operands && item.operands.length > 0 && item.operands.every(parts => ctx.resolveDir(...parts) === ctx.targetKey)) {
    return false; // reading the target itself is not a search
  }
  return true;
}

function evidenceNamesDir(item, ctx) {
  return item.dirs.some(
    parts => ctx.resolveDir(...parts) === ctx.targetDir && (!item.dirsMustExist || isDirectoryNow(ctx.resolveNative(...parts)))
  );
}

// --- Search filters ---
// A search that excluded the target never saw it, so exclusions are never a stem
// source and one covering the target blocks credit; unreadable exclusion lists
// block it too. Globs are matched without RegExp and bounded; past the bounds they cover the target.

const MAX_FILTER_GLOB_CHARS = 256;
const MAX_BRACE_ALTERNATIVES = 32;
const MAX_FILTERS_PER_SEARCH = 32;
const FIND_NAME_FLAGS = new Set(['-name', '-iname', '-path', '-ipath', '-wholename', '-iwholename', '-regex', '-iregex']);
const FIND_BASENAME_FLAGS = new Set(['-name', '-iname']);
const OPAQUE_FILTER_FLAGS = new Set(['--exclude-from', '--ignore-file', '--exclude-per-directory']);
const EXCLUDE_LONG_FLAGS = new Set(['--exclude', '--exclude-dir', '--ignore', '--hide']);
const LS_ONLY_EXCLUDE_FLAGS = new Set(['--ignore', '--hide']);
const GIT_EXCLUDE_PATHSPEC = /^:(?:[!^]|\([^)]*\bexclude\b[^)]*\))/;

function splitTopLevelCommas(value) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const ch of String(value)) {
    if (ch === '{') depth += 1;
    else if (ch === '}' && depth > 0) depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts.map(part => part.trim()).filter(Boolean);
}

function expandBraces(glob) {
  const open = glob.indexOf('{');
  if (open === -1) return [glob];
  let depth = 0;
  for (let i = open; i < glob.length; i++) {
    if (glob[i] === '{') depth += 1;
    else if (glob[i] === '}' && --depth === 0) {
      const head = glob.slice(0, open);
      const tail = glob.slice(i + 1);
      const results = [];
      for (const option of splitTopLevelCommas(glob.slice(open + 1, i)).concat(glob[open + 1] === ',' ? [''] : [])) {
        const expanded = expandBraces(`${head}${option}${tail}`);
        if (!expanded) return null;
        results.push(...expanded);
        if (results.length > MAX_BRACE_ALTERNATIVES) return null;
      }
      return results;
    }
  }
  return [glob]; // unbalanced: `{` is literal
}

function globTokens(glob) {
  const tokens = [];
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*' && glob[i + 1] === '*') {
      const dirs = glob[i + 2] === '/';
      tokens.push({ type: dirs ? 'dirs' : 'deep' });
      i += dirs ? 2 : 1;
    } else if (ch === '*') {
      tokens.push({ type: 'star' });
    } else if (ch === '?') {
      tokens.push({ type: 'one' });
    } else if (ch === '[') {
      const parsed = bracketClass(glob, i);
      if (!parsed) return null;
      tokens.push(parsed.token);
      i = parsed.end;
    } else {
      tokens.push({ type: 'lit', ch });
    }
  }
  return tokens;
}

/** `[...]` with members, ranges, `!`/`^` negation and a leading literal `]`; null when unclosed. */
function bracketClass(glob, open) {
  let i = open + 1;
  const negated = glob[i] === '!' || glob[i] === '^';
  if (negated) i += 1;
  const ranges = [];
  for (let first = true; i < glob.length && (first || glob[i] !== ']'); first = false) {
    if (glob[i + 1] === '-' && i + 2 < glob.length && glob[i + 2] !== ']') {
      ranges.push([glob[i], glob[i + 2]]);
      i += 3;
    } else {
      ranges.push([glob[i], glob[i]]);
      i += 1;
    }
  }
  if (i >= glob.length) return null;
  return { token: { type: 'class', negated, ranges }, end: i };
}

function classMatches(token, ch) {
  if (ch === '/') return false;
  const forms = [ch, ch.toLowerCase(), ch.toUpperCase()];
  const member = token.ranges.some(([lo, hi]) => forms.some(form => form >= lo && form <= hi));
  return member !== token.negated;
}

/** Glob match by dynamic programming, so a hostile glob cannot cause regex backtracking; null when malformed. */
function wildcardMatch(glob, text) {
  const tokens = globTokens(glob);
  if (!tokens) return null;
  const n = text.length;
  let next = new Array(n + 1).fill(false);
  next[n] = true;
  for (let t = tokens.length - 1; t >= 0; t--) {
    const token = tokens[t];
    const row = new Array(n + 1).fill(false);
    let afterSlash = false; // for 'dirs': some k > j with text[k-1] === '/' and next[k]
    for (let j = n; j >= 0; j--) {
      if (token.type === 'lit') row[j] = j < n && text[j] === token.ch && next[j + 1];
      else if (token.type === 'one') row[j] = j < n && text[j] !== '/' && next[j + 1];
      else if (token.type === 'class') row[j] = j < n && classMatches(token, text[j]) && next[j + 1];
      else if (token.type === 'star') row[j] = next[j] || (j < n && text[j] !== '/' && row[j + 1]);
      else if (token.type === 'deep') row[j] = next[j] || (j < n && row[j + 1]);
      else {
        if (j < n && text[j] === '/' && next[j + 1]) afterSlash = true;
        row[j] = next[j] || afterSlash;
      }
    }
    next = row;
  }
  return next[0];
}

function normalizeFilterGlob(glob) {
  return String(glob).toLowerCase().replace(/\\/g, '/').replace(/^(?:\.\/)+/, '').replace(/^\/+/, '').replace(/\/+$/, '');
}

/** Null when the glob is past the length or brace bounds; a malformed alternative counts as `malformed`. */
function globMatches(glob, text, malformed) {
  if (glob.length > MAX_FILTER_GLOB_CHARS) return null;
  const alternatives = expandBraces(glob);
  if (!alternatives) return null;
  return alternatives.some(alternative => {
    const matched = wildcardMatch(alternative, text);
    return matched === null ? malformed : matched;
  });
}

function targetSegments(ctx) {
  return ctx.targetKey.toLowerCase().split('/').filter(Boolean);
}

/** An exclusion covers the target when it names the stem or matches the file or any directory above it. */
function exclusionCoversTarget(exclusion, segments, stem) {
  const glob = normalizeFilterGlob(exclusion);
  if (!glob) return true;
  if (stem !== null && stem.test(glob)) return true;
  for (let start = 0; start < segments.length; start++) {
    for (let end = start + 1; end <= segments.length; end++) {
      const matched = globMatches(glob, segments.slice(start, end).join('/'), true);
      if (matched !== false) return true;
    }
  }
  return false;
}

function filtersAdmitTarget(item, ctx, stem) {
  if (item.opaque) return false;
  const exclusions = Array.isArray(item.exclusions) ? item.exclusions : [];
  if (exclusions.length === 0) return true;
  if (exclusions.length > MAX_FILTERS_PER_SEARCH) return false;
  const segments = targetSegments(ctx);
  return !exclusions.some(exclusion => exclusionCoversTarget(exclusion, segments, stem));
}

/** Basename include globs that all miss the target stop its stem from crediting; oversized globs admit, malformed ones do not. */
function includesAdmitTarget(item, ctx) {
  const includes = Array.isArray(item.includes) ? item.includes : [];
  if (includes.length === 0) return true;
  const segments = targetSegments(ctx);
  const base = segments[segments.length - 1] || '';
  return includes.some(include => globMatches(normalizeFilterGlob(include).replace(/^(?:\*\*\/)+/, ''), base, false) !== false);
}

function isBasenameGlob(glob) {
  return !/[\\/]/.test(String(glob).replace(/^(?:\*\*[\\/])+/, ''));
}

function grepToolFilters(glob) {
  const filters = { positives: [], includes: [], exclusions: [], opaque: false };
  if (typeof glob !== 'string' || !glob) return filters;
  for (const part of splitTopLevelCommas(glob)) {
    if (part.startsWith('!')) filters.exclusions.push(part.slice(1));
    else {
      filters.positives.push(part);
      if (isBasenameGlob(part)) filters.includes.push(part);
    }
  }
  return filters;
}

function shellSearchFilters(kind, args) {
  const filters = { exclusions: [], includes: [], opaque: false, dropped: new Set() };
  if (kind === 'find') return findSearchFilters(args, filters);
  if (POWERSHELL_SEARCHES.has(kind)) return powershellSearchFilters(kind, args, filters);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (/^\d*[<>]/.test(arg)) break;
    const consumed = applyShellFilterArg(kind, args, i, filters);
    i += consumed;
  }
  return filters;
}

function applyShellFilterArg(kind, args, i, filters) {
  const arg = args[i];
  const exclude = (value, indexes, separator) => {
    for (const glob of separator ? String(value).split(separator) : [value]) {
      if (glob) filters.exclusions.push(glob);
    }
    indexes.forEach(index => filters.dropped.add(index));
  };
  const include = value => {
    if (isBasenameGlob(value)) filters.includes.push(value);
  };
  if (kind.startsWith('git ') && GIT_EXCLUDE_PATHSPEC.test(arg)) {
    exclude(arg.replace(GIT_EXCLUDE_PATHSPEC, ''), [i]);
    return 0;
  }
  if (arg.startsWith('--')) {
    const eq = arg.indexOf('=');
    const name = eq > 0 ? arg.slice(0, eq) : arg;
    const hasNext = eq <= 0 && i + 1 < args.length;
    const value = eq > 0 ? arg.slice(eq + 1) : hasNext ? args[i + 1] : '';
    const indexes = eq > 0 || !hasNext ? [i] : [i, i + 1];
    const consumed = indexes.length - 1;
    if (OPAQUE_FILTER_FLAGS.has(name)) {
      filters.opaque = true;
      return consumed;
    }
    if (name === '--glob' || name === '--iglob') {
      if (value.startsWith('!')) exclude(value.slice(1), indexes);
      else include(value);
      return consumed;
    }
    if (name === '--include') {
      include(value);
      return consumed;
    }
    // `--ignore`/`--hide` hide names only for ls (rg's `--ignore` is a switch).
    if (EXCLUDE_LONG_FLAGS.has(name) && (kind === 'ls' || !LS_ONLY_EXCLUDE_FLAGS.has(name))) {
      exclude(value, indexes);
      return consumed;
    }
    return 0;
  }
  if (!/^-[A-Za-z]/.test(arg)) return 0;
  const letters = shortFilterLetters(kind);
  const valueFlags = valueFlagsFor(kind);
  for (let k = 1; k < arg.length; k++) {
    const letter = arg[k];
    if (!letters.has(letter)) {
      // Another value flag ends the cluster: the rest (or the next argument) is its value.
      if (valueFlags.has(`-${letter}`)) return k === arg.length - 1 ? 1 : 0;
      continue;
    }
    const attached = arg.slice(k + 1);
    const value = attached || args[i + 1] || '';
    const indexes = attached || i + 1 >= args.length ? [i] : [i, i + 1];
    const consumed = indexes.length - 1;
    applyShortFilter(kind, letter, value, indexes, { filters, exclude, include });
    return consumed;
  }
  return 0;
}

function shortFilterLetters(kind) {
  if (kind === 'rg') return new Set(['g']);
  if (kind === 'fd') return new Set(['E']);
  if (kind === 'ls') return new Set(['I']);
  if (kind === 'tree') return new Set(['I', 'P']);
  if (kind === 'git ls-files') return new Set(['x', 'X']);
  return new Set();
}

function applyShortFilter(kind, letter, value, indexes, { filters, exclude, include }) {
  if (kind === 'rg') {
    if (value.startsWith('!')) exclude(value.slice(1), indexes);
    else include(value);
  } else if (kind === 'tree' && letter === 'P') {
    value.split('|').forEach(include);
  } else if (kind === 'git ls-files' && letter === 'X') {
    filters.opaque = true;
  } else {
    exclude(value, indexes, kind === 'tree' ? '|' : '');
  }
}

/** find: a negated or pruned name test is an exclusion; a plain `-name`/`-iname` is an include. */
function findSearchFilters(args, filters) {
  let negateNext = false;
  let negatedDepth = 0;
  let depth = 0;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (/^\d*[<>]/.test(arg)) break;
    if (arg === '-not' || arg === '!') {
      negateNext = true;
      filters.dropped.add(i);
      continue;
    }
    if (arg === '(') {
      depth += 1;
      if (negateNext && negatedDepth === 0) negatedDepth = depth;
      negateNext = false;
      continue;
    }
    if (arg === ')') {
      if (negatedDepth === depth) negatedDepth = 0;
      depth = Math.max(depth - 1, 0);
      continue;
    }
    if (FIND_NAME_FLAGS.has(arg) && i + 1 < args.length) {
      const value = args[i + 1];
      if (negateNext || negatedDepth > 0 || args[i + 2] === '-prune') {
        filters.exclusions.push(value);
        filters.dropped.add(i);
        filters.dropped.add(i + 1);
      } else if (FIND_BASENAME_FLAGS.has(arg)) {
        filters.includes.push(value);
      }
      i += 1;
    }
    negateNext = false;
  }
  return filters;
}

function powershellParam(kind, arg) {
  const colon = arg.indexOf(':');
  const spelled = (colon === -1 ? arg.slice(1) : arg.slice(1, colon)).toLowerCase();
  const inline = colon === -1 ? null : arg.slice(colon + 1);
  const own = kind === 'get-childitem' || kind === 'gci' ? POWERSHELL_CHILDITEM_PARAMS : POWERSHELL_SELECTSTRING_PARAMS;
  const params = own.concat(POWERSHELL_COMMON_PARAMS);
  if (!spelled) return { name: null, inline };
  if (params.includes(spelled) || POWERSHELL_PARAM_ALIASES.has(spelled)) return { name: spelled, inline };
  const matches = params.filter(param => param.startsWith(spelled));
  return { name: matches.length === 1 ? matches[0] : null, inline };
}

function powershellFilterArg(kind, args, i) {
  if (!/^-[A-Za-z]/.test(args[i])) return null;
  const { name, inline } = powershellParam(kind, args[i]);
  if (!POWERSHELL_FILTER_PARAMS.has(name)) return null;
  const first = inline ? i : i + 1;
  if (first >= args.length) return { name, globs: [], end: i };
  let end = first;
  while (end + 1 < args.length && (args[end].endsWith(',') || args[end + 1].startsWith(','))) end += 1;
  const parts = [inline || args[first]].concat(args.slice(first + 1, end + 1));
  return { name, globs: splitTopLevelCommas(parts.join(',')), end };
}

function powershellSearchFilters(kind, args, filters) {
  for (let i = 0; i < args.length; i++) {
    const filter = powershellFilterArg(kind, args, i);
    if (filter) {
      if (filter.name === 'exclude') {
        filters.exclusions.push(...filter.globs);
        for (let k = i; k <= filter.end; k++) filters.dropped.add(k);
      } else {
        filter.globs.filter(isBasenameGlob).forEach(glob => filters.includes.push(glob));
      }
      i = filter.end;
    } else if (/^-[A-Za-z]/.test(args[i]) && powershellParam(kind, args[i]).name === null) {
      // An unresolvable parameter may be an exclusion in disguise: neither it nor a value it may carry is a stem source.
      filters.dropped.add(i);
      if (!args[i].includes(':') && i + 1 < args.length && !args[i + 1].startsWith('-')) filters.dropped.add(i + 1);
    }
  }
  return filters;
}

/** Build the prior-search matcher around the hook's shell segmenter. */
function createSearchEvidence({ quoteAwareSegments, commandBasename, SHELL_SEGMENT_SEPARATORS }) {
  /**
   * Evidence a search offers: stem `texts`, candidate `dirs`, the `scope`/`scopes`
   * the target must lie in, and `operands` that must not all be the target itself.
   */
  function searchEvidence(search, shellDirsTrusted) {
    const input = search.input;
    if (search.name === 'Glob') {
      if (typeof input.pattern !== 'string' || !input.pattern) return [];
      const explicit = typeof input.path === 'string' && input.path ? input.path : '';
      const prefix = globLiteralPrefix(input.pattern);
      const scope = [explicit || '.', prefix || '.'];
      if (!GLOB_CHARS_PATTERN.test(input.pattern)) {
        // A single-file lookup names no directory, and looking up the target itself is not a search.
        const lookup = [explicit || '.', input.pattern];
        return [{ texts: [input.pattern], dirs: [], scope, scopeExact: true, operands: [lookup], detail: input.pattern }];
      }
      // An empty literal prefix with no explicit path names only the implicit cwd.
      const dirs = prefix || explicit ? [scope] : [];
      return [{ texts: [input.pattern], dirs, scope, detail: input.pattern }];
    }
    if (search.name === 'Grep') {
      if (typeof input.pattern !== 'string' || !input.pattern) return [];
      const explicit = typeof input.path === 'string' && input.path ? input.path : '';
      const detail = typeof input.glob === 'string' && input.glob ? `${input.pattern} --glob ${input.glob}` : input.pattern;
      const filters = grepToolFilters(input.glob);
      return [{
        texts: stringsOf(input.pattern, ...filters.positives),
        dirs: explicit ? [[explicit]] : [],
        scope: [explicit || '.'],
        detail,
        ...filters
      }];
    }
    if (search.name === 'LS') {
      return stringsOf(input.path).map(dir => ({ texts: [], dirs: [[dir]], scope: [dir], detail: dir }));
    }
    return shellSearchEvidence(input.command, shellDirsTrusted);
  }

  /**
   * Per segment, whether it reads piped input. Mirrors `quoteAwareSegments`
   * splitting; `||` also marks the next segment, which only ever removes evidence.
   */
  function segmentPipeFlags(input) {
    const flags = [];
    let quote = null;
    let escaped = false;
    let hasContent = false;
    let piped = false;
    for (const ch of String(input || '')) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
        hasContent = true;
      } else if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
        hasContent = true;
      } else if (SHELL_SEGMENT_SEPARATORS.has(ch)) {
        if (hasContent) {
          flags.push(piped);
          piped = false;
          hasContent = false;
        }
        piped = piped || ch === '|';
      } else if (!/\s/.test(ch)) {
        hasContent = true;
      }
    }
    if (hasContent) flags.push(piped);
    return flags;
  }

  /** Evidence for each search segment of a shell command; ambiguous or oversized commands yield none. */
  function shellSearchEvidence(command, dirsTrusted) {
    if (typeof command !== 'string' || !command || command.length > MAX_SEARCH_COMMAND_CHARS) return [];
    if (AMBIGUOUS_SHELL_PATTERN.test(command)) return [];
    const pipeFlags = segmentPipeFlags(command);
    const evidence = [];
    let trusted = dirsTrusted;
    // A cd in any other call of the turn leaves the cwd of this one unknown.
    let base = dirsTrusted ? [] : null;
    quoteAwareSegments(command).forEach((tokens, index) => {
      const lead = commandBasename(tokens[0]);
      if (DIRECTORY_CHANGE_COMMANDS.has(lead)) {
        trusted = false;
        base = baseAfterDirectoryChange(base, lead, tokens);
        return;
      }
      if (!SHELL_SEARCH_COMMANDS.has(lead)) return;
      let kind = lead;
      let args = tokens.slice(1);
      if (lead === 'git') {
        if (!GIT_SEARCH_SUBCOMMANDS.has(tokens[1])) return;
        kind = `git ${tokens[1]}`;
        args = tokens.slice(2);
      }
      const parsed = parseSearchArgs(kind, args);
      // A segment that reads stdin (redirection, pipe, or no operand without recursion) is not a tree search.
      if (parsed.stdin) return;
      if (parsed.operands.length === 0 && (!parsed.recursive || pipeFlags[index] !== false)) return;
      const scopes = shellSearchScopes(parsed, base);
      if (scopes.length === 0) return;
      const filters = shellSearchFilters(kind, args);
      // Exclusion values (and the flags that introduce them) are never a stem source.
      const stemText = tokens.slice(0, tokens.length - args.length).concat(args.filter((_, i) => !filters.dropped.has(i))).join(' ');
      const dirs = trusted ? parsed.dirOperands.map(shellDirCandidate).filter(Boolean).map(dir => [dir]) : [];
      evidence.push({
        texts: [stemText],
        dirs,
        dirsMustExist: true,
        scopes,
        operands: parsed.operands.map(op => [op]),
        detail: tokens.join(' '),
        exclusions: filters.exclusions,
        includes: filters.includes,
        opaque: filters.opaque
      });
    });
    return evidence;
  }

  /** A directory change anywhere in the turn makes relative shell paths unreliable. */
  function turnChangesDirectory(shellCommands) {
    if (!Array.isArray(shellCommands)) return false;
    return shellCommands.some(command => {
      if (typeof command !== 'string') return false;
      if (command.length > MAX_SEARCH_COMMAND_CHARS) return true;
      return quoteAwareSegments(command).some(tokens => DIRECTORY_CHANGE_COMMANDS.has(commandBasename(tokens[0])));
    });
  }

  /**
   * A completed search in the current turn that names the target by stem (or by
   * directory, for a new-file Write). Searches in the pending call's own batch
   * never count: their results were not seen when the edit was decided.
   */
  function findCreditingSearch(scan, targetPath, allowDirMatch, data) {
    try {
      if (!scan || !Array.isArray(scan.searches) || scan.searches.length === 0) return null;
      if (typeof targetPath !== 'string' || !targetPath) return null;
      const ctx = dirContext(targetPath, data);
      if (!ctx) return null;
      const stem = stemMatcher(eligibleStem(targetPath));
      const excluded = excludedBatchId(scan, data);
      const shellDirsTrusted = !turnChangesDirectory(scan.shellCommands);
      for (const search of scan.searches) {
        if (typeof search.messageId !== 'string' || !search.messageId || search.messageId === excluded) continue;
        for (const item of searchEvidence(search, shellDirsTrusted)) {
          if (!evidenceInScope(item, ctx) || !filtersAdmitTarget(item, ctx, stem)) continue;
          const byStem = stem !== null && includesAdmitTarget(item, ctx) && item.texts.some(text => stem.test(text.toLowerCase()));
          const byDir = Boolean(allowDirMatch) && evidenceNamesDir(item, ctx);
          if (byStem || byDir) {
            return { name: search.name, detail: item.detail, callsAgo: search.callsAgo };
          }
        }
      }
      return null;
    } catch (_) {
      return null;
    }
  }

  return { findCreditingSearch };
}

module.exports = { createSearchEvidence };
