/**
 * Session Aliases Library for Claude Code
 * Manages session aliases stored in $ECC_AGENT_DATA_HOME/session-aliases.json (default ~/.claude).
 */

const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('./atomic-write');
const { acquireSettingsLock } = require('./install/claude-settings-lock');

const {
  getClaudeDir,
  readFile,
  log
} = require('./utils');

// Aliases file path
function getAliasesPath() {
  return path.join(getClaudeDir(), 'session-aliases.json');
}

// Current alias storage format version
const ALIAS_VERSION = '1.0';

/**
 * Default aliases file structure
 */
function getDefaultAliases() {
  return {
    version: ALIAS_VERSION,
    aliases: {},
    metadata: {
      totalCount: 0,
      lastUpdated: new Date().toISOString()
    }
  };
}

/**
 * Load aliases from file
 * @returns {object} Aliases object
 */
function loadAliases() {
  const aliasesPath = getAliasesPath();

  if (!fs.existsSync(aliasesPath)) {
    return getDefaultAliases();
  }

  const content = readFile(aliasesPath);
  if (!content) {
    return getDefaultAliases();
  }

  try {
    const data = JSON.parse(content);

    // Validate structure
    if (!data.aliases || typeof data.aliases !== 'object') {
      log('[Aliases] Invalid aliases file structure, resetting');
      return getDefaultAliases();
    }

    // Ensure version field
    if (!data.version) {
      data.version = ALIAS_VERSION;
    }

    // Ensure metadata
    if (!data.metadata) {
      data.metadata = {
        totalCount: Object.keys(data.aliases).length,
        lastUpdated: new Date().toISOString()
      };
    }

    return data;
  } catch (err) {
    log(`[Aliases] Error parsing aliases file: ${err.message}`);
    return getDefaultAliases();
  }
}

// Reject callback reentry instead of allowing a nested write to be overwritten
// by the outer transaction's snapshot.
const activeWrites = new Set();

function withAliasesLock(callback, failure) {
  const aliasesPath = path.resolve(getAliasesPath());
  if (activeWrites.has(aliasesPath)) {
    log('[Aliases] Cannot write aliases from inside an alias transaction');
    return failure;
  }

  let release;
  try {
    release = acquireSettingsLock(aliasesPath, { label: 'session aliases', timeoutMs: 5000 });
  } catch (error) {
    log(`[Aliases] Error locking aliases: ${error.message}`);
    return failure;
  }

  activeWrites.add(aliasesPath);
  let result;
  let primaryError;
  let callbackFailed = false;
  let releaseError;
  try {
    result = callback();
  } catch (error) {
    callbackFailed = true;
    primaryError = error;
  } finally {
    try {
      release();
    } catch (error) {
      releaseError = error;
    }
    activeWrites.delete(aliasesPath);
  }
  if (callbackFailed) {
    if (releaseError) log(`[Aliases] Error releasing aliases lock: ${releaseError.message}`);
    throw primaryError;
  }
  if (releaseError) {
    log(`[Aliases] Error releasing aliases lock: ${releaseError.message}`);
    return failure;
  }
  return result;
}

function saveAliasesUnlocked(aliases) {
  try {
    const snapshot = {
      ...aliases,
      metadata: {
        totalCount: Object.keys(aliases.aliases).length,
        lastUpdated: new Date().toISOString()
      }
    };
    writeFileAtomic(getAliasesPath(), JSON.stringify(snapshot, null, 2));
    return true;
  } catch (error) {
    log(`[Aliases] Error saving aliases: ${error.message}`);
    return false;
  }
}

/**
 * Atomically replace the complete snapshot. This does not merge snapshots
 * loaded by callers before acquiring the lock; use the mutators for updates.
 * @param {object} aliases - Complete aliases snapshot
 * @returns {boolean} Success status
 */
function saveAliases(aliases) {
  return withAliasesLock(() => saveAliasesUnlocked(aliases), false);
}

/**
 * Resolve an alias to get session path
 * @param {string} alias - Alias name to resolve
 * @returns {object|null} Alias data or null if not found
 */
function resolveAlias(alias) {
  if (!alias) return null;

  // Validate alias name (alphanumeric, dash, underscore)
  if (!/^[a-zA-Z0-9_-]+$/.test(alias)) {
    return null;
  }

  const data = loadAliases();
  const aliasData = data.aliases[alias];

  if (!aliasData) {
    return null;
  }

  return {
    alias,
    sessionPath: aliasData.sessionPath,
    createdAt: aliasData.createdAt,
    title: aliasData.title || null
  };
}

