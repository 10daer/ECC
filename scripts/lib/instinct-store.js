'use strict';

/**
 * Shared instinct file parser and PreToolUse matcher.
 *
 * SessionStart and instinct-enforce both read the same project + global
 * store. Parse behavior is the SessionStart original: quoted values, a
 * float `confidence`, and missing/unparseable confidence -> 0.5.
 */

const fs = require('fs');
const path = require('path');
const { getHomunculusDir } = require('./observer-sessions');

const DEFAULT_INSTINCT_CONFIDENCE_THRESHOLD = 0.7;
const DEFAULT_MATCH_LIMIT = 3;
const QUOTED_IDENTIFIER_MIN_LENGTH = 4;
const MATCH_STOPWORDS = new Set(['when', 'always', 'never', 'the', 'and']);
const QUOTED_IDENTIFIER_RE = /(["'`])([^"'`]+)\1/g;
const NEVER_TOKEN_RE = /\b(?:never|do not|don't|dont)\s+([A-Za-z0-9_-]+)/gi;

/**
 * Resolve the minimum confidence an instinct needs to be injected at
 * SessionStart or matched at PreToolUse. Overridable via
 * `ECC_INSTINCT_CONFIDENCE_THRESHOLD` (a number in [0, 1]); falsy or
 * out-of-range values fall back to
 * {@link DEFAULT_INSTINCT_CONFIDENCE_THRESHOLD}.
 *
 * @returns {number} The confidence floor.
 */
function getInstinctConfidenceThreshold() {
  const raw = process.env.ECC_INSTINCT_CONFIDENCE_THRESHOLD;
  if (!raw) return DEFAULT_INSTINCT_CONFIDENCE_THRESHOLD;

  // Require a plain decimal (e.g. "0.7", "1", "0.95") so trailing junk
  // ("0.7x") and non-decimal numeric syntax like "0x1" (hex) or "1e2"
  // (exponent) are rejected whole rather than silently accepted by Number().
  const normalized = raw.trim();
  if (!/^\d+(\.\d+)?$/.test(normalized)) return DEFAULT_INSTINCT_CONFIDENCE_THRESHOLD;

  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1
    ? parsed
    : DEFAULT_INSTINCT_CONFIDENCE_THRESHOLD;
}

function finishInstinct(current, contentLines) {
  if (!current || !current.id) return null;
  const instinct = {
    ...current,
    content: contentLines.join('\n').trim(),
  };
  if (!Number.isFinite(instinct.confidence)) {
    instinct.confidence = 0.5;
  }
  return instinct;
}

function parseInstinctFile(content) {
  const instincts = [];
  let current = null;
  let inFrontmatter = false;
  let contentLines = [];

  for (const line of String(content).split('\n')) {
    if (line.trim() === '---') {
      if (inFrontmatter) {
        inFrontmatter = false;
      } else {
        const finished = finishInstinct(current, contentLines);
        if (finished) instincts.push(finished);
        current = {};
        contentLines = [];
        inFrontmatter = true;
      }
      continue;
    }

    if (inFrontmatter) {
      const separatorIndex = line.indexOf(':');
      if (separatorIndex === -1) continue;
      const key = line.slice(0, separatorIndex).trim();
      let value = line.slice(separatorIndex + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (key === 'confidence') {
        const parsed = Number.parseFloat(value);
        current[key] = Number.isFinite(parsed) ? parsed : 0.5;
      } else {
        current[key] = value;
      }
    } else if (current) {
      contentLines.push(line);
    }
  }

  const finished = finishInstinct(current, contentLines);
  if (finished) instincts.push(finished);

  return instincts;
}

function readInstinctsFromDir(directory, scope, onWarn) {
  if (!directory || !fs.existsSync(directory)) return [];

  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true })
      .filter(entry => entry.isFile() && /\.(ya?ml|md)$/i.test(entry.name))
      .sort((left, right) => left.name.localeCompare(right.name));
  } catch (error) {
    if (typeof onWarn === 'function') {
      onWarn(directory, error);
    }
    return [];
  }

  const instincts = [];
  for (const entry of entries) {
    const filePath = path.join(directory, entry.name);
    try {
      const parsed = parseInstinctFile(fs.readFileSync(filePath, 'utf8'));
      for (const instinct of parsed) {
        instincts.push({
          ...instinct,
          _scopeLabel: scope,
          _sourceFile: filePath,
        });
      }
    } catch (error) {
      if (typeof onWarn === 'function') {
        onWarn(filePath, error);
      }
    }
  }

  return instincts;
}

function mergeProjectOverGlobal(project, global) {
  const merged = new Map();
  for (const instinct of global) {
    if (instinct && instinct.id) merged.set(instinct.id, instinct);
  }
  for (const instinct of project) {
    if (instinct && instinct.id) merged.set(instinct.id, instinct);
  }
  return Array.from(merged.values());
}

/**
 * Load project + global instincts from the same roots SessionStart uses.
 *
 * @param {object} observerContext
 * @param {object} [options]
 * @param {function} [options.onWarn]
 * @returns {{ project: object[], global: object[], merged: object[] }}
 */
function loadInstincts(observerContext, options = {}) {
  const onWarn = options.onWarn;
  const homunculusDir = getHomunculusDir();
  const globalDirs = [
    { dir: path.join(homunculusDir, 'instincts', 'personal'), scope: 'global' },
    { dir: path.join(homunculusDir, 'instincts', 'inherited'), scope: 'global' },
  ];
  const projectDirs = observerContext && observerContext.isGlobal === false && observerContext.projectDir
    ? [
      { dir: path.join(observerContext.projectDir, 'instincts', 'personal'), scope: 'project' },
      { dir: path.join(observerContext.projectDir, 'instincts', 'inherited'), scope: 'project' },
    ]
    : [];

  const project = projectDirs.flatMap(({ dir, scope }) => readInstinctsFromDir(dir, scope, onWarn));
  const global = globalDirs.flatMap(({ dir, scope }) => readInstinctsFromDir(dir, scope, onWarn));

  return {
    project,
    global,
    merged: mergeProjectOverGlobal(project, global),
  };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function collectToolStrings(toolInput) {
  const values = [];
  const push = (value) => {
    if (typeof value === 'string' && value) values.push(value);
  };

  const input = toolInput && typeof toolInput === 'object' ? toolInput : {};
  push(input.file_path);
  push(input.filePath);
  push(input.command);
  push(input.contents);
  push(input.content);
  push(input.new_string);
  push(input.newString);
  push(input.old_string);
  push(input.oldString);

  if (Array.isArray(input.edits)) {
    for (const edit of input.edits) {
      if (!edit || typeof edit !== 'object') continue;
      push(edit.file_path);
      push(edit.filePath);
      push(edit.contents);
      push(edit.content);
      push(edit.new_string);
      push(edit.newString);
    }
  }

  return values;
}

function extractQuotedIdentifiers(text) {
  const identifiers = [];
  const source = String(text || '');
  QUOTED_IDENTIFIER_RE.lastIndex = 0;
  let match;
  while ((match = QUOTED_IDENTIFIER_RE.exec(source)) !== null) {
    const identifier = match[2].trim();
    if (identifier.length < QUOTED_IDENTIFIER_MIN_LENGTH) continue;
    if (MATCH_STOPWORDS.has(identifier.toLowerCase())) continue;
    identifiers.push(identifier);
  }
  return identifiers;
}

function extractNeverTokens(text) {
  const tokens = [];
  const source = String(text || '');
  NEVER_TOKEN_RE.lastIndex = 0;
  let match;
  while ((match = NEVER_TOKEN_RE.exec(source)) !== null) {
    const token = match[1];
    if (token) tokens.push(token);
  }
  return tokens;
}

function instinctMatchesToolInput(instinct, toolInput) {
  const strings = collectToolStrings(toolInput);
  const filePath = strings.length > 0
    ? String((toolInput && (toolInput.file_path || toolInput.filePath)) || '')
    : '';
  const command = String((toolInput && toolInput.command) || '');
  const basename = filePath ? path.basename(filePath) : '';
  const payload = strings.join('\n');
  const pathOrCommand = `${filePath}\n${command}`;
  const quotedHaystack = [payload, command, basename].join('\n');

  const domain = String(instinct.domain || '').trim();
  if (domain) {
    const domainPattern = new RegExp(`\\b${escapeRegExp(domain)}\\b`, 'i');
    if (domainPattern.test(pathOrCommand)) {
      return true;
    }
  }

  const quotedSource = `${instinct.trigger || ''}\n${instinct.content || ''}`;
  for (const identifier of extractQuotedIdentifiers(quotedSource)) {
    if (quotedHaystack.toLowerCase().includes(identifier.toLowerCase())) {
      return true;
    }
  }

  const neverHaystack = payload.toLowerCase();
  for (const token of extractNeverTokens(instinct.content)) {
    if (neverHaystack.includes(token.toLowerCase())) {
      return true;
    }
  }

  return false;
}

/**
 * Deterministic instinct matcher for a tool payload.
 *
 * @param {object[]} instincts
 * @param {object} toolInput
 * @param {object} [options]
 * @param {number} [options.minConfidence]
 * @param {number} [options.limit]
 * @returns {object[]} matching instincts, highest confidence first, capped
 */
function matchInstincts(instincts, toolInput, options = {}) {
  const minConfidence = Number.isFinite(options.minConfidence)
    ? options.minConfidence
    : getInstinctConfidenceThreshold();
  const limit = Number.isInteger(options.limit) && options.limit > 0
    ? options.limit
    : DEFAULT_MATCH_LIMIT;

  const matches = (Array.isArray(instincts) ? instincts : [])
    .filter(instinct => instinct && instinct.id && Number(instinct.confidence) >= minConfidence)
    .filter(instinct => instinctMatchesToolInput(instinct, toolInput))
    .sort((left, right) => {
      if (right.confidence !== left.confidence) return right.confidence - left.confidence;
      return String(left.id).localeCompare(String(right.id));
    });

  return matches.slice(0, limit);
}

module.exports = {
  DEFAULT_INSTINCT_CONFIDENCE_THRESHOLD,
  DEFAULT_MATCH_LIMIT,
  MATCH_STOPWORDS,
  getInstinctConfidenceThreshold,
  parseInstinctFile,
  loadInstincts,
  matchInstincts,
  mergeProjectOverGlobal,
};
