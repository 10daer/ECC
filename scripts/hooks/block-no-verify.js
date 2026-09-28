#!/usr/bin/env node
/**
 * PreToolUse Hook: Block --no-verify flag
 *
 * Blocks git hook-bypass flags (--no-verify, -c core.hooksPath=) to protect
 * pre-commit, commit-msg, and pre-push hooks from being skipped by AI agents.
 *
 * Replaces the previous npx-based invocation that failed in pnpm-only projects
 * (EBADDEVENGINES) and could not be disabled via ECC_DISABLED_HOOKS.
 *
 * Exit codes:
 *   0 = allow (not a git command or no bypass flags)
 *   2 = block (bypass flag detected)
 */

'use strict';

const { createBudget, scanShell } = require('./lib/shell-scan');

const MAX_STDIN = 1024 * 1024;
let raw = '';

// Git config section and variable names are case-insensitive
// (subsection names are case-sensitive but core.hooksPath has none),
// so we normalize the candidate token to lowercase before matching.
// See https://git-scm.com/docs/git-config — "The variable names are
// case-insensitive."
const GIT_CONFIG_KEY_PREFIX = 'core.hookspath=';

const COMMIT_OPTIONS_WITH_VALUE = new Set([
  '-m',
  '--message',
  '-F',
  '--file',
  '-C',
  '--reuse-message',
  '-c',
  '--reedit-message',
  '--author',
  '--date',
  '--template',
  '--fixup',
  '--squash',
  '--pathspec-from-file'
]);

const COMMIT_OPTIONS_WITH_INLINE_VALUE = ['--message=', '--file=', '--reuse-message=', '--reedit-message=', '--author=', '--date=', '--template=', '--fixup=', '--squash=', '--pathspec-from-file='];

// Short options that take a value. When seen as part of a combined
// short-option token (e.g. -tn), git's parser treats the rest of the
// token as the option's value (template path 'n' here), so the scanner
// must stop at this character — anything after it is the inline value,
// not another flag.
const COMMIT_SHORT_OPTIONS_WITH_VALUE = new Set(['m', 'F', 'C', 'c', 't']);
// Short options whose value is OPTIONAL and must be stuck to the flag
// (`-uno`, `-S<keyid>`). The rest of the cluster is that value, so an `n`
// after them is not the -n flag: `git commit -uno` means --untracked-files=no.
const COMMIT_SHORT_OPTIONS_WITH_OPTIONAL_VALUE = new Set(['u', 'S']);

/**
 * Return true when a commit option consumes the following token as its value.
 *
 * @param {string} value
 * @returns {boolean}
 */
function commitOptionConsumesNextValue(value) {
  if (isCommitNoVerifyShortFlag(value)) {
    return false;
  }

  if (COMMIT_OPTIONS_WITH_VALUE.has(value)) {
    return true;
  }

  const shortValueOption = getCommitShortValueOption(value);
  return Boolean(shortValueOption && shortValueOption.consumesNextValue);
}

/**
 * Return true when a commit option already carries its value in the same token.
 *
 * @param {string} value
 * @returns {boolean}
 */
function commitOptionContainsInlineValue(value) {
  if (isCommitNoVerifyShortFlag(value)) {
    return false;
  }

  if (COMMIT_OPTIONS_WITH_INLINE_VALUE.some(prefix => value.startsWith(prefix))) {
    return true;
  }

  const shortValueOption = getCommitShortValueOption(value);
  return Boolean(shortValueOption && shortValueOption.containsInlineValue);
}

/**
 * Classify a combined short-option token that includes a value-taking option.
 *
 * @param {string} value
 * @returns {{consumesNextValue: boolean, containsInlineValue: boolean}|null}
 */
function getCommitShortValueOption(value) {
  if (!value.startsWith('-') || value.startsWith('--') || value === '-') {
    return null;
  }

  const options = value.slice(1);
  for (let i = 0; i < options.length; i++) {
    if (COMMIT_SHORT_OPTIONS_WITH_VALUE.has(options.charAt(i))) {
      return {
        consumesNextValue: i === options.length - 1,
        containsInlineValue: i < options.length - 1
      };
    }
  }

  return null;
}

/**
 * Return true when a token is commit's `-n` / `--no-verify` short form.
 *
 * @param {string} value
 * @returns {boolean}
 */
