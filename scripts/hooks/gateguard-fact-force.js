#!/usr/bin/env node
/**
 * PreToolUse Hook: GateGuard Fact-Forcing Gate
 *
 * Forces Claude to investigate before editing files or running commands.
 * Instead of asking "are you sure?" (which LLMs always answer "yes"),
 * this hook demands concrete facts: importers, public API, data schemas.
 *
 * The act of investigation creates awareness that self-evaluation never did.
 *
 * Gates:
 *   - Edit/Write/MultiEdit (first touch of each file): questions chosen by
 *     target class (code: list importers, affected API, verify data schemas,
 *     quote instruction)
 *   - Bash/PowerShell (destructive): list targets, rollback plan, quote instruction
 *   - Bash/PowerShell (routine): quote current instruction (once per session)
 *
 * A first touch already covered by a completed search in the current turn,
 * or a new sibling of a file just gated, passes with an additionalContext
 * note (never an "allow" decision). Sensitive targets are always denied, and
 * anything ambiguous falls back to the denial.
 *
 * Compatible with run-with-flags.js via module.exports.run().
 * Cross-platform (Windows, macOS, Linux).
 *
 * Full package with config support: pip install gateguard-ai
 * Repo: https://github.com/zunoworks/gateguard
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { extractCommandSubstitutions, extractSubshellGroups, extractBraceGroups } = require('../lib/shell-substitution');
const { classifyPowerShellDestructiveCommand } = require('../lib/powershell-destructive-command');
const { stripHeredocBodies } = require('./gateguard-heredoc');
const {
  WINDOWS_PATH_PATTERN,
  COLLAPSIBLE_CLASSES,
  CLASS_QUESTIONS,
  CLASS_CONDENSED_HINTS,
  QUOTE_INSTRUCTION,
  resolveTargetPath,
  canonicalPathKey,
  classifyTarget,
  classifyTargetFor,
  collapseGateDir,
  isSensitiveTargetFor
} = require('../lib/gateguard-target-class');
const { scanCurrentTurn, excludedBatchId, createTurnScanner, currentTurnId, transcriptPathFor } = require('../lib/gateguard-turn-scan');

// Session state — scoped per session to avoid cross-session races.
const STATE_DIR = process.env.GATEGUARD_STATE_DIR || path.join(process.env.HOME || process.env.USERPROFILE || '/tmp', '.gateguard');
let activeStateFile = null;

// State expires after 30 minutes of inactivity
const SESSION_TIMEOUT_MS = 30 * 60 * 1000;
const READ_HEARTBEAT_MS = 60 * 1000;

// Maximum checked entries to prevent unbounded growth
const MAX_CHECKED_ENTRIES = 500;
const MAX_SESSION_KEYS = 50;
const ROUTINE_BASH_SESSION_KEY = '__bash_session__';
const EDIT_WRITE_HOOK_ID = 'pre:edit-write:gateguard-fact-force';
const BASH_HOOK_ID = 'pre:bash:gateguard-fact-force';
const POWERSHELL_HOOK_ID = 'pre:powershell:gateguard-fact-force';
const EDIT_WRITE_NARROW_RECOVERY_HINT =
  'Narrow recovery: add a matching path glob to `GATEGUARD_EXEMPT_GLOBS` to skip first-touch Edit/Write checks without disabling destructive Bash checks.';
const ROUTINE_BASH_NARROW_RECOVERY_HINT =
  'Narrow recovery: set `GATEGUARD_BASH_ROUTINE_DISABLED=1`; destructive Bash checks remain active.';
const ROUTINE_POWERSHELL_NARROW_RECOVERY_HINT =
  'Narrow recovery: set `GATEGUARD_BASH_ROUTINE_DISABLED=1`; destructive Bash and PowerShell checks remain active.';
const ECC_DISABLE_VALUES = new Set(['0', 'false', 'off', 'disabled', 'disable']);
const ECC_ENABLE_VALUES = new Set(['1', 'true', 'on', 'enabled', 'enable', 'yes']);

// SQL keywords remain a phrase check. Quoted strings are stripped before
// this regex runs so a commit message mentioning "drop table" stays passive.
// `dd if=` used to be a fourth arm here. Matching it as text could not work:
// the arm ended in `=`, so the shared trailing \b required the NEXT character
// to be a word character and `dd if=/dev/zero` slipped through while
// `echo dd if=x` — which runs no dd at all — was gated. The boundary decided
// the verdict instead of the command position, so dd moved to isDestructiveDd()
// alongside the other token-based detectors (#2642).
const DESTRUCTIVE_SQL = /\b(drop\s+table|delete\s+from|truncate)\b/i;

// Operator-supplied additional destructive patterns. Lazily compiled from
// `GATEGUARD_BASH_EXTRA_DESTRUCTIVE` (regex source) on first use, then
// memoized keyed by the env-var value so a test or long-running process
// that flips the env between calls re-reads it without paying for a
// recompile on every invocation. A malformed regex is treated as
// "not configured" (the gate falls back to the built-in patterns) and
// the parse failure is logged once via `[gateguard-fact-force]` to
// stderr — hooks must never crash tool execution because of operator
// config errors.
let extraDestructiveCacheKey = null;
let extraDestructiveCacheRegex = null;
let extraDestructiveWarnLogged = false;
function getExtraDestructiveRegex() {
  const raw = process.env.GATEGUARD_BASH_EXTRA_DESTRUCTIVE || '';
  if (!raw) {
    extraDestructiveCacheKey = '';
    extraDestructiveCacheRegex = null;
    return null;
  }
  if (raw === extraDestructiveCacheKey) {
    return extraDestructiveCacheRegex;
  }
  // The env value just changed; reset the once-per-pattern warning gate
  // so a subsequent *different* invalid regex is also reported once. The
  // previous shape kept the flag sticky and silently swallowed the
  // second bad pattern in a long-running process.
  extraDestructiveCacheKey = raw;
  extraDestructiveWarnLogged = false;
  try {
    extraDestructiveCacheRegex = new RegExp(raw, 'i');
  } catch (err) {
    extraDestructiveCacheRegex = null;
    if (!extraDestructiveWarnLogged) {
      try {
        process.stderr.write(`[gateguard-fact-force] ignoring invalid GATEGUARD_BASH_EXTRA_DESTRUCTIVE regex: ${err.message}\n`);
      } catch (_) {
        /* stderr write failure is non-fatal */
      }
      extraDestructiveWarnLogged = true;
    }
  }
  return extraDestructiveCacheRegex;
}

// Operator-supplied path exemptions. Comma-separated globs (`GATEGUARD_EXEMPT_GLOBS`)
// matched against the normalized project-relative path (or full path for an
// explicitly absolute glob). First-touch
// fact-forcing is skipped for a matching Edit/Write/MultiEdit target — intended for
// low-import-value trees (tests, generated artifacts, scratch dirs) where "who imports
// this / what schema" carries no signal. Memoized on the env value; malformed
// patterns are dropped without granting exemptions. `*` matches within a path segment,
// `**` across segments, `?` a single char.
let exemptCacheKey = null;
let exemptCacheRegexes = null;
function getExemptMatchers() {
  const raw = process.env.GATEGUARD_EXEMPT_GLOBS || '';
  if (raw === exemptCacheKey) {
    return exemptCacheRegexes;
  }
  exemptCacheKey = raw;
  exemptCacheRegexes = raw
    .split(',')
    .map(s => normalizeForMatch(s.trim()))
    .filter(Boolean)
    .map(glob => {
      let source = '';
      for (let index = 0; index < glob.length; index++) {
        const char = glob[index];
        if (char === '*' && glob[index + 1] === '*') {
          index++;
          if (glob[index + 1] === '/') {
            source += '(?:.*/)?';
            index++;
          } else source += '.*';
        } else if (char === '*') source += '[^/]*';
        else if (char === '?') source += '[^/]';
        else source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
      }
      try {
        return { regex: new RegExp(`^${source}$`), absolute: path.posix.isAbsolute(glob) || path.win32.isAbsolute(glob) };
      } catch (_) {
        return null;
      }
    })
    .filter(Boolean);
  return exemptCacheRegexes;
}

function isExemptPath(filePath, data) {
  const projectRoot = process.env.CLAUDE_PROJECT_DIR || data.cwd || process.cwd();
  if (typeof projectRoot !== 'string' || typeof filePath !== 'string') return false;
  const paths = WINDOWS_PATH_PATTERN.test(projectRoot) ? path.win32 : path.posix;
  if (!paths.isAbsolute(projectRoot)) return false;
  const target = paths.resolve(projectRoot, filePath);
  const relative = paths.relative(projectRoot, target);
  const contained = relative !== '..' && !relative.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relative);
  return getExemptMatchers().some(({ regex, absolute }) =>
    absolute ? regex.test(normalizeForMatch(target)) : contained && regex.test(normalizeForMatch(relative))
  );
}

function isRoutineBashGateDisabled() {
  return ECC_ENABLE_VALUES.has(normalizeEnvValue(process.env.GATEGUARD_BASH_ROUTINE_DISABLED));
}

/**
 * Strip the contents of single- and double-quoted strings so phrases
 * mentioned inside a commit message or echoed argument do not trigger
 * the destructive detector. Command substitutions are scanned separately
 * before this runs because they execute even inside double quotes.
 *
 * @param {string} input
 * @returns {string}
 */
function stripQuotedStrings(input) {
  return input.replace(/'(?:[^'\\]|\\.)*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

/**
 * Promote subshell delimiters to top-level segment separators so the
 * destructive check applies inside `$(...)` and backtick subshells.
 * Without this, `echo y | $(rm -rf /tmp)` and ``echo y | `rm -rf /tmp` ``
 * slip past the segment splitter because the destructive command lives
 * inside a sub-expression. Run iteratively to handle a layer of nesting.
 *
 * @param {string} input
 * @returns {string}
 */
