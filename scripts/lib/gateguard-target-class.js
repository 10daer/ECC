/**
 * GateGuard target identity and classification for first-touch
 * Edit/Write/MultiEdit targets: canonical path keys, target classes and their
 * questions, sensitive-target detection, and sibling-collapse eligibility.
 * Stateless; filesystem access is limited to worktree `.git` checks and
 * realpath/lstat of the target's parent chain.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const WINDOWS_PATH_PATTERN = /^[a-z]:[\\/]|^\\\\/i;

/** Canonical checked-state key, so `a.py`, `./a.py` and the absolute path share one gate. */
function canonicalPathKey(filePath, data) {
  try {
    const target = resolveTargetPath(filePath, data);
    if (!target) return filePath;
    const key = target.resolved.replace(/\\/g, '/');
    return target.isWin ? key.toLowerCase() : key;
  } catch (_) {
    return filePath;
  }
}

/**
 * Resolve a target to the file the tool will touch. Relative paths resolve
 * against the tool's `cwd` first; this deliberately differs from
 * `isExemptPath`, whose globs are project-relative.
 */
function resolveTargetPath(filePath, data) {
  const base = (data && data.cwd) || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  if (typeof base !== 'string' || typeof filePath !== 'string') return null;
  const isWin = WINDOWS_PATH_PATTERN.test(base) || WINDOWS_PATH_PATTERN.test(filePath);
  const paths = isWin ? path.win32 : path.posix;
  if (!paths.isAbsolute(base)) return null;
  return { resolved: paths.resolve(base, filePath), isWin };
}

// --- Target classes ---

const INSTRUCTION_BASENAMES = new Set([
  'claude.md',
  'agents.md',
  'agent.md',
  'gemini.md',
  'skill.md',
  'copilot-instructions.md',
  '.cursorrules',
  '.windsurfrules'
]);
// Cursor rule files are instructions wherever they live.
const INSTRUCTION_ANYWHERE_EXTS = new Set(['.mdc']);
const INSTRUCTION_DIRS = new Set(['.claude', 'agents', 'commands', 'skills', 'rules', 'hooks', '.cursor', '.codex', '.opencode']);
const INSTRUCTION_EXTS = new Set(['.md', '.mdx', '.txt']);
const TEST_DIRS = new Set(['tests', 'test', '__tests__']);
const TEST_BASENAME_PATTERN = /\.(test|spec)\.|^test_.*\.py$|_test\.(py|go)$/;
const PROSE_EXTS = new Set(['.md', '.mdx', '.txt', '.rst', '.adoc']);
const CONFIG_EXTS = new Set(['.json', '.jsonc', '.yaml', '.yml', '.toml', '.ini']);
const ENV_BASENAME_PATTERN = /^\.env($|\.)/;
// `.env.example.ts` and friends are source files that happen to start with `.env`.
const CODE_EXTS = new Set(['.ts', '.js', '.mjs', '.cjs', '.py', '.go', '.rs', '.java', '.rb']);

/** Classify a path; first match wins: instruction, test, prose, config, code (the fallback). */
function classifyTarget(filePath) {
  try {
    const normalized = String(filePath || '').replace(/\\/g, '/').toLowerCase();
    const segments = normalized.split('/').filter(Boolean);
    const base = segments.pop() || '';
    const ext = path.posix.extname(base);
    if (INSTRUCTION_BASENAMES.has(base) || INSTRUCTION_ANYWHERE_EXTS.has(ext)) return 'instruction';
    if (INSTRUCTION_EXTS.has(ext) && segments.some(segment => INSTRUCTION_DIRS.has(segment))) return 'instruction';
    if (ext === '.md' && base.includes('instructions') && segments.includes('.github')) return 'instruction';
    if (TEST_BASENAME_PATTERN.test(base) || segments.some(segment => TEST_DIRS.has(segment))) return 'test';
    if (PROSE_EXTS.has(ext)) return 'prose';
    if (CONFIG_EXTS.has(ext) || (ENV_BASENAME_PATTERN.test(base) && !CODE_EXTS.has(ext))) return 'config';
    return 'code';
  } catch (_) {
    return 'code';
  }
}

const WORKTREE_PREFIX_PATTERN = /^\.claude\/worktrees\/([^/]+)\//;

/** A Windows-style path has no real location on a POSIX host, and vice versa. */
function isHostPathStyle(isWin) {
  return isWin === (process.platform === 'win32');
}