/**
 * Set or update an alias for a session
 * @param {string} alias - Alias name (alphanumeric, dash, underscore)
 * @param {string} sessionPath - Session directory path
 * @param {string} title - Optional title for the alias
 * @returns {object} Result with success status and message
 */
function setAliasUnlocked(alias, sessionPath, title = null) {
  // Validate alias name
  if (!alias || alias.length === 0) {
    return { success: false, error: 'Alias name cannot be empty' };
  }

  // Validate session path
  if (!sessionPath || typeof sessionPath !== 'string' || sessionPath.trim().length === 0) {
    return { success: false, error: 'Session path cannot be empty' };
  }

  if (alias.length > 128) {
    return { success: false, error: 'Alias name cannot exceed 128 characters' };
  }

  if (!/^[a-zA-Z0-9_-]+$/.test(alias)) {
    return { success: false, error: 'Alias name must contain only letters, numbers, dashes, and underscores' };
  }

  // Reserved alias names
  const reserved = ['list', 'help', 'remove', 'delete', 'create', 'set'];
  if (reserved.includes(alias.toLowerCase())) {
    return { success: false, error: `'${alias}' is a reserved alias name` };
  }

  const data = loadAliases();
  const existing = data.aliases[alias];
  const isNew = !existing;

  data.aliases[alias] = {
    sessionPath,
    createdAt: existing ? existing.createdAt : new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    title: title || null
  };

  if (saveAliasesUnlocked(data)) {
    return {
      success: true,
      isNew,
      alias,
      sessionPath,
      title: data.aliases[alias].title
    };
  }

  return { success: false, error: 'Failed to save alias' };
}

/**
 * List all aliases
 * @param {object} options - Options object
 * @param {string} options.search - Filter aliases by name (partial match)
 * @param {number} options.limit - Maximum number of aliases to return
 * @returns {Array} Array of alias objects
 */
function listAliases(options = {}) {
  const { search = null, limit = null } = options;
  const data = loadAliases();

  let aliases = Object.entries(data.aliases).map(([name, info]) => ({
    name,
    sessionPath: info.sessionPath,
    createdAt: info.createdAt,
    updatedAt: info.updatedAt,
    title: info.title
  }));

  // Sort by updated time (newest first)
  aliases.sort((a, b) => (new Date(b.updatedAt || b.createdAt || 0).getTime() || 0) - (new Date(a.updatedAt || a.createdAt || 0).getTime() || 0));

  // Apply search filter
  if (search) {
    const searchLower = search.toLowerCase();
    aliases = aliases.filter(a =>
      a.name.toLowerCase().includes(searchLower) ||
      (a.title && a.title.toLowerCase().includes(searchLower))
    );
  }

  // Apply limit
  if (limit && limit > 0) {
    aliases = aliases.slice(0, limit);
  }

  return aliases;
}

/**
 * Delete an alias
 * @param {string} alias - Alias name to delete
 * @returns {object} Result with success status
 */
function deleteAliasUnlocked(alias) {
  const data = loadAliases();

  if (!data.aliases[alias]) {
    return { success: false, error: `Alias '${alias}' not found` };
  }

  const deleted = data.aliases[alias];
  delete data.aliases[alias];

  if (saveAliasesUnlocked(data)) {
    return {
      success: true,
      alias,
      deletedSessionPath: deleted.sessionPath
    };
  }

  return { success: false, error: 'Failed to delete alias' };
}

/**
 * Rename an alias
 * @param {string} oldAlias - Current alias name
 * @param {string} newAlias - New alias name
 * @returns {object} Result with success status
 */
function renameAliasUnlocked(oldAlias, newAlias) {
  const data = loadAliases();

  if (!data.aliases[oldAlias]) {
    return { success: false, error: `Alias '${oldAlias}' not found` };
  }

  // Validate new alias name (same rules as setAlias)
  if (!newAlias || newAlias.length === 0) {
    return { success: false, error: 'New alias name cannot be empty' };
  }

  if (newAlias.length > 128) {
    return { success: false, error: 'New alias name cannot exceed 128 characters' };
  }

  if (!/^[a-zA-Z0-9_-]+$/.test(newAlias)) {
    return { success: false, error: 'New alias name must contain only letters, numbers, dashes, and underscores' };
  }

  const reserved = ['list', 'help', 'remove', 'delete', 'create', 'set'];
  if (reserved.includes(newAlias.toLowerCase())) {
    return { success: false, error: `'${newAlias}' is a reserved alias name` };
  }

  if (data.aliases[newAlias]) {
    return { success: false, error: `Alias '${newAlias}' already exists` };
  }

  const aliasData = data.aliases[oldAlias];
  delete data.aliases[oldAlias];

  aliasData.updatedAt = new Date().toISOString();
  data.aliases[newAlias] = aliasData;

  if (saveAliasesUnlocked(data)) {
    return {
      success: true,
      oldAlias,
      newAlias,
      sessionPath: aliasData.sessionPath
    };
  }

  // Atomic replacement leaves the original snapshot intact on failure.
  return { success: false, error: 'Failed to save renamed alias' };
}

