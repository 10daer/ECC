/**
 * GateGuard current-turn transcript scan: one bounded tail read of a Claude
 * Code JSONL transcript, walked back to the latest human message or
 * compaction. Yields the turn id and the turn's completed, non-error search
 * calls. Shell parsing stays in the hook, which shares it with the
 * destructive-command gate.
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const { readFileTail, DEFAULT_TRANSCRIPT_TAIL_BYTES } = require('./transcript-context');

const TRANSCRIPT_SCAN_MAX_LINES = 2000;
const SEARCH_TOOL_NAMES = new Set(['Glob', 'Grep', 'LS', 'Bash', 'PowerShell']);
const SHELL_TOOL_NAMES = new Set(['Bash', 'PowerShell']);
const TOOL_USE_ERROR_PREFIX = '<tool_use_error>';

function isObject(value) {
  return Boolean(value) && typeof value === 'object';
}

/** Exports never throw: an error here must not escape into the hook's credit or sibling logic. */
function neverThrows(fn, fallback) {
  return (...args) => {
    try {
      return fn(...args);
    } catch (_) {
      return fallback;
    }
  };
}

/** Transcript path from the hook payload or CLAUDE_TRANSCRIPT_PATH; '' when none. */
function transcriptPathFor(data) {
  const candidate = (isObject(data) && (data.transcript_path || data.transcriptPath)) || process.env.CLAUDE_TRANSCRIPT_PATH;
  return typeof candidate === 'string' ? candidate : '';
}

function pendingToolUseId(data) {
  return isObject(data) && typeof data.tool_use_id === 'string' ? data.tool_use_id : '';
}

function recordContent(record) {
  const message = isObject(record) ? record.message : undefined;
  return isObject(message) ? message.content : undefined;
}

function isSkippedTranscriptRecord(record) {
  return (
    !isObject(record) ||
    Array.isArray(record) ||
    record.isSidechain === true ||
    record.isMeta === true ||
    (record.type !== 'user' && record.type !== 'assistant')
  );
}

/** Compaction discards the earlier turn: its summary (or boundary marker) starts a new one. */
function isCompactionBoundary(record) {
  return (
    Boolean(record) &&
    typeof record === 'object' &&
    record.isSidechain !== true &&
    (record.isCompactSummary === true || (record.type === 'system' && record.subtype === 'compact_boundary'))
  );
}

const MAX_PROMPT_ID_CHARS = 128;

// Claude Code stamps every user record of a turn with the same `promptId`, so it
// identifies the turn even when the boundary has scrolled out of the tail window.
function recordPromptId(record) {
  const id = isObject(record) ? record.promptId : undefined;
  return typeof id === 'string' && id && id.length <= MAX_PROMPT_ID_CHARS ? id : null;
}

function boundaryTurnId(record, line) {
  if (typeof record.uuid === 'string' && record.uuid) return record.uuid;
  return `h:${crypto.createHash('sha256').update(line).digest('hex').slice(0, 16)}`;
}

/**
 * Only a non-empty array of `tool_result` blocks is a tool-result record; any
 * other user record is a turn boundary, which can only shrink the credit window.
 */
function isToolResultRecord(record) {
  const content = recordContent(record);
  return (
    Array.isArray(content) &&
    content.length > 0 &&
    content.every(block => block && typeof block === 'object' && block.type === 'tool_result')
  );
}

function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const first = content.find(block => block && typeof block === 'object' && block.type === 'text');
  return first && typeof first.text === 'string' ? first.text : '';
}

function isErrorToolResult(block) {
  if (!isObject(block)) return false;
  if (block.is_error === true || block.is_error === 'true') return true;
  return toolResultText(block.content).trimStart().startsWith(TOOL_USE_ERROR_PREFIX);
}

/**
 * Scan the transcript tail back to the latest human turn. Returns null when the
 * transcript is unavailable, else the turn id, the turn's searches (newest
 * first), batch ids, and shell commands. The tail is bounded to keep the hook fast.
 */