function isCommitNoVerifyShortFlag(value) {
  if (!value.startsWith('-') || value.startsWith('--') || value === '-') {
    return false;
  }

  // Short options cluster, so -n need not lead: `git commit -an` is -a plus -n
  // and bypasses the hooks just as `-n` does. Anchoring on the first character
  // let -an, -sn and -vn through.
  //
  // Scanning stops at a value-taking option because that option swallows the
  // rest of the cluster as its inline value — the n in `-mn` is message text,
  // not a flag.
  const options = value.slice(1);
  for (let i = 0; i < options.length; i++) {
    const option = options.charAt(i);
    if (option === 'n') return true;
    if (COMMIT_SHORT_OPTIONS_WITH_VALUE.has(option)) return false;
    if (COMMIT_SHORT_OPTIONS_WITH_OPTIONAL_VALUE.has(option)) return false;
  }

  return false;
}

/**
 * git's option parser accepts any unambiguous prefix of a long option, so
 * `--no-veri` and `--no-verif` run as --no-verify. Shorter prefixes such as
 * `--no-ver` are ambiguous with --no-verbose and git rejects them itself, so
 * refusing every prefix from `--no-v` up blocks nothing that would have run.
 */
function isNoVerifyLongFlag(value) {
  return value.length >= '--no-v'.length && '--no-verify'.startsWith(value);
}

const PROTECTED_GIT_COMMANDS = new Set(['commit', 'push', 'merge', 'cherry-pick', 'rebase', 'am']);
const GIT_GLOBAL_VALUES = new Set(['-c', '-C', '--work-tree', '--git-dir', '--namespace', '--super-prefix']);
const SHELLS = new Set(['sh', 'bash', 'dash', 'zsh', 'ksh']);
const DATA_COMMANDS = new Set(['echo', 'printf', 'cat', 'grep', 'head', 'tail', 'wc', 'sort', 'uniq', ':', 'true', 'false']);
const CONTROL_WORDS = new Set(['!', 'if', 'then', 'elif', 'while', 'until', 'do', 'else']);

function basename(value) {
  return value.replace(/\\/g, '/').split('/').pop();
}

function checkGitWords(words, budget, start = 0) {
  let index = start + 1;
  let override = false;
  for (; index < words.length; index++) {
    const value = words[index].value;
    budget.spend(value.length + 1);
    if (!value.startsWith('-')) break;
    if (value === '--') { index++; break; }
    if (value === '-c') {
      const setting = words[index + 1]?.value || '';
      budget.spend(setting.length + 1);
      override ||= setting.toLowerCase().startsWith(GIT_CONFIG_KEY_PREFIX);
    } else if (value.toLowerCase().startsWith(`-c${GIT_CONFIG_KEY_PREFIX}`)) override = true;
    if (GIT_GLOBAL_VALUES.has(value)) index++;
  }
  const command = words[index]?.value;
  budget.spend((command?.length || 0) + 1);
  if (!PROTECTED_GIT_COMMANDS.has(command)) return null;
  if (override) return `BLOCKED: Overriding core.hooksPath is not allowed with git ${command}. Git hooks must not be bypassed.`;
  let skipNext = false;
  for (index++; index < words.length; index++) {
    const value = words[index].value;
    budget.spend(value.length + 1);
    if (skipNext) { skipNext = false; continue; }
    if (value === '--') break;
    if (command === 'commit') {
      if (commitOptionConsumesNextValue(value)) { skipNext = true; continue; }
      if (commitOptionContainsInlineValue(value)) continue;
    }
    if (isNoVerifyLongFlag(value) || (command === 'commit' && isCommitNoVerifyShortFlag(value))) {
      return `BLOCKED: --no-verify flag is not allowed with git ${command}. Git hooks must not be bypassed.`;
    }
  }
  return null;
}