function foldKey(nativePath, isWin) {
  const key = nativePath.replace(/\\/g, '/');
  return isWin ? key.toLowerCase() : key;
}

/** Project root, resolved the way `isExemptPath` resolves it (CLAUDE_PROJECT_DIR first). */
function canonicalProjectRoot(data) {
  const root = process.env.CLAUDE_PROJECT_DIR || (data && data.cwd) || process.cwd();
  if (typeof root !== 'string') return null;
  const isWin = WINDOWS_PATH_PATTERN.test(root);
  const paths = isWin ? path.win32 : path.posix;
  if (!paths.isAbsolute(root)) return null;
  const native = paths.resolve(root);
  return { key: foldKey(native, isWin), native, isWin };
}

/** Only a real worktree (its `.git` exists) has its prefix stripped; otherwise the path stays under `.claude`. */
function isRealWorktree(rootNative, isWin, name) {
  if (!isHostPathStyle(isWin)) return false;
  const paths = isWin ? path.win32 : path.posix;
  return fs.existsSync(paths.join(rootNative, '.claude', 'worktrees', name, '.git'));
}

// Windows ignores trailing dots/spaces and treats `name:stream` as `name`.
const STREAM_MARKER = '::$';

/** Normalize segments as Windows resolves them, so `CLAUDE.md.` and `CLAUDE.md::$DATA` name `CLAUDE.md`. */
function normalizeWindowsSegments(classPath, isWin) {
  const segments = classPath.split('/');
  const last = segments.length - 1;
  return segments
    .map((segment, index) => {
      if (!isWin && !segment.includes(STREAM_MARKER)) return segment;
      let name = segment;
      const colon = name.indexOf(':');
      if (index === last && colon > 0) name = name.slice(0, colon);
      name = name.replace(/[. ]+$/, '');
      return name || segment;
    })
    .join('/');
}

/** Project-relative class path for a canonical key, or null when it is outside the root. */
function projectRelativeClassPath(key, root, isWin) {
  const target = isWin ? key.toLowerCase() : key;
  const rootKey = isWin ? root.key.toLowerCase() : root.key;
  const prefix = rootKey.endsWith('/') ? rootKey : `${rootKey}/`;
  if (!target.startsWith(prefix)) return null;
  let relative = key.slice(prefix.length);
  const worktree = relative.match(WORKTREE_PREFIX_PATTERN);
  if (worktree && isRealWorktree(root.native, root.isWin, worktree[1])) relative = relative.slice(worktree[0].length);
  return normalizeWindowsSegments(relative, isWin);
}

/**
 * The path a target is classified by: project-relative, so an ancestor such as
 * `/home/me/tests/proj` never leaks into the class, with a real worktree prefix
 * stripped. Targets outside the root keep their absolute path.
 */
function classPathFor(filePath, data) {
  try {
    const key = canonicalPathKey(filePath, data);
    const root = canonicalProjectRoot(data);
    const isWin = Boolean(root && root.isWin) || WINDOWS_PATH_PATTERN.test(key);
    if (!root) return normalizeWindowsSegments(key, isWin);
    const relative = projectRelativeClassPath(key, root, isWin);
    return relative === null ? normalizeWindowsSegments(key, isWin) : relative;
  } catch (_) {
    return filePath;
  }
}

/** Class of a hook target, judged on its project-relative path. */
function classifyTargetFor(filePath, data) {
  return classifyTarget(classPathFor(filePath, data));
}

const SEARCH_THE_TREE = '(search the tree — Glob/Grep, or find/grep via Bash)';
const QUOTE_INSTRUCTION = "Quote the user's current instruction verbatim";

const CLASS_QUESTIONS = {
  instruction: () => [
    'Name the harness/loader that reads this file (Claude Code, Codex, Cursor, OpenCode, …) and when it loads it',
    'Describe what agent behaviour changes as a result',
    `Confirm no existing instruction, skill, or agent file already covers this ${SEARCH_THE_TREE}`
  ],
  test: () => [
    'Name what behaviour is under test and which module/function it exercises',
    `Name the existing test file(s) covering this module, or confirm none exist ${SEARCH_THE_TREE}`
  ],
  prose: isWrite =>
    isWrite
      ? [
        `Name any existing doc this supersedes or duplicates ${SEARCH_THE_TREE}`,
        'State where it will be linked or referenced from',
        'Explain why a new file rather than editing an existing one'
      ]
      : [
        `List other docs or code that reference the section being changed ${SEARCH_THE_TREE}`,
        'State what the change corrects or adds'
      ],
  config: () => [
    'Name which process/tool reads this file and when',
    'Describe the effect of the change',
    'Confirm no secrets or credentials are being written in plain text'
  ]
};