function scanCurrentTurn(transcriptPath, pendingId = '') {
  if (typeof transcriptPath !== 'string' || !transcriptPath) return null;
  let stat;
  try {
    stat = fs.statSync(transcriptPath);
  } catch (_) {
    return null;
  }
  if (!stat.isFile()) return null;
  const tail = readFileTail(transcriptPath, DEFAULT_TRANSCRIPT_TAIL_BYTES);
  if (!tail) return null;

  const lines = tail.text.split('\n');
  const firstLine = Math.max(tail.truncated ? 1 : 0, lines.length - TRANSCRIPT_SCAN_MAX_LINES);
  const okResultIds = new Set();
  const toolUses = [];
  const batchIds = new Map();
  let newestMessageId = null;
  const windowPromptIds = new Set();
  const finish = turnId => ({
    turnId,
    searches: collectTurnSearches(toolUses, okResultIds, pendingId),
    batchIds,
    newestMessageId,
    shellCommands: collectShellCommands(toolUses)
  });

  for (let i = lines.length - 1; i >= firstLine; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch (_) {
      continue;
    }
    if (isCompactionBoundary(record)) return finish(recordPromptId(record) || boundaryTurnId(record, line));
    if (isObject(record) && record.type === 'user' && record.isSidechain !== true) {
      const id = recordPromptId(record);
      if (id) windowPromptIds.add(id);
    }
    if (isSkippedTranscriptRecord(record)) continue;

    if (record.type === 'user') {
      if (!isToolResultRecord(record)) return finish(recordPromptId(record) || boundaryTurnId(record, line));
      for (const block of recordContent(record)) {
        if (typeof block.tool_use_id === 'string' && !isErrorToolResult(block)) {
          okResultIds.add(block.tool_use_id);
        }
      }
      continue;
    }

    if (!isObject(record.message)) continue;
    const content = recordContent(record);
    const messageId = typeof record.message.id === 'string' && record.message.id ? record.message.id : null;
    if (newestMessageId === null && messageId) newestMessageId = messageId;
    if (!Array.isArray(content)) continue;
    for (let j = content.length - 1; j >= 0; j--) {
      const block = content[j];
      if (!block || typeof block !== 'object' || block.type !== 'tool_use') continue;
      toolUses.push({ block, messageId });
      if (messageId && typeof block.id === 'string') batchIds.set(block.id, messageId);
    }
  }
  // No boundary: a clipped window is the current turn only if its promptIds agree;
  // two or more mean an unrecognised turn start. An unclipped file has no turn.
  if ((tail.truncated || firstLine > 0) && windowPromptIds.size <= 1) {
    return finish(windowPromptIds.size === 1 ? [...windowPromptIds][0] : null);
  }
  return { turnId: null, searches: [], batchIds: new Map(), newestMessageId: null, shellCommands: [] };
}

/** Completed, non-error search calls whose id occurs once, newest first. */
function collectTurnSearches(toolUsesNewestFirst, okResultIds, pendingId) {
  const idCounts = new Map();
  for (const { block } of toolUsesNewestFirst) {
    if (typeof block.id === 'string') idCounts.set(block.id, (idCounts.get(block.id) || 0) + 1);
  }
  const searches = [];
  const priorCalls = toolUsesNewestFirst.filter(({ block }) => !pendingId || block.id !== pendingId);
  priorCalls.forEach(({ block, messageId }, index) => {
    if (typeof block.id !== 'string' || !okResultIds.has(block.id)) return;
    if (idCounts.get(block.id) !== 1) return; // a reused id cannot be tied to one result
    if (!SEARCH_TOOL_NAMES.has(block.name)) return;
    if (!block.input || typeof block.input !== 'object') return;
    searches.push({ name: block.name, input: block.input, callsAgo: index + 1, messageId });
  });
  return searches;
}

function collectShellCommands(toolUses) {
  return toolUses
    .filter(({ block }) => SHELL_TOOL_NAMES.has(block.name) && block.input && typeof block.input === 'object')
    .map(({ block }) => (typeof block.input.command === 'string' ? block.input.command : ''));
}

/** Assistant message whose searches share the pending call's batch (their results were not yet seen). */
function excludedBatchId(scan, data) {
  if (!isObject(scan)) return null;
  const pendingId = pendingToolUseId(data);
  const located = pendingId && scan.batchIds instanceof Map ? scan.batchIds.get(pendingId) : undefined;
  if (located) return located;
  return typeof scan.newestMessageId === 'string' ? scan.newestMessageId : null;
}

/** Lazily scans once per hook invocation, shared by every MultiEdit entry. */
function createTurnScanner(data) {
  let scanned = false;
  let scan = null;
  return () => {
    if (!scanned) {
      scanned = true;
      try {
        scan = scanCurrentTurn(transcriptPathFor(data), pendingToolUseId(data));
      } catch (_) {
        scan = null;
      }
    }
    return scan;
  };
}

function currentTurnId(scan) {
  return scan && typeof scan.turnId === 'string' && scan.turnId ? scan.turnId : null;
}

module.exports = {
  TRANSCRIPT_SCAN_MAX_LINES,
  SEARCH_TOOL_NAMES,
  SHELL_TOOL_NAMES,
  transcriptPathFor: neverThrows(transcriptPathFor, ''),
  pendingToolUseId: neverThrows(pendingToolUseId, ''),
  isCompactionBoundary: neverThrows(isCompactionBoundary, false),
  isToolResultRecord: neverThrows(isToolResultRecord, false),
  isErrorToolResult: neverThrows(isErrorToolResult, false),
  scanCurrentTurn: neverThrows(scanCurrentTurn, null),
  excludedBatchId: neverThrows(excludedBatchId, null),
  createTurnScanner: neverThrows(createTurnScanner, () => null),
  currentTurnId: neverThrows(currentTurnId, null)
};