// Only explicit option grammars remove wrapper operands. Unknown launchers are
// opaque/conservative, never guessed from a name found among data arguments.
function executableWords(words, budget) {
  function suffix(start) {
    budget.spend(words.length - start);
    return words.slice(start);
  }
  let i = 0;
  let assignments = true;
  let environmentAssignments = false;
  while (i < words.length) {
    const token = words[i];
    budget.spend(token.value.length + token.raw.length + 1);
    if (assignments && /^[A-Za-z_][A-Za-z0-9_]*=/.test(environmentAssignments ? token.value : token.raw)) { i++; continue; }
    if (!token.quoted && CONTROL_WORDS.has(token.value)) { i++; continue; }
    const name = basename(token.value);
    if (name === 'command') {
      i++;
      while (words[i]?.value.startsWith('-')) {
        const flag = words[i++].value;
        budget.spend(flag.length + 1);
        if (flag === '--') break;
        if (/^-[pvV]+$/.test(flag) && /[vV]/.test(flag)) return [];
        if (!/^-p+$/.test(flag)) return suffix(i - 1);
      }
      assignments = false; continue;
    }
    if (name === 'exec') {
      i++;
      while (words[i]?.value.startsWith('-')) {
        const flag = words[i++].value;
        budget.spend(flag.length + 1);
        if (flag === '--') break;
        if (flag === '-a') i++;
        else if (!/^-([cl]*a.+|[cl]+)$/.test(flag)) return suffix(i - 1);
      }
      assignments = false; continue;
    }
    if (name === 'env' || name === 'sudo' || name === 'doas') {
      const env = name === 'env';
      const values = env
        ? new Set(['-u', '--unset', '-C', '--chdir'])
        : new Set(['-u', '--user', '-g', '--group', '-h', '--host', '-p', '--prompt', '-C', '-T', '-R', '-D']);
      const flags = env ? new Set(['-i', '--ignore-environment', '-0', '--null']) : new Set(['-n', '-E', '-H', '-S', '-k', '-K', '-b']);
      i++;
      while (words[i]?.value.startsWith('-')) {
        const flag = words[i].value;
        budget.spend(flag.length + 1);
        if (flag === '--') { i++; break; }
        if (values.has(flag)) i += 2;
        else if (flags.has(flag) || [...values].some(value => value.startsWith('--') ? flag.startsWith(`${value}=`) : flag.startsWith(value) && flag.length > value.length)) i++;
        else return suffix(i - 1); // Includes opaque env -S / sudo shell modes.
      }
      assignments = true; environmentAssignments = true; continue;
    }
    return suffix(i);
  }
  return [];
}

function shellRole(words, budget, shell) {
  let i = 1;
  let stdin = false;
  let code = false;
  while (i < words.length) {
    const option = words[i].value;
    budget.spend(option.length + 1);
    if (option === '--' || option === '-') { i++; break; }
    if (!/^[+-]/.test(option)) break;
    if (option === '--rcfile' || option === '--init-file') { i += 2; continue; }
    if (option.startsWith('--')) {
      if (!['--noprofile', '--norc', '--posix', '--restricted', '--verbose', '--login'].includes(option)) return { kind: 'opaque', stdin: true };
      i++; continue;
    }
    // Bash accepts either sign and consumes a separate operand for each o/O
    // even inside a cluster. The command string follows ALL option processing,
    // not necessarily the argv word immediately after the first c flag.
    let next = i + 1;
    for (let j = 1; j < option.length; j++) {
      budget.spend();
      const flag = option[j];
      // Named-option arity is unproved for sh/dash/ksh: keep the invocation
      // opaque instead of consuming a code flag as a guessed option operand.
      if ((flag === 'o' || flag === 'O') && shell !== 'bash' && shell !== 'zsh') return { kind: 'opaque', stdin: true };
      if (flag === 'c') code = true;
      else if (flag === 's') stdin = true;
      else if (shell === 'zsh' && flag === 'o') {
        // zsh consumes the rest of this argv word as the option name, or one
        // separate word if no suffix exists, then ends this option cluster.
        if (j + 1 === option.length && next < words.length) next++;
        break;
      } else if (shell === 'zsh' && (flag === 'O' || flag === 'b')) {
        // These are not Bash's operand grammar; unmodeled zsh modes stay opaque.
        return { kind: 'opaque', stdin: true };
      } else if (flag === 'o' || flag === 'O') { if (next < words.length) next++; }
      else if (!'abefhiklmnprtuvxBCEHPTD'.includes(flag)) return { kind: 'opaque', stdin: true };
    }
    i = next;
  }
  if (code) return { kind: 'shell', code: words[i]?.value, stdin: false };
  // A script filename and its positional arguments are not shell source text.
  return { kind: 'shell', stdin: stdin || i === words.length };
}

function commandRole(words, budget) {
  if (!words.length) return { kind: 'data' };
  budget.spend(words[0].value.length + 1);
  const name = basename(words[0].value);
  if (name === 'git' || name === 'git.exe') return { kind: 'git' };
  if (SHELLS.has(name)) return shellRole(words, budget, name);
  if (name === 'eval') {
    for (const word of words) budget.spend(word.value.length + 3);
    return { kind: 'shell', code: words.slice(words[1]?.value === '--' ? 2 : 1).map(word => word.value).join(' '), stdin: false };
  }
  if (DATA_COMMANDS.has(name)) return { kind: 'data' };
  return { kind: 'opaque', stdin: true };
}