const CLASS_CONDENSED_HINTS = {
  instruction: () =>
    "briefly state which harness loads this file, the agent behaviour it changes, that no existing instruction file covers it, and the user's verbatim instruction, then retry.",
  test: () =>
    "briefly state the behaviour and module under test, existing test files for it (or none), and the user's verbatim instruction, then retry.",
  prose: isWrite =>
    isWrite
      ? "briefly state what this supersedes, where it is linked from, and the user's verbatim instruction, then retry."
      : "briefly state what references the changed section, what the change corrects or adds, and the user's verbatim instruction, then retry.",
  config: () =>
    "briefly state which process reads this file, the effect of the change, that no secrets are written in plain text, and the user's verbatim instruction, then retry."
};

// --- Sensitive targets ---
// Secrets, keys, auth/payment code, migrations and CI workflows always draw the
// first-touch denial. Basename and segment rules are exact, never substrings.

const SENSITIVE_EXTS = new Set(['.pem', '.key', '.p12', '.pfx']);
const SENSITIVE_BASENAME_PATTERN = /^(\.env($|\.)|id_rsa|id_ed25519|credentials|secrets\.)/;
const SENSITIVE_SEGMENTS = new Set(['auth', 'authn', 'authz', 'security', 'secrets', 'payment', 'payments', 'billing', 'migrations']);
const SENSITIVE_PREFIX = '.github/workflows/';

/** True for a sensitive class path; any error or non-string input is sensitive. */
function isSensitiveTarget(classPath) {
  try {
    if (typeof classPath !== 'string' || !classPath) return true;
    const normalized = classPath.replace(/\\/g, '/').toLowerCase();
    const segments = normalized.split('/').filter(Boolean);
    const base = segments[segments.length - 1] || '';
    if (SENSITIVE_BASENAME_PATTERN.test(base) || SENSITIVE_EXTS.has(path.posix.extname(base))) return true;
    if (segments.some(segment => SENSITIVE_SEGMENTS.has(segment))) return true;
    // Also matched below an ancestor (unverified worktree, target outside the root): fail safe.
    return `/${segments.join('/')}`.includes(`/${SENSITIVE_PREFIX}`);
  } catch (_) {
    return true;
  }
}

/**
 * Sensitive on the lexical path or on the real (symlink-resolved) location, so
 * `src/tools -> ../auth` cannot launder `src/tools/login.py`. Any error is sensitive.
 */
function isSensitiveTargetFor(filePath, data) {
  try {
    if (typeof filePath !== 'string' || !filePath) return true;
    if (isSensitiveTarget(classPathFor(filePath, data))) return true;
    return isSensitiveRealTarget(filePath, data);
  } catch (_) {
    return true;
  }
}

/** Unresolvable real locations (dangling symlink, ENOTDIR, EACCES, loops) count as sensitive. */
function isSensitiveRealTarget(filePath, data) {
  const target = resolveTargetPath(filePath, data);
  if (!target || !isHostPathStyle(target.isWin)) return false;
  const paths = target.isWin ? path.win32 : path.posix;
  const real = realTargetPath(target.resolved, paths);
  if (!real) return true;
  const realKey = foldKey(real, target.isWin);
  if (realKey === foldKey(target.resolved, target.isWin)) return false;
  const root = canonicalProjectRoot(data);
  if (root && root.isWin === target.isWin) {
    const realRoot = realpathOfNearestAncestor(root.native, paths);
    if (!realRoot) return true;
    const realRootInfo = { ...root, key: foldKey(realRoot, target.isWin), native: realRoot };
    const realClassPath = projectRelativeClassPath(realKey, realRootInfo, target.isWin);
    if (realClassPath !== null) return isSensitiveTarget(realClassPath);
  }
  return isSensitiveTarget(normalizeWindowsSegments(realKey, target.isWin));
}

// --- Sibling collapse eligibility ---