/**
 * Get session path by alias (convenience function)
 * @param {string} aliasOrId - Alias name or session ID
 * @returns {string|null} Session path or null if not found
 */
function resolveSessionAlias(aliasOrId) {
  // First try to resolve as alias
  const resolved = resolveAlias(aliasOrId);
  if (resolved) {
    return resolved.sessionPath;
  }

  // If not an alias, return as-is (might be a session path)
  return aliasOrId;
}

/**
 * Update alias title
 * @param {string} alias - Alias name
 * @param {string|null} title - New title (string or null to clear)
 * @returns {object} Result with success status
 */
function updateAliasTitleUnlocked(alias, title) {
  if (title !== null && typeof title !== 'string') {
    return { success: false, error: 'Title must be a string or null' };
  }

  const data = loadAliases();

  if (!data.aliases[alias]) {
    return { success: false, error: `Alias '${alias}' not found` };
  }

  data.aliases[alias].title = title || null;
  data.aliases[alias].updatedAt = new Date().toISOString();

  if (saveAliasesUnlocked(data)) {
    return {
      success: true,
      alias,
      title
    };
  }

  return { success: false, error: 'Failed to update alias title' };
}

/**
 * Get all aliases for a specific session
 * @param {string} sessionPath - Session path to find aliases for
 * @returns {Array} Array of alias names
 */
function getAliasesForSession(sessionPath) {
  const data = loadAliases();
  const aliases = [];

  for (const [name, info] of Object.entries(data.aliases)) {
    if (info.sessionPath === sessionPath) {
      aliases.push({
        name,
        createdAt: info.createdAt,
        title: info.title
      });
    }
  }

  return aliases;
}

/**
 * Clean up aliases for non-existent sessions
 * @param {Function} sessionExists - Function to check if session exists
 * @returns {object} Cleanup result
 */
function cleanupAliasesUnlocked(sessionExists) {
  if (typeof sessionExists !== 'function') {
    return { totalChecked: 0, removed: 0, removedAliases: [], error: 'sessionExists must be a function' };
  }

  const data = loadAliases();
  const removed = [];

  for (const [name, info] of Object.entries(data.aliases)) {
    if (!sessionExists(info.sessionPath)) {
      removed.push({ name, sessionPath: info.sessionPath });
      delete data.aliases[name];
    }
  }

  if (removed.length > 0 && !saveAliasesUnlocked(data)) {
    log('[Aliases] Failed to save after cleanup');
    return {
      success: false,
      totalChecked: Object.keys(data.aliases).length + removed.length,
      removed: removed.length,
      removedAliases: removed,
      error: 'Failed to save after cleanup'
    };
  }

  return {
    success: true,
    totalChecked: Object.keys(data.aliases).length + removed.length,
    removed: removed.length,
    removedAliases: removed
  };
}

function setAlias(alias, sessionPath, title = null) {
  return withAliasesLock(() => setAliasUnlocked(alias, sessionPath, title),
    { success: false, error: 'Failed to save alias' });
}

function deleteAlias(alias) {
  return withAliasesLock(() => deleteAliasUnlocked(alias),
    { success: false, error: 'Failed to delete alias' });
}

function renameAlias(oldAlias, newAlias) {
  return withAliasesLock(() => renameAliasUnlocked(oldAlias, newAlias),
    { success: false, error: 'Failed to save renamed alias' });
}

function updateAliasTitle(alias, title) {
  return withAliasesLock(() => updateAliasTitleUnlocked(alias, title),
    { success: false, error: 'Failed to update alias title' });
}

function cleanupAliases(sessionExists) {
  return withAliasesLock(() => cleanupAliasesUnlocked(sessionExists),
    { success: false, totalChecked: 0, removed: 0, removedAliases: [], error: 'Failed to save after cleanup' });
}

module.exports = {
  getAliasesPath,
  loadAliases,
  saveAliases,
  resolveAlias,
  setAlias,
  listAliases,
  deleteAlias,
  renameAlias,
  resolveSessionAlias,
  updateAliasTitle,
  getAliasesForSession,
  cleanupAliases
};