// Literal producers only. Unmodeled transformations remain conservative rather
// than executing a formatter, interpreter, shell or user-supplied command.
function pipelineSources(command, budget) {
  const sources = [];
  for (let current = command; current; current = current.pipeFrom) {
    budget.spend(current.words.length + 1);
    const words = executableWords(current.words, budget);
    for (const word of words) budget.spend(word.value.length + 3);
    const name = basename(words[0]?.value || '');
    if (name === 'echo') sources.push(words.slice(1).filter(word => !/^-[neE]+$/.test(word.value)).map(word => word.value).join(' '));
    if (name === 'printf') {
      const format = words[1]?.value || '';
      if (format !== '-v') sources.push((format === '%s' || format === '%s\\n') ? words.slice(2).map(word => word.value).join('\n') : words.slice(1).map(word => word.value).join(' '));
    }
    for (const redirect of current.redirects) {
      if (redirect.operator === '<<<') sources.push(redirect.word.value);
      else if (redirect.operator === '<<' || redirect.operator === '<<-') sources.push(redirect.body);
    }
  }
  return sources;
}

function checkCommand(input) {
  const budget = createBudget(input.length);
  const pending = [{ text: input, opaque: false }];
  function enqueue(text, opaque = false) {
    if (!text) return;
    budget.spend(text.length + 1);
    pending.push({ text, opaque });
  }
  function inspectOpaque(words, text) {
    for (let index = 0; index < words.length; index++) {
      const word = words[index];
      budget.spend(word.value.length + 1);
      if (['git', 'git.exe'].includes(basename(word.value))) {
        const reason = checkGitWords(words, budget, index);
        if (reason) return reason;
      }
      if (word.value !== text && /git/.test(word.value) && /[\s'"()]/.test(word.value)) enqueue(word.value, true);
    }
    return null;
  }
  try {
    while (pending.length) {
      const task = pending.pop();
      const scan = scanShell(task.text, budget);
      for (const text of scan.nested) enqueue(text);
      for (const command of scan.commands) {
        const words = executableWords(command.words, budget);
        const role = commandRole(words, budget);
        const reason = task.opaque || role.kind === 'opaque'
          ? inspectOpaque(command.words, task.text)
          : role.kind === 'git' ? checkGitWords(words, budget) : null;
        if (reason) return { blocked: true, reason };
        if (role.code) enqueue(role.code);
        if (role.stdin) {
          for (const redirect of command.redirects) {
            if (redirect.operator === '<<<') enqueue(redirect.word.value, role.kind === 'opaque');
            else if (redirect.operator === '<<' || redirect.operator === '<<-') enqueue(redirect.body, role.kind === 'opaque');
          }
          if (command.pipeFrom) {
            for (const source of pipelineSources(command.pipeFrom, budget)) enqueue(source, role.kind === 'opaque');
          }
        }
      }
    }
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    return { blocked: true, reason: 'BLOCKED: Shell analysis work budget exceeded; hook-bypass safety could not be established.' };
  }
  return { blocked: false };
}

/**
 * Extract the command string from hook input (JSON or plain text).
 *
 * @param {string} rawInput
 * @returns {string}
 */
function extractCommand(rawInput) {
  const trimmed = rawInput.trim();
  if (!trimmed.startsWith('{')) {
    return trimmed;
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed !== 'object' || parsed === null) {
      return trimmed;
    }

    // Claude Code format: { tool_input: { command: "..." } }
    const cmd = parsed.tool_input?.command;
    if (typeof cmd === 'string') {
      return cmd;
    }

    // Generic JSON formats
    for (const key of ['command', 'cmd', 'input', 'shell', 'script']) {
      if (typeof parsed[key] === 'string') {
        return parsed[key];
      }
    }

    return trimmed;
  } catch {
    return trimmed;
  }
}

/**
 * Exportable run() for in-process execution via run-with-flags.js.
 *
 * @param {string} rawInput
 * @returns {{exitCode: number, stderr?: string}}
 */
function run(rawInput) {
  const command = extractCommand(rawInput);
  const result = checkCommand(command);

  if (result.blocked) {
    return {
      exitCode: 2,
      stderr: result.reason
    };
  }

  return { exitCode: 0 };
}

module.exports = { run };

// Stdin fallback for spawnSync execution — only when invoked directly, not via require()
if (require.main === module) {
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    if (raw.length < MAX_STDIN) {
      const remaining = MAX_STDIN - raw.length;
      raw += chunk.substring(0, remaining);
    }
  });

  process.stdin.on('end', () => {
    const command = extractCommand(raw);
    const result = checkCommand(command);

    if (result.blocked) {
      process.stderr.write(result.reason + '\n');
      process.exit(2);
    }

    process.stdout.write(raw);
  });
}