const COLLAPSIBLE_CLASSES = new Set(['code', 'test', 'prose']);
// 8.3 short names (`CLAUDE~1`) can alias any directory, including dot-directories.
const SHORT_NAME_PATTERN = /~\d/;

/** Harness and tooling directories are dot-directories, so any dot segment blocks collapse. */
function isCollapsibleClassPath(classPath, cls) {
  if (!COLLAPSIBLE_CLASSES.has(cls)) return false;
  const segments = String(classPath).toLowerCase().split('/').filter(Boolean);
  if (segments.length === 0) return false;
  return !segments.some(segment => segment.startsWith('.') || SHORT_NAME_PATTERN.test(segment));
}

/** Lexical collapse screen; `collapseGateDir` adds the real-directory screen. */
function isCollapsibleTarget(filePath, data, cls) {
  return isCollapsibleClassPath(classPathFor(filePath, data), cls);
}

/** Realpath of a directory via its nearest existing ancestor; null on any error but a plain missing entry. */
function realpathOfNearestAncestor(nativePath, paths) {
  const realpath = fs.realpathSync.native || fs.realpathSync;
  const missing = [];
  let current = nativePath;
  for (;;) {
    try {
      const real = realpath(current);
      if (!fs.statSync(real).isDirectory()) return null;
      return missing.length > 0 ? paths.join(real, ...missing.reverse()) : real;
    } catch (error) {
      if (!error || error.code !== 'ENOENT' || !isMissingEntry(current)) return null;
      const parent = paths.dirname(current);
      if (parent === current) return null;
      missing.push(paths.basename(current));
      current = parent;
    }
  }
}

/** Real path of a file target, or of its nearest existing ancestor plus the missing tail. */
function realTargetPath(resolved, paths) {
  const realpath = fs.realpathSync.native || fs.realpathSync;
  try {
    return realpath(resolved);
  } catch (error) {
    if (!error || error.code !== 'ENOENT' || !isMissingEntry(resolved)) return null;
  }
  const realDir = realpathOfNearestAncestor(paths.dirname(resolved), paths);
  return realDir ? paths.join(realDir, paths.basename(resolved)) : null;
}

/** True when nothing (not even a dangling symlink) exists at the path. */
function isMissingEntry(nativePath) {
  try {
    fs.lstatSync(nativePath);
    return false;
  } catch (error) {
    return Boolean(error) && error.code === 'ENOENT';
  }
}

/**
 * Real directory a new file's sibling gate is keyed by, or null when it may not
 * collapse. A symlinked directory must keep the class and pass the same screen,
 * so `src/tools -> .claude/hooks` never collapses.
 */
function collapseGateDir(filePath, data, cls) {
  try {
    if (!isCollapsibleTarget(filePath, data, cls)) return null;
    const target = resolveTargetPath(filePath, data);
    if (!target || !isHostPathStyle(target.isWin)) return null;
    const paths = target.isWin ? path.win32 : path.posix;
    const lexicalDir = paths.dirname(target.resolved);
    const realDir = realpathOfNearestAncestor(lexicalDir, paths);
    if (!realDir) return null;
    const realKey = foldKey(realDir, target.isWin);
    if (realKey === foldKey(lexicalDir, target.isWin)) return realKey;
    const root = canonicalProjectRoot(data);
    if (!root || root.isWin !== target.isWin) return null;
    const realRoot = realpathOfNearestAncestor(root.native, paths);
    if (!realRoot) return null;
    const realTargetKey = foldKey(paths.join(realDir, paths.basename(target.resolved)), target.isWin);
    const realClassPath = projectRelativeClassPath(realTargetKey, { ...root, key: foldKey(realRoot, target.isWin), native: realRoot }, target.isWin);
    if (realClassPath === null || classifyTarget(realClassPath) !== cls) return null;
    if (isSensitiveTarget(realClassPath)) return null;
    return isCollapsibleClassPath(realClassPath, cls) ? realKey : null;
  } catch (_) {
    return null;
  }
}

module.exports = {
  WINDOWS_PATH_PATTERN,
  COLLAPSIBLE_CLASSES,
  CLASS_QUESTIONS,
  CLASS_CONDENSED_HINTS,
  QUOTE_INSTRUCTION,
  resolveTargetPath,
  canonicalPathKey,
  classifyTarget,
  classPathFor,
  classifyTargetFor,
  isCollapsibleTarget,
  collapseGateDir,
  isSensitiveTarget,
  isSensitiveTargetFor
};