function explodeSubshells(input) {
  let out = input;
  for (let i = 0; i < 4; i += 1) {
    const before = out;
    out = out.replace(/\$\(([^()`]*)\)/g, ';$1;');
    out = out.replace(/`([^`]*)`/g, ';$1;');
    if (out === before) break;
  }
  return out;
}

/**
 * Split a command line into top-level segments at unquoted shell
 * separators (`;`, `|`, `&`, `&&`, `||`) and across subshells
 * (`$(...)` / backticks). Quoted strings are stripped first so
 * separators inside quotes are not split on. Per-segment comments
 * are also stripped.
 *
 * @param {string} input
 * @returns {string[]}
 */
function splitCommandSegments(input) {
  const stripped = explodeSubshells(stripQuotedStrings(input));
  return stripped
    .split(/[;|&]+/)
    .map(segment => segment.replace(/(^|\s)#.*/, '$1').trim())
    .filter(Boolean);
}

/**
 * Tokenize a single command segment by whitespace. Quoted strings
 * are already collapsed to empty quotes by `stripQuotedStrings`, so
 * naive whitespace splitting is sufficient.
 *
 * @param {string} segment
 * @returns {string[]}
 */
function tokenize(segment) {
  return segment.split(/\s+/).filter(Boolean);
}

/**
 * Tokenize a short allowlisted shell command while preserving quoted
 * arguments. This is intentionally smaller than a full shell parser: the
 * caller rejects shell control characters before invoking it, so this only
 * needs to keep spaces inside quotes together for read-only git commands.
 *
 * @param {string} input
 * @returns {string[] | null}
 */
function tokenizeAllowlistedShellWords(input) {
  const tokens = [];
  let current = '';
  let quote = null;
  let escaped = false;

  for (const char of String(input || '')) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === '\\') {
      escaped = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (escaped) current += '\\';
  if (quote) return null;
  if (current) tokens.push(current);
  return tokens;
}

const SHELL_SEGMENT_SEPARATORS = new Set([';', '|', '&', '\n', '\r']);
// Keep only the lexical information needed for Bash's reserved word `time`.
// Quoted/escaped `time` is an external command, not a shell pipeline prefix.
const SHELL_TIME_TOKENS = new WeakMap();

/**
 * Quote-aware split of a command line into segments, with quotes removed from
 * the resulting words. Splits only on UNQUOTED `;`, `|`, `&`, and newlines so:
 *  - a quoted command word (`'rm'`, `"rm"`) normalizes to `rm` (the shell
 *    treats quotes around a command name as transparent), and
 *  - a newline behaves as a command separator (the shell runs each line),
 * neither of which `stripQuotedStrings` + naive splitting handles — both were
 * destructive-classifier bypasses (GHSA-4v57-ph3x-gf55).
 *
 * @param {string} input
 * @returns {string[][]} array of dequoted token arrays, one per segment
 */
function quoteAwareSegments(input) {
  const segments = [];
  let words = [];
  let timeTokens = new Set();
  let current = '';
  let hasWord = false;
  let literalWord = true;
  let quote = null;
  let escaped = false;

  const flushWord = () => {
    if (hasWord) {
      if (literalWord && ['time', '-p', '--'].includes(current)) timeTokens.add(words.length);
      words.push(current);
    }
    current = '';
    hasWord = false;
    literalWord = true;
  };
  const flushSegment = () => {
    flushWord();
    if (words.length) {
      if (timeTokens.size) SHELL_TIME_TOKENS.set(words, timeTokens);
      segments.push(words);
    }
    words = [];
    timeTokens = new Set();
  };

  const source = String(input || '');
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (escaped) {
      current += ch;
      hasWord = true;
      escaped = false;
      continue;
    }
    if (ch === '\\' && quote !== "'") {
      const next = source[i + 1];
      // Single quotes preserve every backslash; double quotes only escape
      // shell-special characters. env -S must receive those literal bytes.
      if (quote === '"' && next && !['$', '`', '"', '\\', '\n'].includes(next)) {
        current += ch;
        hasWord = true;
        continue;
      }
      if (next === '\n') {
        i += 1;
        continue;
      }
      literalWord = false;
      escaped = true;
      hasWord = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      hasWord = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      literalWord = false;
      hasWord = true; // entering a quote starts a word, even if its content is empty
      continue;
    }
    if (SHELL_SEGMENT_SEPARATORS.has(ch)) {
      flushSegment();
      continue;
    }
    if (/\s/.test(ch)) {
      flushWord();
      continue;
    }
    current += ch;
    hasWord = true;
  }
  flushSegment();
  return segments;
}

const SHELL_WRAPPERS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);

/**
 * SQL clients whose `-c`/`-e`/positional arguments carry SQL statements.
 * Quoted SQL (e.g. `psql -c "drop table users"`) is invisible to the
 * quote-stripping SQL regex, so it is re-checked here against dequoted
 * tokens where quoted content is preserved (issue #3024). Restricted to
 * known clients so `git commit -m "drop table"` and `echo "drop table"`
 * stay allowed.
 */
const SQL_CLIENT_COMMANDS = new Set([
  'psql',
  'postgres',
  'mysql',
  'mariadb',
  'sqlite3',
  'sqlite',
  'sqlcmd',
  'isql',
  'pgcli',
  'mycli',
  'duckdb',
  'bq',
]);

/**
 * Strip SQL string literals so phrases inside query data do not trigger
 * the destructive detector (e.g. `SELECT 'drop table' ...` is a read).
 * Handles single-quoted literals with '' escapes, double-quoted
 * identifiers, and dollar-quoted blocks ($$...$$ and $tag$...$tag$).
 *
 * @param {string} input
 * @returns {string}
 */
function stripSqlLiterals(input) {
  return String(input || '')
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/(\$[A-Za-z_][A-Za-z0-9_]*\$|\$\$)[\s\S]*?\1/g, '$$$$');
}

const SUDO_VALUE_FLAGS = new Set([
  '-u',
  '--user',
  '-g',
  '--group',
  '-U',
  '--other-user',
  '-p',
  '--prompt',
  '-C',
  '--close-from',
  '-D',
  '--chdir',
  '-h',
  '--host',
  '-r',
  '--role',
  '-t',
  '--type',
  '-T',
  '--command-timeout',
]);

const DOAS_VALUE_FLAGS = new Set(['-u', '-C']);
const EXEC_VALUE_FLAGS = new Set(['-a']);
const ENV_VALUE_FLAGS = new Set(['-u', '--unset', '-C', '--chdir', '-a', '--argv0', '-S', '--split-string']);
const SHELL_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Split one literal env -S argument into argv, never into shell programs.
 * Operators, substitutions and variable spellings stay literal text; no host
 * environment is read. A dynamic executable name therefore remains opaque.
 * Unterminated quotes, unknown escapes and invalid quoted \c return null.
 * This is bounded literal parsing, not GNU env variable interpolation.
 *
 * @param {string} source
 * @returns {string[] | null}
 */
function splitEnvWords(source) {
  const words = [];
  let word = '';
  let hasWord = false;
  let quote = null;
  const flush = () => {
    if (hasWord) words.push(word);
    word = '';
    hasWord = false;
  };
  const escapes = { f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' };
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '\\' && quote !== "'") {
      const next = source[++i];
      if (next === undefined) return null;
      if (next === 'c') {
        if (quote) return null;
        flush();
        return words;
      }
      if (next === '_') {
        if (quote) {
          word += ' ';
          hasWord = true;
        } else flush();
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(escapes, next)) word += escapes[next];
      else if (['#', '$', '"', "'", '\\'].includes(next)) word += next;
      else return null;
      hasWord = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else word += ch;
      hasWord = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      hasWord = true;
    } else if (ch === '#' && !hasWord) {
      break;
    } else if (/\s/.test(ch)) {
      flush();
    } else {
      word += ch;
      hasWord = true;
    }
  }
  if (quote) return null;
  flush();
  return words;
}

/** Locate a value-taking flag, including the tail of a short-option cluster. */
function wrapperValueOption(arg, valueFlags) {
  if (arg.startsWith('--')) {
    const separator = arg.indexOf('=');
    const name = separator === -1 ? arg : arg.slice(0, separator);
    return valueFlags.has(name)
      ? { name, value: separator === -1 ? undefined : arg.slice(separator + 1) }
      : null;
  }
  if (!arg.startsWith('-')) return null;
  for (let i = 1; i < arg.length; i += 1) {
    const name = `-${arg[i]}`;
    if (valueFlags.has(name)) {
      return { name, value: i + 1 < arg.length ? arg.slice(i + 1) : undefined };
    }
  }
  return null;
}

// Explicit external-launcher argv grammars for dd, SQL clients and shell-wrapper discovery.
// Unknown flags do not justify guessing which later argument executes.
// This literal allowlist cannot prove arbitrary custom-wrapper semantics or
// resolve dynamically selected executables; quoted operand text stays data.
const DD_LAUNCHER_OPTIONS = {
  xargs: {
    values: new Set(['-a', '--arg-file', '-d', '--delimiter', '-E', '-I', '-J', '-L', '-n', '--max-args', '-P', '--max-procs', '-s', '--max-chars', '--process-slot-var']),
    optional: new Set(['-e', '--eof', '-i', '--replace', '-l', '--max-lines']),
    flags: new Set(['-0', '--null', '-r', '--no-run-if-empty', '-t', '--verbose', '-p', '--interactive', '-x', '--exit', '-o', '--open-tty', '--show-limits'])
  },
  timeout: {
    values: new Set(['-k', '--kill-after', '-s', '--signal']),
    optional: new Set(),
    flags: new Set(['-v', '--verbose', '--foreground', '--preserve-status'])
  },
  nice: { values: new Set(['-n', '--adjustment']), optional: new Set(), flags: new Set() },
  nohup: { values: new Set(), optional: new Set(), flags: new Set() },
  time: {
    values: new Set(['-f', '--format', '-o', '--output-file']),
    optional: new Set(),
    flags: new Set(['-p', '--portability', '-a', '--append', '-q', '--quiet', '-v', '--verbose']),
    nonCommand: new Set(['--help', '-V', '--version'])
  },
  stdbuf: {
    values: new Set(['-i', '--input', '-o', '--output', '-e', '--error']),
    optional: new Set(), flags: new Set()
  },
  ionice: {
    values: new Set(['-c', '--class', '-n', '--classdata']),
    optional: new Set(), flags: new Set(['-t', '--ignore']),
    // These modes query/change existing processes rather than launch argv.
    nonCommand: new Set(['-p', '--pid', '-P', '--pgid', '-u', '--uid'])
  },
  setsid: {
    values: new Set(), optional: new Set(),
    flags: new Set(['-c', '--ctty', '-f', '--fork', '-w', '--wait'])
  }
};

/** Return the command position after one explicitly supported launcher's options. */
function ddLauncherCommandIndex(argv, index, name) {
  const { values, optional, flags, nonCommand } = DD_LAUNCHER_OPTIONS[name];
  // GNU time uses getopt_long: unique prefixes resolve against its complete
  // eight-option table, including terminating help/version. Other launchers
  // retain their explicit spellings; this does not affect shell-keyword time.
  const timeLongOptions = name === 'time'
    ? [...values, ...flags, ...nonCommand].filter(flag => flag.startsWith('--'))
    : null;
  index += 1;
  while (index < argv.length) {
    const arg = argv[index];
    if (arg === '--') {
      index += 1;
      break;
    }
    if (!arg.startsWith('-') || arg === '-') break;
    // nice retains the historical -N / --N priority spellings.
    if (name === 'nice' && /^--?\d+$/.test(arg)) {
      index += 1;
      continue;
    }
    if (arg.startsWith('--')) {
      const separator = arg.indexOf('=');
      let flag = separator === -1 ? arg : arg.slice(0, separator);
      if (timeLongOptions && !timeLongOptions.includes(flag)) {
        const matches = timeLongOptions.filter(option => option.startsWith(flag));
        if (matches.length !== 1) return argv.length;
        [flag] = matches;
      }
      if (nonCommand && nonCommand.has(flag)) return argv.length;
      if (values.has(flag)) index += separator === -1 ? 2 : 1;
      else if (optional.has(flag) || (separator === -1 && flags.has(flag))) index += 1;
      else return argv.length;
      continue;
    }
    let consumesNext = false;
    for (let offset = 1; offset < arg.length; offset += 1) {
      const flag = `-${arg[offset]}`;
      if (nonCommand && nonCommand.has(flag)) return argv.length;
      if (values.has(flag)) {
        consumesNext = offset + 1 === arg.length;
        break;
      }
      if (optional.has(flag)) break;
      if (!flags.has(flag)) return argv.length;
    }
    index += consumesNext ? 2 : 1;
  }
  // timeout's duration is data, followed by exactly one executable position.
  return name === 'timeout' ? index + 1 : index;
}

/**
 * Resolve leading assignments, shell prefixes and sudo/doas/env into command
 * argv. Wrapper-specific option values never become executable names. Every
 * wrapper/split consumes source bytes, so the input-size budget bounds nested
 * expansion without rejecting a valid long chain at an arbitrary depth.
 *
 * @param {string[]} tokens dequoted tokens for one segment
 * @param {boolean} [allowShellBuiltins] false for external argv (e.g. find -exec)
 * @param {boolean} [allowDdLaunchers] opt-in; other shared callers retain their grammar
 * @returns {string[]} normalized argv, or [] when no literal command resolves
 */
function unwrapLeadWrappers(tokens, allowShellBuiltins = true, allowDdLaunchers = false) {
  let argv = tokens.slice();
  let index = 0;
  let allowAssignments = true;
  let allowShellTime = allowShellBuiltins;
  const timeTokens = SHELL_TIME_TOKENS.get(tokens);
  let budget = tokens.reduce((size, token) => size + token.length + 1, 1);
  while (index < argv.length && budget-- > 0) {
    while (allowAssignments && index < argv.length && SHELL_ASSIGNMENT.test(argv[index])) {
      index += 1;
      allowShellTime = false;
    }
    if (index >= argv.length) return [];
    const base = commandBasename(argv[index]);
    if (allowDdLaunchers && allowShellTime && argv[index] === 'time' && timeTokens && timeTokens.has(index)) {
      // Current Bash accepts only raw -p and -- as reserved-time options.
      // Quotes/escapes make them executable words, unlike external time argv.
      // The next command/exec builtin or assignment keeps shell semantics.
      index += 1;
      if (argv[index] === '-p' && timeTokens.has(index)) index += 1;
      if (argv[index] === '--' && timeTokens.has(index)) index += 1;
      continue;
    }
    if (allowShellBuiltins && base === 'command') {
      allowShellTime = false;
      index += 1;
      while (index < argv.length && argv[index].startsWith('-') && argv[index] !== '-') {
        const flag = argv[index++];
        if (flag === '--') break;
        // -v/-V (including -pv) only describe names; no command executes.
        if (!/^-[pVv]+$/.test(flag) || /[vV]/.test(flag)) return [];
      }
      allowAssignments = false;
      continue;
    }
    if (allowShellBuiltins && base === 'exec') {
      allowShellTime = false;
      index += 1;
      while (index < argv.length && argv[index].startsWith('-') && argv[index] !== '-') {
        const flag = argv[index];
        if (flag === '--') {
          index += 1;
          break;
        }
        const option = wrapperValueOption(flag, EXEC_VALUE_FLAGS);
        const flagLetters = option ? flag.slice(1, flag.indexOf('a')) : flag.slice(1);
        if (!/^[cl]*$/.test(flagLetters)) return [];
        index += option && option.value === undefined ? 2 : 1;
      }
      // exec replaces the shell with an external executable; its argument
      // 'command' is not the shell's builtin, and A=1 is not an assignment.
      allowShellBuiltins = false;
      allowAssignments = false;
      continue;
    }
    if (allowDdLaunchers && Object.prototype.hasOwnProperty.call(DD_LAUNCHER_OPTIONS, base)) {
      index = ddLauncherCommandIndex(argv, index, base);
      allowShellTime = false;
      allowShellBuiltins = false;
      allowAssignments = false;
      continue;
    }
    if (base === 'sudo' || base === 'doas') {
      allowShellTime = false;
      allowShellBuiltins = false;
      allowAssignments = true;
      const valueFlags = base === 'sudo' ? SUDO_VALUE_FLAGS : DOAS_VALUE_FLAGS;
      index += 1;
      while (index < argv.length) {
        const flag = argv[index];
        if (flag === '--') {
          index += 1;
          break;
        }
        if (flag === '-' || !flag.startsWith('-')) break;
        const option = wrapperValueOption(flag, valueFlags);
        index += option && option.value === undefined ? 2 : 1;
      }
      continue;
    }
    if (base === 'env') {
      allowShellTime = false;
      allowShellBuiltins = false;
      allowAssignments = true;
      index += 1;
      while (index < argv.length) {
        const arg = argv[index];
        if (arg === '--') {
          index += 1;
          break;
        }
        const option = wrapperValueOption(arg, ENV_VALUE_FLAGS);
        if (option && (option.name === '-S' || option.name === '--split-string')) {
          const separate = option.value === undefined;
          const source = separate ? argv[index + 1] : option.value;
          if (source === undefined || budget-- <= 0) return [];
          const expanded = splitEnvWords(source);
          if (!expanded) return [];
          argv = [...expanded, ...argv.slice(index + (separate ? 2 : 1))];
          index = 0;
          continue;
        }
        if (option) {
          index += option.value === undefined ? 2 : 1;
          continue;
        }
        if (arg.startsWith('-') || SHELL_ASSIGNMENT.test(arg)) {
          index += 1;
          continue;
        }
        break;
      }
      continue;
    }
    return argv.slice(index);
  }
  return [];
}

/**
 * Detect destructive SQL passed as (possibly quoted) arguments to a known
 * SQL client. Operates on dequoted tokens from `quoteAwareSegments`, so
 * `psql -c "drop table users"` joins back to matchable text.
 *
 * @param {string[]} tokens dequoted tokens for one segment
 * @returns {boolean}
 */
function isDestructiveSqlClient(tokens) {
  if (!tokens || tokens.length === 0) return false;
  const argv = unwrapLeadWrappers(tokens, true, true);
  if (!SQL_CLIENT_COMMANDS.has(commandBasename(argv[0]))) return false;
  return DESTRUCTIVE_SQL.test(stripSqlLiterals(argv.join(' ')));
}

/**
 * Quote-aware destructive check: catches quoted command words, newline
 * separators, quoted `find -exec`, and `sh -c`/`bash -c` wrappers that evade
 * the quote-stripping path (GHSA-4v57-ph3x-gf55).
 *
 * @param {string} raw
 * @param {number} [depth] recursion guard for shell -c wrappers
 * @returns {boolean}
 */
function isDestructiveQuoteAware(raw, depth = 0) {
  if (depth > 4) return false;
  // The outer command was preprocessed already; shell -c introduces a new
  // program whose literal heredoc data must also stay outside execution.
  const executable = depth === 0 ? raw : stripHeredocBodies(raw);
  for (const body of collectExecutableBodies(executable)) {
    for (const tokens of quoteAwareSegments(body)) {
      if (tokens.length === 0) continue;
      if (isDestructiveRm(tokens)) return true;
      if (isDestructiveGit(tokens)) return true;
      if (isDestructiveDd(tokens)) return true;
      if (isDestructiveSqlClient(tokens)) return true;
      if (isDestructiveFindExec(tokens)) return true;
      const argv = unwrapLeadWrappers(tokens, true, true);
      if (SHELL_WRAPPERS.has(commandBasename(argv[0]))) {
        const ci = argv.indexOf('-c', 1);
        if (ci !== -1 && argv[ci + 1] && isDestructiveQuoteAware(argv[ci + 1], depth + 1)) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * Strip a leading path and trailing `.exe` from a command token so
 * `/usr/bin/git`, `git.exe`, and `GIT` all normalize to `git`.
 *
 * @param {string} token
 * @returns {string}
 */
function commandBasename(token) {
  if (!token) return '';
  return token
    .replace(/^.*[\\/]/, '')
    .replace(/\.exe$/i, '')
    .toLowerCase();
}

/**
 * Detect a `dd` invocation carrying an `if=` or `of=` operand.
 * Keep the existing input-file gate and include output-only writes from stdin.
 *
 * Token-based rather than a regex arm because the verdict has to depend on
 * `dd` being the command, not on `dd if=` appearing anywhere in the line:
 * `echo dd if=/dev/zero` executes nothing. dd operands are order-free, so
 * `dd of=/dev/sda if=/dev/zero` counts too — a text pattern anchored on
 * `dd\s+if=` missed that spelling entirely.
 *
 * Leading `sudo` / `doas` / `env`, their flags, and `VAR=value` assignment
 * prefixes are skipped so `sudo dd if=/dev/zero` stays the dd invocation it is.
 *
 * @param {string[]} tokens
 * @returns {boolean}
 */
function isDestructiveDd(tokens, allowShellBuiltins = true) {
  const argv = unwrapLeadWrappers(tokens, allowShellBuiltins, true);
  return commandBasename(argv[0]) === 'dd' && argv.slice(1).some(operand => /^(?:if|of)=/i.test(operand));
}

/**
 * Detect `rm` invocations that recursively force-delete files. Handles
 * combined (`-rf`, `-fr`, `-Rf`) and split (`-r -f`) flag forms.
 *
 * @param {string[]} tokens
 * @returns {boolean}
 */
function isDestructiveRm(tokens) {
  if (tokens.length === 0 || commandBasename(tokens[0]) !== 'rm') return false;
  let hasR = false;
  let hasF = false;
  for (const t of tokens.slice(1)) {
    if (t === '--recursive') {
      hasR = true;
      continue;
    }
    if (t === '--force') {
      hasF = true;
      continue;
    }
    if (!t.startsWith('-') || t.startsWith('--')) continue;
    const body = t.slice(1);
    if (/[rR]/.test(body)) hasR = true;
    if (/f/.test(body)) hasF = true;
  }
  return hasR && hasF;
}

/**
 * Locate the git subcommand within a token list, skipping over git's
 * global options like `-c key=value`, `-C <path>`, `--git-dir=...`,
 * `--work-tree=...`, `--namespace=...`, `--super-prefix=...`.
 *
 * @param {string[]} tokens
 * @returns {{ command: string, rest: string[] } | null}
 */
function findGitSubcommand(tokens) {
  if (tokens.length === 0 || commandBasename(tokens[0]) !== 'git') return null;
  const valueConsumingShort = new Set(['-c', '-C']);
  const valueConsumingLong = new Set(['--git-dir', '--work-tree', '--namespace', '--super-prefix']);
  let i = 1;
  while (i < tokens.length) {
    const t = tokens[i];
    if (valueConsumingShort.has(t) || valueConsumingLong.has(t)) {
      i += 2;
      continue;
    }
    if (t.startsWith('--git-dir=') || t.startsWith('--work-tree=') || t.startsWith('--namespace=') || t.startsWith('--super-prefix=')) {
      i += 1;
      continue;
    }
    if (t.startsWith('-')) {
      // Unknown global option — skip without consuming a value.
      i += 1;
      continue;
    }
    return { command: t.toLowerCase(), rest: tokens.slice(i + 1) };
  }
  return null;
}

/**
 * Branch names treated as shared history: a forced update of one of
 * these rewrites commits other clones build on, even when the push is
 * lease-checked.
 */
const SHARED_GIT_BRANCHES = new Set(['main', 'master', 'develop', 'trunk']);

/**
 * Decide whether the positional arguments of a `git push` name a shared
 * branch as the destination of a refspec. The first positional token is
 * the remote (unless the remote came from `--repo`); every later
 * positional token is a refspec whose destination is the part after
 * `:` (or the whole token when there is no `:`). A leading `+` force
 * marker is stripped. When no refspec is given the target is the
 * current branch, which the hook cannot know, so this returns false.
 *
 * @param {string[]} rest tokens after `push`
 * @returns {boolean}
 */
function pushTargetsSharedBranch(rest) {
  const valueConsuming = new Set(['-o', '--push-option', '--receive-pack', '--exec']);
  const positional = [];
  let remoteViaFlag = false;
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    if (t === '--repo') {
      remoteViaFlag = true;
      i += 1;
      continue;
    }
    if (t.startsWith('--repo=')) {
      remoteViaFlag = true;
      continue;
    }
    if (valueConsuming.has(t)) {
      i += 1;
      continue;
    }
    if (t.startsWith('-')) continue;
    positional.push(t);
  }
  // Unless the remote came from --repo, positional[0] is the remote and
  // the rest are refspecs.
  const refspecs = remoteViaFlag ? positional : positional.slice(1);
  for (const refspec of refspecs) {
    const cleaned = refspec.startsWith('+') ? refspec.slice(1) : refspec;
    const dst = cleaned.includes(':') ? cleaned.slice(cleaned.indexOf(':') + 1) : cleaned;
    const branch = dst.startsWith('refs/heads/') ? dst.slice('refs/heads/'.length) : dst;
    if (SHARED_GIT_BRANCHES.has(branch)) return true;
  }
  return false;
}

/**
 * Detect destructive `git` invocations: `reset --hard`, `checkout --`,
 * `clean -f...`, `push --force` (`--force-with-lease` only to a shared
 * branch), `commit --amend`, `rm -rf`, `branch -D`, `stash drop` /
 * `stash clear`, `reflog expire` / `reflog delete`, `update-ref -d`,
 * and `restore` against the worktree.
 *
 * @param {string[]} tokens
 * @returns {boolean}
 */
function isDestructiveGit(tokens) {
  const sub = findGitSubcommand(tokens);
  if (!sub) return false;
  const { command, rest } = sub;

  if (command === 'reset') {
    return rest.includes('--hard');
  }

  if (command === 'checkout') {
    // `git checkout -- <path>`, `git checkout .`, and the force forms
    // (`--force` / `-f`) all discard uncommitted working-tree changes,
    // mirroring the `switch` handler below.
    return rest.some(t => {
      if (t === '--' || t === '.' || t === '--force') return true;
      if (!t.startsWith('-') || t.startsWith('--')) return false;
      return t.slice(1).includes('f');
    });
  }

  if (command === 'clean') {
    // `git clean -f`, `-fd`, `-fdx`, `-df`, `--force`
    return rest.some(t => {
      if (t === '--force') return true;
      if (!t.startsWith('-') || t.startsWith('--')) return false;
      return t.slice(1).includes('f');
    });
  }

  if (command === 'push') {
    // Only `--force-with-lease` qualifies as a safety-checked force.
    // `--force-if-includes` is a no-op when used WITHOUT
    // `--force-with-lease` (per git-scm.com/docs/git-push), and when
    // combined with a bare `--force` the bare force is still in effect.
    // So `--force --force-if-includes` must be treated as destructive.
    //
    // A `+` refspec prefix (e.g. `git push origin +main`,
    // `+refs/heads/main:refs/heads/main`) also forces a non-fast-forward
    // update of that ref and is destructive on its own.
    let withLease = false;
    let bareForce = false;
    let plusRefspecForce = false;
    for (const t of rest) {
      if (t === '--force-with-lease' || t.startsWith('--force-with-lease=')) {
        withLease = true;
        continue;
      }
      if (t === '--force' || t.startsWith('--force=')) {
        bareForce = true;
        continue;
      }
      if (t.startsWith('-') && !t.startsWith('--') && t.slice(1).includes('f')) {
        bareForce = true;
        continue;
      }
      // Refspec prefix: `+<src>[:<dst>]`. Match tokens like `+main`,
      // `+refs/heads/main`, `+HEAD:branch`, `+:branch`. Exclude bare
      // `+` and numeric-only `+123` which are not refspecs.
      if (t.startsWith('+') && t.length > 1 && /^\+(?:[a-zA-Z_/.:]|HEAD)/.test(t)) {
        plusRefspecForce = true;
      }
    }
    if (bareForce || (plusRefspecForce && !withLease)) return true;
    // A lease-checked force still rewrites a shared branch's history.
    return withLease && pushTargetsSharedBranch(rest);
  }

  if (command === 'commit') {
    return rest.includes('--amend');
  }

  if (command === 'rm') {
    // `git rm -r` / `-rf` / `-r -f` — destructive within the index too.
    let hasR = false;
    for (const t of rest) {
      if (!t.startsWith('-') || t.startsWith('--')) continue;
      if (/[rR]/.test(t.slice(1))) hasR = true;
    }
    return hasR;
  }

  if (command === 'switch') {
    // `git switch` can discard local working-tree changes in three forms:
    //   --discard-changes           explicit discard
    //   --force / -f                ignore conflicts and overwrite
    //   -C <branch>                 force-create (overwrites existing branch)
    return rest.some(t => {
      if (t === '--discard-changes' || t === '--force') return true;
      if (!t.startsWith('-') || t.startsWith('--')) return false;
      // Short combined form: -f, -fC, -Cf, -C
      const body = t.slice(1);
      return /[fC]/.test(body);
    });
  }

  if (command === 'branch') {
    // `git branch -D` (long spelling: `--delete --force`) deletes a
    // branch even when it is unmerged, orphaning its commits. Plain
    // `-d` refuses when unmerged, so it is safe to leave ungated.
    let del = false;
    let force = false;
    for (const t of rest) {
      if (t === '--delete') { del = true; continue; }
      if (t === '--force') { force = true; continue; }
      if (!t.startsWith('-') || t.startsWith('--')) continue;
      const body = t.slice(1);
      if (body.includes('D')) return true;
      if (body.includes('d')) del = true;
      if (body.includes('f')) force = true;
    }
    return del && force;
  }

  if (command === 'stash') {
    // `drop` destroys one stash entry, `clear` the entire stash.
    // `list`, `show`, `pop` and `apply` keep the entries recoverable.
    return rest[0] === 'drop' || rest[0] === 'clear';
  }

  if (command === 'reflog') {
    // `expire` and `delete` remove the recovery net that makes every
    // other gated git command recoverable.
    return rest[0] === 'expire' || rest[0] === 'delete';
  }

  if (command === 'update-ref') {
    // `git update-ref -d <ref>` deletes a ref directly.
    return rest.includes('-d') || rest.includes('--delete');
  }

  if (command === 'restore') {
    // `git restore <path>` overwrites the working tree from the index
    // by default, the modern spelling of gated `git checkout -- <path>`.
    // Only `--staged` alone is non-destructive (it leaves the file on
    // disk untouched); `--worktree` (the default target) is destructive.
    const has = (long, short) => rest.some(t =>
      t === long || (t.startsWith('-') && !t.startsWith('--') && t.slice(1).includes(short)));
    const staged = has('--staged', 'S');
    const worktree = has('--worktree', 'W');
    return worktree || !staged;
  }

  return false;
}

/**
 * Decide whether a bash command line contains a destructive action
 * the fact-forcing gate should challenge. Combines SQL-keyword
 * detection (regex on quote-stripped input) with per-segment shell
 * tokenization for shell commands.
 *
 * @param {string} command
 * @returns {boolean}
 */
/**
 * Walk every executable body reachable from a raw command line and
 * return them as a flat list. Bodies that bash will execute live in
 * three different syntactic constructs, each handled by a sibling
 * extractor in `scripts/lib/shell-substitution.js`:
 *   - `$(...)` and backticks via `extractCommandSubstitutions`
 *   - plain `(...)` subshells   via `extractSubshellGroups`
 *   - `{ ...; }` brace groups   via `extractBraceGroups`
 *
 * Each extractor recurses into its own syntax. The BFS here adds
 * cross-syntax discovery — e.g. a `(...)` inside a `$(...)` body, or
 * a `{ ...; }` inside a `(...)` body — by feeding every harvested
 * body back through all three extractors. A `seen` set bounds the
 * cost to O(unique bodies).
 *
 * @param {string} raw
 * @returns {string[]}
 */
function collectExecutableBodies(raw) {
  const bodies = [raw];
  const queue = [raw];
  const seen = new Set();

  while (queue.length) {
    const current = queue.shift();
    if (seen.has(current)) continue;
    seen.add(current);

    for (const body of extractCommandSubstitutions(current)) {
      if (seen.has(body)) continue;
      bodies.push(body);
      queue.push(body);
    }
    for (const body of extractSubshellGroups(current)) {
      if (seen.has(body)) continue;
      bodies.push(body);
      queue.push(body);
    }
    for (const body of extractBraceGroups(current)) {
      if (seen.has(body)) continue;
      bodies.push(body);
      queue.push(body);
    }
  }

  return bodies;
}

// Find predicates consume their arguments even when a value spells '-exec'.
const FIND_VALUE_PREDICATES = new Set([
  '-name', '-iname', '-path', '-ipath', '-wholename', '-iwholename', '-regex', '-iregex',
  '-type', '-xtype', '-maxdepth', '-mindepth', '-mtime', '-mmin', '-atime', '-amin',
  '-ctime', '-cmin', '-newer', '-anewer', '-cnewer', '-used', '-uid', '-gid', '-user',
  '-group', '-perm', '-size', '-inum', '-links', '-fstype', '-context', '-lname', '-ilname',
  '-printf', '-fprint', '-fprint0', '-fls', '-samefile', '-files0-from', '-regextype'
]);
const FIND_EXEC_ACTIONS = new Set(['-exec', '-execdir', '-ok', '-okdir']);

/**
 * Inspect each find executable action without mistaking its argv for another
 * action. -ok/-okdir still run the command after their own confirmation, so
 * they retain the explicit destructive gate. A + terminates exec/execdir only
 * after {}; elsewhere it remains an ordinary argument.
 *
 * @param {string | string[]} command raw segment or already dequoted argv
 * @returns {boolean}
 */
function isDestructiveFindExec(command) {
  const quoteAware = Array.isArray(command);
  const tokens = quoteAware ? command : tokenize(String(command || '').trim());
  if (commandBasename(tokens[0]) !== 'find') return false;

  for (let index = 1; index < tokens.length; index += 1) {
    const action = tokens[index];
    if (action === '-fprintf') {
      index += 2;
      continue;
    }
    if (FIND_VALUE_PREDICATES.has(action) || /^-newer[a-zA-Z]{2}$/.test(action)) {
      index += 1;
      continue;
    }
    if (!FIND_EXEC_ACTIONS.has(action)) continue;
    const execTokens = [];
    for (index += 1; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (token === ';' || token === '\\;' || (
        token === '+' && (action === '-exec' || action === '-execdir') &&
        execTokens[execTokens.length - 1] === '{}'
      )) break;
      execTokens.push(token);
    }
    if (execTokens.length === 0) continue;
    // The legacy raw fallback can split quoted prose into apparent actions.
    // Preserve its old rm/Git coverage, but classify dd only from real argv.
    if (quoteAware && isDestructiveDd(execTokens, false)) return true;
    const baseCmd = commandBasename(execTokens[0]);
    // Preserve main's existing rm/rmdir/unlink and git-reset handling.
    if (baseCmd === 'rm' || baseCmd === 'rmdir' || baseCmd === 'unlink') return true;
    if (baseCmd === 'git') {
      const sub = findGitSubcommand(execTokens);
      if (sub && sub.command === 'reset' && sub.rest.includes('--hard')) return true;
    }
  }
  return false;
}

function isDestructiveBash(command) {
  // SQL phrases live in command bodies, not as flag-bearing
  // arguments, so we still match them by regex - but on the input
  // after quoting AND subshell delimiters are normalized so phrases
  // inside `$(...)` or backticks are also caught.
  const raw = String(command || '');
  // Keep main's heredoc stripping: a phrase inside a heredoc body is data, not a
  // command. dd is no longer part of this regex — see DESTRUCTIVE_SQL.
  const executable = stripHeredocBodies(raw);
  const flattened = explodeSubshells(stripQuotedStrings(executable));
  if (DESTRUCTIVE_SQL.test(flattened)) return true;

  // Operator-supplied additional destructive patterns. Same scope as the
  // built-in SQL regex: matched against the quote-stripped, subshell-
  // exploded command so a phrase inside `$(...)` or backticks is caught.
  const extra = getExtraDestructiveRegex();
  if (extra && extra.test(flattened)) return true;

  // Check for destructive find -exec patterns on raw body segments (before quote-stripping)
  // so that quoted exec binaries and compound-command prefixes are both handled correctly.
  // splitCommandSegments strips quotes before splitting, so passing its output to
  // isDestructiveFindExec would turn `find . -exec 'rm' {} \;` into `find . -exec  {} \;`
  // — the binary name disappears and the check returns false.  Using raw body text avoids
  // that false-negative while also catching `&&`, `;`, `|`, and `||` compound forms.
  const bodies = collectExecutableBodies(executable);
  for (const body of bodies) {
    for (const rawSeg of body
      .split(/[;|&]+/)
      .map(s => s.trim())
      .filter(Boolean)) {
      if (isDestructiveFindExec(rawSeg)) return true;
    }
  }

  const segments = bodies.flatMap(splitCommandSegments);
  for (const segment of segments) {
    const stripped = stripQuotedStrings(segment);
    if (DESTRUCTIVE_SQL.test(stripped)) return true;
    if (extra && extra.test(stripped)) return true;
    const tokens = tokenize(segment);
    if (isDestructiveRm(tokens)) return true;
    if (isDestructiveGit(tokens)) return true;
  }

  // Quote-aware pass: closes the quoted-command-word, newline-separator,
  // quoted-find-exec, and sh/bash -c bypasses (GHSA-4v57-ph3x-gf55).
  if (isDestructiveQuoteAware(executable)) return true;

  return false;
}

/**
 * Return the stable, non-sensitive rule IDs that drive the destructive gate.
 * PowerShell also passes through the existing Bash-compatible classifier so
 * shell-agnostic git, SQL, and operator-configured rules retain coverage.
 * Governance consumes this exact decision for PowerShell approval evidence.
 *
 * @param {string} toolName
 * @param {string} command
 * @returns {string[]}
 */
function classifyDestructiveCommand(toolName, command) {
  const normalizedTool = String(toolName || '').toLowerCase();
  if (normalizedTool !== 'bash' && normalizedTool !== 'powershell') return [];

  const findings = [
    ...(isDestructiveBash(command) ? ['gateguard.bash-compatible-destructive'] : []),
    ...(normalizedTool === 'powershell' ? classifyPowerShellDestructiveCommand(command) : []),
  ];
  return [...new Set(findings)];
}

// --- State management (per-session, atomic writes, bounded) ---

function normalizeEnvValue(value) {
  return String(value || '')
    .trim()
    .toLowerCase();
}

function isGateGuardDisabled() {
  if (normalizeEnvValue(process.env.GATEGUARD_DISABLED) === '1') {
    return true;
  }

  return ECC_DISABLE_VALUES.has(normalizeEnvValue(process.env.ECC_GATEGUARD));
}

function sanitizeSessionKey(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    return '';
  }

  const sanitized = raw.replace(/[^a-zA-Z0-9_-]/g, '_');
  if (sanitized && sanitized.length <= 64) {
    return sanitized;
  }

  return hashSessionKey('sid', raw);
}

function hashSessionKey(prefix, value) {
  return `${prefix}-${crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 24)}`;
}

function resolveSessionKey(data) {
  const directCandidates = [data && data.session_id, data && data.sessionId, data && data.session && data.session.id, process.env.CLAUDE_SESSION_ID, process.env.ECC_SESSION_ID];

  for (const candidate of directCandidates) {
    const sanitized = sanitizeSessionKey(candidate);
    if (sanitized) {
      return sanitized;
    }
  }

  const transcriptPath = (data && (data.transcript_path || data.transcriptPath)) || process.env.CLAUDE_TRANSCRIPT_PATH;
  if (transcriptPath && String(transcriptPath).trim()) {
    return hashSessionKey('tx', path.resolve(String(transcriptPath).trim()));
  }

  const projectFingerprint = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  return hashSessionKey('proj', path.resolve(projectFingerprint));
}

function getStateFile(data) {
  if (!activeStateFile) {
    const sessionKey = resolveSessionKey(data);
    activeStateFile = path.join(STATE_DIR, `state-${sessionKey}.json`);
  }
  return activeStateFile;
}

function loadState() {
  const stateFile = getStateFile();
  try {
    if (fs.existsSync(stateFile)) {
      const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      const lastActive = state.last_active || 0;
      if (Date.now() - lastActive > SESSION_TIMEOUT_MS) {
        try {
          fs.unlinkSync(stateFile);
        } catch (_) {
          /* ignore */
        }
        return { checked: [], last_active: Date.now() };
      }
      return state;
    }
  } catch (_) {
    /* ignore */
  }
  return { checked: [], last_active: Date.now() };
}

function pruneCheckedEntries(checked) {
  if (checked.length <= MAX_CHECKED_ENTRIES) {
    return checked;
  }

  const preserved = checked.includes(ROUTINE_BASH_SESSION_KEY) ? [ROUTINE_BASH_SESSION_KEY] : [];
  const sessionKeys = checked.filter(k => k.startsWith('__') && k !== ROUTINE_BASH_SESSION_KEY);
  const fileKeys = checked.filter(k => !k.startsWith('__'));
  const remainingSessionSlots = Math.max(MAX_SESSION_KEYS - preserved.length, 0);
  const cappedSession = sessionKeys.slice(-remainingSessionSlots);
  const remainingFileSlots = Math.max(MAX_CHECKED_ENTRIES - preserved.length - cappedSession.length, 0);
  const cappedFiles = fileKeys.slice(-remainingFileSlots);
  return [...preserved, ...cappedSession, ...cappedFiles];
}

function saveState(state) {
  const stateFile = getStateFile();
  let tmpFile = null;
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });

    let mergedChecked = Array.isArray(state.checked) ? state.checked : [];
    let mergedLastActive = typeof state.last_active === 'number' ? state.last_active : 0;
    let mergedDenials = getDenialCount(state);
    let mergedCredited = getCreditedCount(state);
    let mergedDirGates = getDirGates(state);
    let mergedDenialsByClass = getClassCounts(state, 'denials_by_class');
    let mergedCreditedByClass = getClassCounts(state, 'credited_by_class');
    let mergedSiblingAllows = getSiblingAllowCount(state);
    let mergedCapAllows = getCapAllowCount(state);

    try {
      if (fs.existsSync(stateFile)) {
        const diskState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        if (Array.isArray(diskState.checked)) {
          mergedChecked = Array.from(new Set([...diskState.checked, ...mergedChecked]));
        }
        if (typeof diskState.last_active === 'number') {
          mergedLastActive = Math.max(mergedLastActive, diskState.last_active);
        }
        mergedDenials = Math.max(mergedDenials, getDenialCount(diskState));
        mergedCredited = Math.max(mergedCredited, getCreditedCount(diskState));
        mergedDirGates = mergeDirGates(getDirGates(diskState), mergedDirGates);
        mergedDenialsByClass = mergeClassCounts(getClassCounts(diskState, 'denials_by_class'), mergedDenialsByClass);
        mergedCreditedByClass = mergeClassCounts(getClassCounts(diskState, 'credited_by_class'), mergedCreditedByClass);
        mergedSiblingAllows = Math.max(mergedSiblingAllows, getSiblingAllowCount(diskState));
        mergedCapAllows = Math.max(mergedCapAllows, getCapAllowCount(diskState));
      }
    } catch (_) {
      /* ignore malformed or transient disk state */
    }

    const finalState = {
      checked: pruneCheckedEntries(mergedChecked),
      last_active: Math.max(mergedLastActive, Date.now()),
      fact_force_denials: mergedDenials,
      fact_force_credited: mergedCredited,
      dir_gates: capDirGates(mergedDirGates),
      denials_by_class: mergedDenialsByClass,
      credited_by_class: mergedCreditedByClass,
      sibling_allows: mergedSiblingAllows,
      cap_allows: mergedCapAllows
    };

    // Atomic write: temp file + rename prevents partial reads
    tmpFile = `${stateFile}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
    fs.writeFileSync(tmpFile, JSON.stringify(finalState, null, 2), 'utf8');
    try {
      fs.renameSync(tmpFile, stateFile);
    } catch (error) {
      if (error && (error.code === 'EEXIST' || error.code === 'EPERM')) {
        try {
          fs.unlinkSync(stateFile);
        } catch (_) {
          /* ignore */
        }
        fs.renameSync(tmpFile, stateFile);
      } else {
        throw error;
      }
    }
    tmpFile = null;
    return true;
  } catch (_) {
    if (tmpFile) {
      try {
        fs.unlinkSync(tmpFile);
      } catch (_) {
        /* ignore */
      }
    }
    return false;
  }
}

function markChecked(key) {
  const state = loadState();
  if (!state.checked.includes(key)) {
    state.checked.push(key);
    return saveState(state);
  }
  return true;
}

// --- Fact-force denial dampening (#2142) ---
//
// In long sessions the near-identical four-fact deny blocks accumulate in
// the context window and measurably raise the odds of the model dropping
// into a degenerate repetition loop. Emit the full four-fact block only for
// the first GATEGUARD_FACT_FORCE_FULL_DENIALS denials per session (default
// 3); afterwards emit a condensed single-line denial that carries the
// denial ordinal, so consecutive denials are structurally different and
// never textually identical. True retries of an already-gated target are
// unaffected (they were always allowed). Destructive shell and routine shell
// gates are not denial-dampened.

const DEFAULT_FULL_DENIALS = 3;

function getFullDenialBudget() {
  const raw = Number.parseInt(process.env.GATEGUARD_FACT_FORCE_FULL_DENIALS || '', 10);
  if (Number.isInteger(raw) && raw >= 0) {
    return raw;
  }
  return DEFAULT_FULL_DENIALS;
}

// --- Opt-in session cap on first-touch denials (GATEGUARD_FACT_FORCE_MAX_DENIALS) ---
// Validated whole, not with parseInt: a prefix parse would turn '3oops' into a
// cap. A malformed value leaves the gate uncapped and says so once on stderr.

const MAX_DENIALS_PATTERN = /^\d+$/;
const MAX_DENIALS_WARN_VALUE_CHARS = 64;
let maxDenialsWarnedFor = null;

function warnMalformedMaxDenials(raw) {
  if (raw === maxDenialsWarnedFor) return;
  maxDenialsWarnedFor = raw;
  const chars = Array.from(sanitizePath(raw));
  const shown = chars.length > MAX_DENIALS_WARN_VALUE_CHARS
    ? `${chars.slice(0, MAX_DENIALS_WARN_VALUE_CHARS - 3).join('')}...`
    : chars.join('');
  try {
    process.stderr.write(
      `[Fact-Forcing Gate] ignoring malformed GATEGUARD_FACT_FORCE_MAX_DENIALS=${shown}; the denial cap is not active.\n`
    );
  } catch (_) {
    /* stderr write failure is non-fatal */
  }
}

function getMaxDenialBudget() {
  const raw = process.env.GATEGUARD_FACT_FORCE_MAX_DENIALS || '';
  if (!raw) return Number.POSITIVE_INFINITY;
  const trimmed = raw.trim();
  if (MAX_DENIALS_PATTERN.test(trimmed)) {
    const parsed = Number(trimmed);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  warnMalformedMaxDenials(raw);
  return Number.POSITIVE_INFINITY;
}

/** A non-negative integer count from untrusted state; anything else is 0. */
function toCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

function getDenialCount(state) {
  return toCount(state && state.fact_force_denials);
}

function getCreditedCount(state) {
  return toCount(state && state.fact_force_credited);
}

function getCapAllowCount(state) {
  return toCount(state && state.cap_allows);
}

/** Mark a target checked and apply `update` in one state write, so an event is never half-recorded. */
function markCheckedWith(key, update) {
  const loaded = loadState();
  const withKey = loaded.checked.includes(key) ? loaded : { ...loaded, checked: [...loaded.checked, key] };
  const { state, value } = update(withKey);
  return { ok: saveState(state), value };
}

/**
 * Record a denial (returns its ordinal) or, once denials reach `cap`, a cap pass
 * (`denials` null). The cap check reads the state the write persists, so a lost
 * concurrent update can add a denial but never passes a target early.
 */
function markCheckedAndCountDenial(key, { cls, dirGate, cap = Number.POSITIVE_INFINITY } = {}) {
  const { ok, value: denials } = markCheckedWith(key, state => {
    if (getDenialCount(state) >= cap) {
      return { state: { ...state, cap_allows: getCapAllowCount(state) + 1 }, value: null };
    }
    const ordinal = getDenialCount(state) + 1;
    const next = {
      ...state,
      fact_force_denials: ordinal,
      ...(cls ? { denials_by_class: incrementClassCount(getClassCounts(state, 'denials_by_class'), cls) } : {}),
      ...(dirGate
        ? { dir_gates: withEntry(getDirGates(state), dirGate.key, { turn: dirGate.turn || null, at: Date.now(), first: dirGate.first, ordinal }) }
        : {})
    };
    return { state: next, value: ordinal };
  });
  return { ok, denials };
}

function markCheckedAndCountCredit(key, cls) {
  return markCheckedWith(key, state => ({
    state: {
      ...state,
      fact_force_credited: getCreditedCount(state) + 1,
      ...(cls ? { credited_by_class: incrementClassCount(getClassCounts(state, 'credited_by_class'), cls) } : {})
    },
    value: undefined
  })).ok;
}

// --- Sibling gates and per-class counters ---
// dir_gates maps `<class>\u0000<canonicalDir>` to { turn, at, first, ordinal }.
// The state file is untrusted, so every map is null-prototype and rejects prototype keys.

const MAX_DIR_GATES = 50;
const SIBLING_NO_TURN_WINDOW_MS = 120 * 1000;
const DIR_GATE_KEY_SEPARATOR = '\u0000';
const UNSAFE_MAP_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isSafeKey(key) {
  return typeof key === 'string' && key !== '' && !UNSAFE_MAP_KEYS.has(key);
}

function nullMap(entries) {
  const map = Object.create(null);
  for (const [key, value] of entries) map[key] = value;
  return map;
}

function withEntry(map, key, value) {
  return nullMap([...Object.entries(map), [key, value]]);
}

function getClassCounts(state, field) {
  const raw = state && state[field];
  if (!isPlainObject(raw)) return nullMap([]);
  const entries = Object.keys(raw)
    .filter(cls => isSafeKey(cls) && typeof raw[cls] === 'number' && toCount(raw[cls]) > 0)
    .map(cls => [cls, toCount(raw[cls])]);
  return nullMap(entries);
}

function mergeClassCounts(a, b) {
  const merged = nullMap(Object.entries(a));
  for (const [cls, n] of Object.entries(b)) {
    merged[cls] = Math.max(Object.hasOwn(merged, cls) ? merged[cls] : 0, n);
  }
  return merged;
}

function incrementClassCount(counts, cls) {
  if (!isSafeKey(cls)) return counts;
  return withEntry(counts, cls, (Object.hasOwn(counts, cls) ? counts[cls] : 0) + 1);
}

function getSiblingAllowCount(state) {
  return toCount(state && state.sibling_allows);
}

function dirGateKey(cls, dir) {
  return `${cls}${DIR_GATE_KEY_SEPARATOR}${dir}`;
}

function isDirGateKey(key) {
  if (!isSafeKey(key)) return false;
  const at = key.indexOf(DIR_GATE_KEY_SEPARATOR);
  return at > 0 && at < key.length - 1 && COLLAPSIBLE_CLASSES.has(key.slice(0, at));
}

function isDirGateEntry(entry) {
  return (
    isPlainObject(entry) &&
    typeof entry.at === 'number' &&
    Number.isFinite(entry.at) &&
    typeof entry.first === 'string' &&
    (entry.turn === null || entry.turn === undefined || typeof entry.turn === 'string')
  );
}

function getDirGates(state) {
  const raw = state && state.dir_gates;
  if (!isPlainObject(raw)) return nullMap([]);
  const entries = Object.keys(raw)
    .filter(key => isDirGateKey(key) && isDirGateEntry(raw[key]))
    .map(key => {
      const entry = raw[key];
      return [key, { turn: entry.turn || null, at: entry.at, first: entry.first, ordinal: toCount(entry.ordinal) }];
    });
  return nullMap(entries);
}

/** Union by key; the newer `at` wins, so concurrent writers keep the latest gate. */
function mergeDirGates(older, newer) {
  const merged = nullMap(Object.entries(older));
  for (const [key, entry] of Object.entries(newer)) {
    if (!Object.hasOwn(merged, key) || entry.at >= merged[key].at) merged[key] = entry;
  }
  return merged;
}

function capDirGates(gates) {
  const entries = Object.entries(gates);
  if (entries.length <= MAX_DIR_GATES) return gates;
  return nullMap(entries.sort((a, b) => b[1].at - a[1].at).slice(0, MAX_DIR_GATES));
}

function markCheckedAndCountSibling(key) {
  return markCheckedWith(key, state => ({
    state: { ...state, sibling_allows: getSiblingAllowCount(state) + 1 },
    value: undefined
  })).ok;
}

/**
 * Open sibling gate for this key: same turn id, or (no turn id on either side)
 * within 120 s. A gate stamped in the future or without a denial is ignored.
 */
function findSiblingGate(key, turnId, now = Date.now()) {
  const gates = getDirGates(loadState());
  if (!Object.hasOwn(gates, key)) return null;
  const entry = gates[key];
  const age = now - entry.at;
  if (!(age >= 0) || entry.ordinal < 1) return null;
  if (turnId) return entry.turn === turnId ? entry : null;
  return entry.turn === null && age <= SIBLING_NO_TURN_WINDOW_MS ? entry : null;
}

function isChecked(key) {
  const state = loadState();
  const keys = Array.isArray(key) ? key : [key];
  const found = keys.some(k => state.checked.includes(k));
  if (found && Date.now() - (state.last_active || 0) > READ_HEARTBEAT_MS) {
    saveState(state);
  }
  return found;
}

// Prune stale session files older than 1 hour
(function pruneStaleFiles() {
  try {
    const files = fs.readdirSync(STATE_DIR);
    const now = Date.now();
    for (const f of files) {
      const isStateFile = f.startsWith('state-') && (f.endsWith('.json') || f.includes('.json.tmp.'));
      if (!isStateFile) continue;
      const fp = path.join(STATE_DIR, f);
      try {
        const stat = fs.statSync(fp);
        if (now - stat.mtimeMs > SESSION_TIMEOUT_MS * 2) {
          fs.unlinkSync(fp);
        }
      } catch (_) {
        // Ignore files that disappear between readdir/stat/unlink.
      }
    }
  } catch (_) {
    /* ignore */
  }
})();

// --- Sanitize file path against injection ---

// Unicode policy for sanitizePath, mirroring the repo-wide dangerous set in
// scripts/ci/check-unicode-safety.js. Named so the ranges stay auditable and
// drift against the CI policy is visible in one place.
const ASCII_CONTROL_MAX = 0x1f;
const ASCII_DELETE = 0x7f;
const C1_CONTROLS = [0x80, 0x9f]; // Unicode C1 control block (U+0080..U+009F)
const BIDI_MARKS = [0x200e, 0x200f]; // LRM/RLM
const BIDI_EMBEDDINGS = [0x202a, 0x202e]; // LRE..PDF
const BIDI_ISOLATES = [0x2066, 0x2069]; // LRI..PDI
const ZERO_WIDTHS = [0x200b, 0x200d]; // ZWSP..ZWJ
const WORD_JOINER = 0x2060;
const BYTE_ORDER_MARK = 0xfeff;
const VARIATION_SELECTORS = [0xfe00, 0xfe0f];
const VARIATION_SUPPLEMENTS = [0xe0100, 0xe01ef]; // MONGOLIAN..TAGS (VS17..VS256)
const TAG_BLOCK = [0xe0000, 0xe007f]; // ASCII-smuggling tag characters
const MONGOLIAN_VOWEL_SEPARATOR = 0x180e;
const HANGUL_CHOSEONG_FILLER = 0x115f;
const HANGUL_JUNGSEONG_FILLER = 0x1160;
const HANGUL_FILLER = 0x3164;
const INVISIBLE_MATH_OPERATORS = [0x2061, 0x2064]; // FUNCTION APPLICATION..INVISIBLE PLUS
const LINE_SEPARATOR = 0x2028;
const PARAGRAPH_SEPARATOR = 0x2029;
const SANITIZED_PATH_MAX_LENGTH = 500;

function inRange(code, [lo, hi]) {
  return code >= lo && code <= hi;
}

function sanitizePath(filePath) {
  // Strip control chars (including null), bidi overrides, separators,
  // and the dangerous invisible characters defined by the constants
  // above (mirroring scripts/ci/check-unicode-safety.js), so a denial
  // message cannot carry content a human reviewer cannot see.
  let sanitized = '';
  for (const char of String(filePath || '')) {
    const code = char.codePointAt(0);
    const isAsciiControl =
      code <= ASCII_CONTROL_MAX || code === ASCII_DELETE || inRange(code, C1_CONTROLS);
    const isBidiOverride =
      inRange(code, BIDI_MARKS) || inRange(code, BIDI_EMBEDDINGS) || inRange(code, BIDI_ISOLATES);
    const isUnicodeSeparator = code === LINE_SEPARATOR || code === PARAGRAPH_SEPARATOR;
    const isDangerousInvisible =
      inRange(code, ZERO_WIDTHS) ||
      code === WORD_JOINER ||
      code === BYTE_ORDER_MARK ||
      inRange(code, VARIATION_SELECTORS) ||
      inRange(code, VARIATION_SUPPLEMENTS) ||
      inRange(code, TAG_BLOCK) ||
      code === MONGOLIAN_VOWEL_SEPARATOR ||
      code === HANGUL_CHOSEONG_FILLER ||
      code === HANGUL_JUNGSEONG_FILLER ||
      code === HANGUL_FILLER ||
      inRange(code, INVISIBLE_MATH_OPERATORS);
    sanitized += isAsciiControl || isBidiOverride || isUnicodeSeparator || isDangerousInvisible ? ' ' : char;
  }
  return sanitized.trim().slice(0, SANITIZED_PATH_MAX_LENGTH);
}

function normalizeForMatch(value) {
  return String(value || '')
    .replace(/\\/g, '/')
    .toLowerCase();
}

function isClaudeSettingsPath(filePath) {
  const normalized = normalizeForMatch(filePath);
  return /(^|\/)\.claude\/settings(?:\.[^/]+)?\.json$/.test(normalized);
}

function isReadOnlyGitIntrospection(command) {
  const trimmed = String(command || '').trim();
  if (!trimmed || /[\r\n;&|><`$()]/.test(trimmed)) {
    return false;
  }

  const segments = splitCommandSegments(trimmed);
  if (segments.length !== 1) {
    return false;
  }

  const tokens = tokenizeAllowlistedShellWords(trimmed);
  if (!tokens) {
    return false;
  }
  if (commandBasename(tokens[0]) !== 'git' || tokens.length < 2) {
    return false;
  }

  const subcommand = tokens[1].toLowerCase();
  const args = tokens.slice(2);

  if (subcommand === 'status') {
    return args.every(arg => ['--porcelain', '--short', '--branch'].includes(arg));
  }

  if (subcommand === 'diff') {
    const allowedDiffArgs = new Set(['--name-only', '--name-status', '--cached', '--staged', '--stat']);
    // git diff without arguments is read-only introspection
    if (args.length === 0) return true;
    return args.length <= 2 && args.every(arg => allowedDiffArgs.has(arg));
  }

  if (subcommand === 'log') {
    return args.every(arg => arg === '--oneline' || /^--max-count=\d+$/.test(arg));
  }

  if (subcommand === 'show') {
    // Permite: git show <ref>, git show --stat, git show --name-only,
    // git show <ref> --stat, git show <ref> --name-only
    if (args.length === 0) return false;
    if (args.length === 1) {
      const arg = args[0];
      if (arg === '--stat' || arg === '--name-only') return true;
      // ref
      return !arg.startsWith('--') && /^[a-zA-Z0-9._:/ -]+$/.test(arg);
    }
    if (args.length === 2) {
      const [first, second] = args;
      // ref + flag
      if (!first.startsWith('--') && /^[a-zA-Z0-9._:/ -]+$/.test(first) && (second === '--stat' || second === '--name-only')) {
        return true;
      }
      return false;
    }
    return false;
  }

  if (subcommand === 'branch') {
    return args.length === 1 && args[0] === '--show-current';
  }

  if (subcommand === 'rev-parse') {
    return args.length === 2 && args[0] === '--abbrev-ref' && /^head$/i.test(args[1]);
  }

  return false;
}

// --- Gate messages ---

/**
 * Batch-consistency warning (#3136). A first-touch denial marks the file
 * checked so the retry passes; a parallel batch of edits to one
 * not-yet-touched file therefore partially applies (first call denied,
 * siblings allowed). Hooks see calls one at a time and cannot lock a
 * batch, so the denial must say this out loud: name the file and tell
 * the agent that siblings may already have been applied.
 */
function batchSiblingWarning(safePath) {
  return (
    `If this call was sent in a parallel batch, other edits to ${safePath} from that batch ` +
    'may already have been applied. Re-read the file before building on them.'
  );
}

function editGateMsg(filePath) {
  const safe = sanitizePath(filePath);
  return [
    '[Fact-Forcing Gate]',
    '',
    `Before editing ${safe}, present these facts:`,
    '',
    '1. List ALL files that import/require this file (search the tree — Glob/Grep, or find/grep via Bash)',
    '2. List the public functions/classes affected by this change',
    '3. If this file reads/writes data files, show field names, structure, and date format (use redacted or synthetic values, not raw production data)',
    "4. Quote the user's current instruction verbatim",
    '',
    batchSiblingWarning(safe),
    '',
    'Present the facts, then retry the same operation.'
  ].join('\n');
}

function writeGateMsg(filePath) {
  const safe = sanitizePath(filePath);
  return [
    '[Fact-Forcing Gate]',
    '',
    `Before creating ${safe}, present these facts:`,
    '',
    '1. Name the file(s) and line(s) that will call this new file',
    '2. Confirm no existing file serves the same purpose (search the tree — Glob/Grep, or find/grep via Bash)',
    '3. If this file reads/writes data files, show field names, structure, and date format (use redacted or synthetic values, not raw production data)',
    "4. Quote the user's current instruction verbatim",
    '',
    batchSiblingWarning(safe),
    '',
    'Present the facts, then retry the same operation.'
  ].join('\n');
}

function classGateMsg(filePath, cls, isWrite) {
  const safe = sanitizePath(filePath);
  const questions = [...CLASS_QUESTIONS[cls](isWrite), QUOTE_INSTRUCTION];
  return [
    '[Fact-Forcing Gate]',
    '',
    `Before ${isWrite ? 'creating' : 'editing'} ${safe}, present these facts:`,
    '',
    ...questions.map((question, index) => `${index + 1}. ${question}`),
    '',
    batchSiblingWarning(safe),
    '',
    'Present the facts, then retry the same operation.'
  ].join('\n');
}

/** Full first-touch denial; code targets keep the editGateMsg/writeGateMsg text. */
function firstTouchGateMsg(filePath, isWrite, cls) {
  if (!CLASS_QUESTIONS[cls]) {
    return isWrite ? writeGateMsg(filePath) : editGateMsg(filePath);
  }
  return classGateMsg(filePath, cls, isWrite);
}

/**
 * Condensed single-line denial used after the full-block budget is spent
 * (#2142). Carries the denial ordinal so consecutive denials differ
 * textually, and a one-line recovery hint instead of the multi-line block.
 * Non-code classes swap the middle clause for a class-specific hint.
 */
function condensedGateMsg(action, filePath, ordinal, cls = 'code', sensitive = false) {
  const safe = sanitizePath(filePath);
  const hint = CLASS_CONDENSED_HINTS[cls]
    ? CLASS_CONDENSED_HINTS[cls](action === 'creation')
    : "briefly state importers/callers, affected API, data schemas if any, and the user's verbatim instruction, then retry.";
  return (
    `[Fact-Forcing Gate] (denial #${ordinal} this session) First ${action} of ${safe}: ` +
    `${hint} ` +
    `${batchSiblingWarning(safe)} ` +
    (sensitive ? `${SENSITIVE_TARGET_NOTE} ` : '') +
    '(Use GATEGUARD_EXEMPT_GLOBS for path-scoped exemptions; GATEGUARD_FACT_FORCE_MAX_DENIALS caps denials per session; ECC_GATEGUARD=off disables this gate.)'
  );
}

const SENSITIVE_TARGET_NOTE = 'Sensitive target: prior-search credit, sibling collapse, and the denial cap do not apply.';
const RETRY_LINE = 'Present the facts, then retry the same operation.';

function withSensitiveNote(message) {
  const at = message.lastIndexOf(RETRY_LINE);
  if (at < 0) return `${message}\n\n${SENSITIVE_TARGET_NOTE}`;
  return `${message.slice(0, at)}${SENSITIVE_TARGET_NOTE}\n\n${message.slice(at)}`;
}

function firstTouchDenial(filePath, { isWrite, denials, cls, sensitive }) {
  if (denials > getFullDenialBudget()) {
    const action = isWrite ? 'creation' : 'edit';
    return denyResult(condensedGateMsg(action, filePath, denials, cls, sensitive), { includeRecoveryHint: false });
  }
  const message = firstTouchGateMsg(filePath, isWrite, cls);
  return denyResult(sensitive ? withSensitiveNote(message) : message, {
    narrowRecoveryHint: EDIT_WRITE_NARROW_RECOVERY_HINT
  });
}

function destructiveBashMsg() {
  return [
    '[Fact-Forcing Gate]',
    '',
    'Destructive command detected. Before running, present:',
    '',
    '1. List all files/data this command will modify or delete',
    '2. Write a one-line rollback procedure',
    "3. Quote the user's current instruction verbatim",
    '',
    'Present the facts, then retry the same operation.'
  ].join('\n');
}

function routineShellMsg(toolName) {
  const shellName = toolName === 'PowerShell' ? 'PowerShell' : 'Bash';
  return [
    '[Fact-Forcing Gate]',
    '',
    `Before the first ${shellName} command this session, present these facts:`,
    '',
    '1. The current user request in one sentence',
    '2. What this specific command verifies or produces',
    '',
    'Present the facts, then retry the same operation.'
  ].join('\n');
}

function withRecoveryHint(message, hookIds = [EDIT_WRITE_HOOK_ID], narrowRecoveryHint = '') {
  const disableTargets = hookIds.map(hookId => `\`${hookId}\``).join(' or ');
  const recoveryLines = narrowRecoveryHint ? [narrowRecoveryHint, ''] : [];
  return [
    message,
    '',
    ...recoveryLines,
    `Recovery: if GateGuard is blocking setup or repair work, run this session with \`ECC_GATEGUARD=off\` or add ${disableTargets} to \`ECC_DISABLED_HOOKS\`.`
  ].join('\n');
}

function isSubagentInvocation(data) {
  if (!data || typeof data !== 'object') {
    return false;
  }

  const candidates = [data.agent_id, data.agentId, data.parent_tool_use_id, data.parentToolUseId];

  return candidates.some(candidate => typeof candidate === 'string' && candidate.trim());
}

// --- Deny helper ---

function denyResult(reason, options = {}) {
  const includeRecoveryHint = options.includeRecoveryHint !== false;
  const hookIds = Array.isArray(options.hookIds) && options.hookIds.length > 0 ? options.hookIds : [EDIT_WRITE_HOOK_ID];
  const narrowRecoveryHint = typeof options.narrowRecoveryHint === 'string' ? options.narrowRecoveryHint : '';
  return {
    stdout: JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: includeRecoveryHint
          ? withRecoveryHint(reason, hookIds, narrowRecoveryHint)
          : reason
      }
    }),
    exitCode: 0
  };
}

