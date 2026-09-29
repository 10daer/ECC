#!/usr/bin/env node
/**
 * PreToolUse Hook: enforce high-confidence learned instincts.
 *
 * SessionStart injects instincts as advisory text. This hook re-checks
 * Write/Edit/MultiEdit/Bash payloads against the same store and either
 * warns (0.70-0.84) or blocks (>= 0.85) when a deterministic match hits.
 *
 * Compatible with run-with-flags.js via module.exports.run().
 * Fail-open on unreadable stdin, a missing store, or hook errors. Unexpected
 * failures are reported on stderr without the tool payload.
 * Never echoes stdin.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { resolveProjectContext } = require('../lib/observer-sessions');
const {
  loadInstincts,
  matchInstincts,
  getInstinctConfidenceThreshold,
} = require('../lib/instinct-store');

const ENFORCE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'Bash']);
const ECC_DISABLE_VALUES = new Set(['0', 'false', 'off', 'disabled', 'disable']);
const BLOCK_CONFIDENCE = 0.85;
const NO_OPINION = Object.freeze({ exitCode: 0, stdout: '' });

function normalizeEnvValue(value) {
  return String(value || '').trim().toLowerCase();
}

function isInstinctEnforceDisabled() {
  return ECC_DISABLE_VALUES.has(normalizeEnvValue(process.env.ECC_INSTINCT_ENFORCE));
}

function getEnforceMode() {
  const raw = normalizeEnvValue(process.env.ECC_INSTINCT_ENFORCE_MODE);
  if (raw === 'warn' || raw === 'block') return raw;
  return 'default';
}

function parseStdin(stdinText) {
  if (stdinText && typeof stdinText === 'object') {
    return stdinText;
  }
  const raw = String(stdinText || '').trim();
  if (!raw) return null;
  return JSON.parse(raw);
}

function normalizeToolName(rawToolName) {
  const mapped = {
    write: 'Write',
    edit: 'Edit',
    multiedit: 'MultiEdit',
    bash: 'Bash',
  };
  const key = String(rawToolName || '').toLowerCase();
  return mapped[key] || rawToolName;
}

function formatMatchLines(instinct) {
  return {
    id: instinct.id,
    confidence: String(instinct.confidence),
    trigger: String(instinct.trigger || '').trim() || '(none)',
  };
}

function buildBlockMessage(instinct, toolName) {
  const { id, confidence, trigger } = formatMatchLines(instinct);
  const normalizedTool = normalizeToolName(toolName);
  const recovery = normalizedTool === 'Bash'
    ? 'change the command to avoid the matched instinct'
    : 'rename to avoid the forbidden prefix';
  return [
    `[instinct-enforce] blocked by instinct \`${id}\` (confidence ${confidence})`,
    `trigger: ${trigger}`,
    `recovery: ${recovery}, or ECC_INSTINCT_ENFORCE=0 for this session`,
  ].join('\n');
}

function buildWarnMessage(instinct) {
  const { id, confidence, trigger } = formatMatchLines(instinct);
  return [
    `[instinct-enforce] instinct \`${id}\` (confidence ${confidence}) matches this tool call`,
    `trigger: ${trigger}`,
  ].join('\n');
}

function evaluateMatches(matches) {
  if (!Array.isArray(matches) || matches.length === 0) {
    return { verdict: 'none', best: null };
  }
  const best = matches[0];
  const mode = getEnforceMode();
  if (mode === 'warn') {
    return { verdict: 'warn', best };
  }
  if (mode === 'block' || Number(best.confidence) >= BLOCK_CONFIDENCE) {
    return { verdict: 'block', best };
  }
  return { verdict: 'warn', best };
}

function describeError(error) {
  return error && error.message ? error.message : String(error);
}

// Fail open, but say why. Warnings name the failing stage and file path only;
// the tool payload is never included, so a match-stage failure reports just
// the error type rather than a message that could quote tool input.
function loadMatchesForTool(toolInput) {
  const warnings = [];

  let observerContext;
  try {
    observerContext = resolveProjectContext();
  } catch (error) {
    warnings.push(`[instinct-enforce] could not resolve project context, skipping: ${describeError(error)}`);
    return { matches: [], warnings };
  }

  let loaded;
  try {
    loaded = loadInstincts(observerContext, {
      onWarn(filePath, error) {
        warnings.push(`[instinct-enforce] skipped unreadable instinct file ${filePath}: ${describeError(error)}`);
      },
    });
  } catch (error) {
    warnings.push(`[instinct-enforce] could not load instincts, skipping: ${describeError(error)}`);
    return { matches: [], warnings };
  }

  try {
    const matches = matchInstincts(loaded.merged, toolInput, {
      minConfidence: getInstinctConfidenceThreshold(),
      limit: 3,
    });
    return { matches, warnings };
  } catch (error) {
    const kind = error && error.name ? error.name : 'Error';
    warnings.push(`[instinct-enforce] instinct matching failed (${kind}), skipping`);
    return { matches: [], warnings };
  }
}

function joinStderr(warnings, message) {
  const lines = [...warnings];
  if (message) lines.push(message);
  return lines.join('\n');
}

async function run(stdinText) {
  if (isInstinctEnforceDisabled()) {
    return NO_OPINION;
  }

  let data;
  try {
    data = parseStdin(stdinText);
  } catch {
    return NO_OPINION;
  }

  if (!data || typeof data !== 'object') {
    return NO_OPINION;
  }

  const toolName = normalizeToolName(data.tool_name || data.toolName);
  if (!ENFORCE_TOOLS.has(toolName)) {
    return NO_OPINION;
  }

  const toolInput = data.tool_input || data.toolInput || {};
  const { matches, warnings } = loadMatchesForTool(toolInput);
  const { verdict, best } = evaluateMatches(matches);

  if (verdict === 'none' || !best) {
    return warnings.length > 0
      ? { ...NO_OPINION, stderr: joinStderr(warnings) }
      : NO_OPINION;
  }

  if (verdict === 'block') {
    const message = buildBlockMessage(best, toolName);
    return {
      exitCode: 2,
      stdout: message,
      stderr: joinStderr(warnings, message),
    };
  }

  const result = {
    exitCode: 0,
    additionalContext: buildWarnMessage(best),
  };
  if (warnings.length > 0) {
    result.stderr = joinStderr(warnings);
  }
  return result;
}

function formatCheckOutput(matches, verdict) {
  const lines = [`verdict: ${verdict}`];
  if (matches.length === 0) {
    lines.push('matches: none');
    return `${lines.join('\n')}\n`;
  }
  lines.push('matches:');
  for (const instinct of matches) {
    const { id, confidence, trigger } = formatMatchLines(instinct);
    lines.push(`- ${id} confidence=${confidence} trigger: ${trigger}`);
  }
  return `${lines.join('\n')}\n`;
}

async function runCheck(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    process.stderr.write(`[instinct-enforce] --check could not read ${filePath}: ${error.message}\n`);
    process.exitCode = 1;
    return;
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    process.stderr.write(`[instinct-enforce] --check invalid JSON: ${error.message}\n`);
    process.exitCode = 1;
    return;
  }

  // A gate miss must not read like a clean pass: an unsupported tool is a
  // real "none" (exit 0), but a payload with no usable tool_name or
  // tool_input is malformed and fails the dry run (exit 1).
  const record = data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  const rawToolName = record ? (record.tool_name ?? record.toolName) : undefined;
  if (typeof rawToolName !== 'string' || !rawToolName.trim()) {
    process.stdout.write('verdict: none\nreason: payload has no tool_name\n');
    process.exitCode = 1;
    return;
  }

  const toolName = normalizeToolName(rawToolName.trim());
  if (!ENFORCE_TOOLS.has(toolName)) {
    process.stdout.write(`verdict: none\nreason: ${toolName} not enforced\n`);
    return;
  }

  const toolInput = record.tool_input ?? record.toolInput;
  if (!toolInput || typeof toolInput !== 'object' || Array.isArray(toolInput)) {
    process.stdout.write('verdict: none\nreason: payload has no tool_input object\n');
    process.exitCode = 1;
    return;
  }

  const { matches, warnings } = loadMatchesForTool(toolInput);
  if (warnings.length > 0) {
    process.stderr.write(`${joinStderr(warnings)}\n`);
  }
  const { verdict } = evaluateMatches(matches);
  process.stdout.write(formatCheckOutput(matches, verdict));
}

async function main() {
  const args = process.argv.slice(2);
  const checkIndex = args.indexOf('--check');
  if (checkIndex !== -1) {
    const filePath = args[checkIndex + 1];
    if (!filePath) {
      process.stderr.write('Usage: node instinct-enforce.js --check <payload.json>\n');
      process.exitCode = 1;
      return;
    }
    await runCheck(path.resolve(filePath));
    return;
  }

  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  const result = await run(chunks.join(''));
  if (result.stderr) {
    process.stderr.write(result.stderr.endsWith('\n') ? result.stderr : `${result.stderr}\n`);
  }
  if (result.additionalContext) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: result.additionalContext,
      },
    }));
  } else if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  process.exitCode = Number.isInteger(result.exitCode) ? result.exitCode : 0;
}

module.exports = { run };

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`[instinct-enforce] ${error.message}\n`);
    process.exitCode = 0;
  });
}