function allowWithStateWarning() {
  return {
    stderr: '[Fact-Forcing Gate] GateGuard state could not be persisted; allowing this operation to avoid a permanent retry loop. Check GATEGUARD_STATE_DIR or filesystem permissions.',
    exitCode: 0
  };
}

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
const CREDIT_DETAIL_MAX_CHARS = 80;
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

/** A directory change anywhere in the turn makes relative shell paths unreliable. */
function turnChangesDirectory(shellCommands) {
  if (!Array.isArray(shellCommands)) return false;
  return shellCommands.some(command => {
    if (typeof command !== 'string') return false;
    if (command.length > MAX_SEARCH_COMMAND_CHARS) return true;
    return quoteAwareSegments(command).some(tokens => DIRECTORY_CHANGE_COMMANDS.has(commandBasename(tokens[0])));
  });
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

function creditNote(match, filePath) {
  const chars = Array.from(sanitizePath(match.detail).replace(/\s+/g, ' '));
  const detail = chars.length > CREDIT_DETAIL_MAX_CHARS ? `${chars.slice(0, CREDIT_DETAIL_MAX_CHARS - 3).join('')}...` : chars.join('');
  const calls = `${match.callsAgo} tool call${match.callsAgo === 1 ? '' : 's'} ago`;
  return (
    `[Fact-Forcing Gate] Prior search seen in this turn (${match.name} ${detail}, ${calls}); ` +
    `first-touch check satisfied for ${sanitizePath(filePath)}.`
  );
}

/** Only a positively absent target is new; any other fs error counts as existing. */
function isMissingOnDisk(resolved) {
  try {
    fs.lstatSync(resolved);
    return false;
  } catch (error) {
    return Boolean(error) && error.code === 'ENOENT';
  }
}

function isNewFileTarget(filePath, data) {
  try {
    const target = resolveTargetPath(filePath, data);
    return Boolean(target) && isMissingOnDisk(target.resolved);
  } catch (_) {
    return false;
  }
}

function newFileGateKey(filePath, data, cls) {
  try {
    const dir = collapseGateDir(filePath, data, cls);
    return dir ? dirGateKey(cls, dir) : null;
  } catch (_) {
    return null;
  }
}

function siblingNote(gate) {
  return (
    `[Fact-Forcing Gate] Sibling of ${sanitizePath(gate.first)} (gated earlier at denial #${gate.ordinal} this session); ` +
    'proceeding without a repeat denial.'
  );
}

// --- Core logic (exported for run-with-flags.js) ---

function run(rawInput) {
  let data;
  try {
    data = typeof rawInput === 'string' ? JSON.parse(rawInput) : rawInput;
  } catch (_) {
    return rawInput; // allow on parse error
  }

  if (isGateGuardDisabled()) {
    return rawInput;
  }

  activeStateFile = null;
  getStateFile(data);

  const rawToolName = data.tool_name || '';
  const toolInput = data.tool_input || {};
  // Normalize: case-insensitive matching via lookup map
  const TOOL_MAP = { edit: 'Edit', write: 'Write', multiedit: 'MultiEdit', bash: 'Bash', powershell: 'PowerShell' };
  const toolName = TOOL_MAP[rawToolName.toLowerCase()] || rawToolName;
  const inSubagent = isSubagentInvocation(data);
  const getTurnScan = createTurnScanner(data);

  if (toolName === 'Edit' || toolName === 'Write') {
    const filePath = toolInput.file_path || '';
    if (!filePath || isClaudeSettingsPath(filePath) || isExemptPath(filePath, data)) {
      return rawInput; // allow
    }

    if (inSubagent) {
      return rawInput; // parent session already passed the first-touch file gate
    }

    const fileKey = canonicalPathKey(filePath, data);
    if (!isChecked([fileKey, filePath])) {
      const isNewFile = toolName === 'Write' && isNewFileTarget(filePath, data);
      const cls = classifyTargetFor(filePath, data);
      // Sensitive targets skip credit, sibling collapse and the cap.
      const sensitive = isSensitiveTargetFor(filePath, data);
      const credit = sensitive ? null : findCreditingSearch(getTurnScan(), filePath, isNewFile, data);
      if (credit) {
        if (!markCheckedAndCountCredit(fileKey, cls)) {
          return allowWithStateWarning();
        }
        return { additionalContext: creditNote(credit, filePath), exitCode: 0 };
      }
      const turnId = isNewFile && !sensitive ? currentTurnId(getTurnScan()) : null;
      // The 120 s no-turn rule applies only without any transcript; an unusable one never collapses.
      const collapsible = isNewFile && !sensitive && (turnId !== null || !transcriptPathFor(data));
      const gateKey = collapsible ? newFileGateKey(filePath, data, cls) : null;
      const sibling = gateKey ? findSiblingGate(gateKey, turnId) : null;
      if (sibling) {
        if (!markCheckedAndCountSibling(fileKey)) {
          return allowWithStateWarning();
        }
        return { additionalContext: siblingNote(sibling), exitCode: 0 };
      }
      const dirGate = gateKey ? { key: gateKey, turn: turnId, first: sanitizePath(filePath) } : undefined;
      const cap = sensitive ? Number.POSITIVE_INFINITY : getMaxDenialBudget();
      const { ok, denials } = markCheckedAndCountDenial(fileKey, { cls, dirGate, cap });
      if (!ok) {
        return allowWithStateWarning();
      }
      if (denials === null) {
        return rawInput; // session denial cap reached (GATEGUARD_FACT_FORCE_MAX_DENIALS)
      }
      return firstTouchDenial(filePath, { isWrite: toolName === 'Write', denials, cls, sensitive });
    }

    return rawInput; // allow
  }

  if (toolName === 'MultiEdit') {
    if (inSubagent) {
      return rawInput; // parent session already passed the first-touch file gate
    }

    const edits = toolInput.edits || [];
    const creditNotes = [];
    for (const edit of edits) {
      const filePath = edit.file_path || '';
      if (!filePath || isClaudeSettingsPath(filePath) || isExemptPath(filePath, data)) continue;
      const fileKey = canonicalPathKey(filePath, data);
      if (!isChecked([fileKey, filePath])) {
        const cls = classifyTargetFor(filePath, data);
        const sensitive = isSensitiveTargetFor(filePath, data);
        const credit = sensitive ? null : findCreditingSearch(getTurnScan(), filePath, false, data);
        if (credit) {
          if (!markCheckedAndCountCredit(fileKey, cls)) {
            return allowWithStateWarning();
          }
          creditNotes.push(creditNote(credit, filePath));
          continue;
        }
        const cap = sensitive ? Number.POSITIVE_INFINITY : getMaxDenialBudget();
        const { ok, denials } = markCheckedAndCountDenial(fileKey, { cls, cap });
        if (!ok) {
          return allowWithStateWarning();
        }
        if (denials === null) {
          continue; // session denial cap reached (GATEGUARD_FACT_FORCE_MAX_DENIALS)
        }
        return firstTouchDenial(filePath, { isWrite: false, denials, cls, sensitive });
      }
    }
    if (creditNotes.length > 0) {
      return { additionalContext: creditNotes, exitCode: 0 };
    }
    return rawInput; // allow
  }

  if (toolName === 'Bash' || toolName === 'PowerShell') {
    const command = toolInput.command || '';
    if (isReadOnlyGitIntrospection(command)) {
      return rawInput;
    }

    if (classifyDestructiveCommand(toolName, command).length > 0) {
      // Gate destructive commands on first attempt; allow retry after facts presented
      const key = '__destructive__' + crypto.createHash('sha256').update(command).digest('hex').slice(0, 16);
      if (!isChecked(key)) {
        if (!markChecked(key)) {
          return allowWithStateWarning();
        }
        return denyResult(destructiveBashMsg(), { includeRecoveryHint: false });
      }
      return rawInput; // allow retry after facts presented
    }

    // Operator opt-out: skip the routine shell gate entirely. The destructive
    // gate above still fires. This is the documented escape hatch for hosts
    // (Cursor, OpenCode, etc.) where the once-per-session routine gate is
    // friction without signal.
    if (isRoutineBashGateDisabled()) {
      return rawInput; // routine gate opted out via env
    }

    if (!isChecked(ROUTINE_BASH_SESSION_KEY)) {
      if (!markChecked(ROUTINE_BASH_SESSION_KEY)) {
        return allowWithStateWarning();
      }
      const hookId = toolName === 'PowerShell' ? POWERSHELL_HOOK_ID : BASH_HOOK_ID;
      const narrowRecoveryHint = toolName === 'PowerShell'
        ? ROUTINE_POWERSHELL_NARROW_RECOVERY_HINT
        : ROUTINE_BASH_NARROW_RECOVERY_HINT;
      return denyResult(routineShellMsg(toolName), {
        hookIds: [hookId],
        narrowRecoveryHint
      });
    }

    return rawInput; // allow
  }

  return rawInput; // allow
}

module.exports = { classifyDestructiveCommand, classifyTarget, classifyTargetFor, findCreditingSearch, run, scanCurrentTurn };
