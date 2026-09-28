'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const {
  hasExplicitCommitAttributionPreference,
  withCommitAttributionDisabled,
} = require('../claude-commit-attribution');
const { readInstallState, writeInstallState } = require('../install-state');
const {
  assertHookConsentReady,
  disableOpenCodeHookPluginRegistration,
  getDisabledOpenCodePluginContent,
  getRecordedHookConsent,
  isOpenCodeHookActivationOperation,
  isOpenCodePluginEntrypoint,
  planMaterializesHookRuntime,
  shouldDisableOpenCodeHooks,
} = require('./hook-consent');
const {
  getClaudeSettingsPath,
  mergeManagedHooks,
  readSettings,
  runWithSettingsLock,
  uninstallManagedHooks,
  updateSettingsAtomic,
  validateManagedHooks,
  validateRecordedManagedHooks,
} = require('./claude-settings');
const { filterMcpConfig, parseDisabledMcpServers } = require('../mcp-config');
const { assertWithinTrustedRoot } = require('../path-safety');
const {
  assertSafeClaudeSkillOperation,
  prepareClaudeSkillMigration,
  removeLegacyClaudeSkillFiles,
} = require('./claude-skill-migration');
const { cleanupLegacyAntigravityInstall } = require('./antigravity-legacy-migration');
const {
  assertNoNewUserOwnedFile,
  prepareUserOwnedFileGuard,
  preserveUnwrittenFiles,
} = require('./ownership-guard');
const { cleanupLegacyOpencodeInstall, getLegacyLocationForPlan } = require('./opencode-legacy-migration');
const { writeFileNoFollow } = require('./guarded-write');
const { withOpenCodeInstallLocks } = require('./opencode-install-lock');
const {
  completeExcludedPathsReconciliation,
  prepareExcludedPathsReconciliation,
} = require('./excluded-paths-reconciliation');
const { buildInstallIndex, rewriteRelativeLinks } = require('./link-rewrite');
const { adaptAntigravityAgent } = require('./antigravity-agent');

function isMarkdownPath(filePath) {
  return /\.(md|mdx|markdown)$/i.test(String(filePath || ''));
}

function transformInstallContent(operation, content) {
  if (!operation.contentTransform) {
    return content;
  }
  if (operation.contentTransform === 'antigravity-agent-frontmatter') {
    return adaptAntigravityAgent(content, operation.sourceRelativePath);
  }
  if (operation.contentTransform === 'opencode-disable-ecc-hooks') {
    return disableOpenCodeHookPluginRegistration(content, operation.sourceRelativePath);
  }
  if (operation.contentTransform === 'opencode-disable-plugin-entrypoint') {
    return getDisabledOpenCodePluginContent();
  }
  throw new Error(`Unknown install content transform: ${operation.contentTransform}`);
}

// Map every copy-file operation to { sourceRel, destRel } so relative links in
// namespaced markdown can be rewritten to the file's actual installed location
// (issue #2340). Returns null when the plan lacks the data needed to do so.
function buildLinkIndexForPlan(plan) {
  if (!plan || !plan.targetRoot || !Array.isArray(plan.operations)) {
    return null;
  }
  const mappings = [];
  for (const operation of plan.operations) {
    if (operation.kind === 'copy-file' && operation.sourceRelativePath) {
      mappings.push({
        sourceRel: operation.sourceRelativePath,
        destRel: path.relative(plan.targetRoot, operation.destinationPath),
      });
    }
  }
  return buildInstallIndex(mappings);
}

function readJsonObject(filePath, label) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    const wrappedError = new Error(`Failed to parse ${label} at ${filePath}: ${error.message}`);
    wrappedError.code = error.code;
    throw wrappedError;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Invalid ${label} at ${filePath}: expected a JSON object`);
  }

  return parsed;
}

function readOptionalJsonObject(filePath, label) {
  try {
    return readJsonObject(filePath, label);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {};
    }
    throw error;
  }
}

function readInstalledFileNoFollow(plan, operation) {
  assertSafeInstallOperation(plan, operation);
  assertSafeClaudeSkillOperation(plan, operation);
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
  let descriptor;
  try {
    descriptor = fs.openSync(operation.destinationPath, flags);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }

  try {
    const openedStat = fs.fstatSync(descriptor, { bigint: true });
    const finalPathStat = fs.lstatSync(operation.destinationPath, { bigint: true });
    if (finalPathStat.isSymbolicLink() || !finalPathStat.isFile()) {
      return null;
    }
    const identityMatches = openedStat.ino === finalPathStat.ino
      && (!openedStat.dev || !finalPathStat.dev || openedStat.dev === finalPathStat.dev);
    if (!openedStat.isFile() || !identityMatches) {
      throw new Error(
        `Refusing to hash changed install destination: ${operation.destinationPath}`
      );
    }
    // Revalidate the full path after opening. The descriptor pins the file so
    // the digest and metadata refer to the same object.
    assertSafeInstallOperation(plan, operation);
    assertSafeClaudeSkillOperation(plan, operation);
    return fs.readFileSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function stateWithContentDigests(state, plan) {
  const currentDestinations = new Set((plan.operations || [])
    .filter(operation => operation.destinationPath)
    .map(operation => {
      const resolved = path.resolve(operation.destinationPath);
      return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    }));
  return {
    ...state,
    operations: (state.operations || []).map(operation => {
      if (!operation.destinationPath) {
        return { ...operation };
      }
      const resolved = path.resolve(operation.destinationPath);
      const destinationKey = process.platform === 'win32'
        ? resolved.toLowerCase()
        : resolved;
      if (!currentDestinations.has(destinationKey)) {
        return { ...operation };
      }
      const installedContent = readInstalledFileNoFollow(plan, operation);
      if (installedContent === null) {
        return { ...operation };
      }
      return {
        ...operation,
        contentSha256: crypto.createHash('sha256')
          .update(installedContent)
          .digest('hex'),
      };
    }),
  };
}

function cloneJsonValue(value) {
  if (value === undefined) {
    return undefined;
  }

  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function deepMergeJson(baseValue, patchValue) {
  if (!isPlainObject(baseValue) || !isPlainObject(patchValue)) {
    return cloneJsonValue(patchValue);
  }

  const merged = { ...baseValue };
  for (const [key, value] of Object.entries(patchValue)) {
    if (isPlainObject(value) && isPlainObject(merged[key])) {
      merged[key] = deepMergeJson(merged[key], value);
    } else {
      merged[key] = cloneJsonValue(value);
    }
  }
  return merged;
}

function formatJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function shouldSetClaudeCommitAttributionPreference(plan) {
  if (!plan?.adapter || !['claude', 'claude-project'].includes(plan.adapter.target)) {
    return false;
  }

  return plan.operations.some(operation => {
    if (typeof operation?.destinationPath !== 'string') {
      return false;
    }
    const relativePath = path.relative(plan.targetRoot, operation.destinationPath);
    return relativePath && !relativePath.startsWith(`docs${path.sep}`) && relativePath !== 'docs';
  });
}

function writeClaudeCommitAttributionPreference(settingsPath, options = {}) {
  let settings;
  try {
    settings = readSettings(settingsPath);
  } catch (_error) {
    // Unreadable or malformed settings belong to the user; leave them untouched.
    return false;
  }

  if (hasExplicitCommitAttributionPreference(settings)) {
    return false;
  }

  let changed = false;
  updateSettingsAtomic(settingsPath, latestSettings => {
    if (hasExplicitCommitAttributionPreference(latestSettings)) {
      return { settings: latestSettings };
    }
    changed = true;
    return { settings: withCommitAttributionDisabled(latestSettings) };
  }, options);
  return changed;
}

function isMcpConfigPath(filePath) {
  const basename = path.basename(String(filePath || ''));
  return basename === '.mcp.json' || basename === 'mcp.json';
}

function assertSafeInstallOperation(plan, operation) {
  if (!operation || typeof operation.destinationPath !== 'string') {
    throw new Error('Refusing to apply install operation: missing destination path.');
  }

  const targetRoot = plan && plan.targetRoot;
  assertWithinTrustedRoot(operation.destinationPath, targetRoot, 'install ECC file');

  const resolvedRoot = path.resolve(targetRoot);
  const resolvedTarget = path.resolve(operation.destinationPath);
  const relativePath = path.relative(resolvedRoot, resolvedTarget);
  const segments = relativePath ? relativePath.split(path.sep) : [];
  for (const segmentIndex of Array.from({ length: segments.length + 1 }, (_value, index) => index)) {
    const currentPath = segmentIndex === 0
      ? resolvedRoot
      : path.join(resolvedRoot, ...segments.slice(0, segmentIndex));
    try {
      const stats = fs.lstatSync(currentPath);
      if (stats.isSymbolicLink()) {
        throw new Error(
          `Refusing to install ECC file through symlinked path: '${currentPath}'.`
        );
      }
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        break;
      }
      throw error;
    }
  }
}

function readPreviousInstallState(plan) {
  if (!fs.existsSync(plan.installStatePath)) {
    return null;
  }
  return readInstallState(plan.installStatePath);
}

function comparablePath(filePath) {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function getOpenCodeActivationKind(plan, operation) {
  const relative = operation.destinationPath
    ? path.relative(plan.targetRoot, operation.destinationPath).split(path.sep).join('/').toLowerCase()
    : '';
  if (/^plugins\/(?:[^/]+\.(?:[cm]?js|ts)|[^/]+\/(?:index\.(?:[cm]?js|ts)|package\.json))$/.test(relative)) {
    return 'plugin';
  }
  if (relative === 'opencode.json') return 'config';
  if (isOpenCodePluginEntrypoint(operation)) return 'plugin';
  return isOpenCodeHookActivationOperation(operation) ? 'config' : null;
}

function openCodeActivationCandidates(plan, previousOperations) {
  const candidates = new Map();
  for (const operation of [...previousOperations, ...plan.operations]) {
    if (getOpenCodeActivationKind(plan, operation) && operation.destinationPath) {
      candidates.set(comparablePath(operation.destinationPath), operation);
    }
  }
  // Old installs can leave aliases that are absent from the new source tree.
  // Inspect only ECC's known entrypoint names, never unrelated user plugins.
  for (const name of ['ecc-hooks', 'index']) {
    for (const extension of ['ts', 'js', 'mjs', 'cjs']) {
      const destinationPath = path.join(plan.targetRoot, 'plugins', `${name}.${extension}`);
      const key = comparablePath(destinationPath);
      if (!candidates.has(key)) {
        candidates.set(key, {
          sourceRelativePath: `.opencode/plugins/${name}.${extension}`,
          destinationPath,
        });
      }
    }
  }
  return candidates;
}

function activationIsInactive(kind, operation, content) {
  if (kind === 'plugin') {
    return content.toString('utf8') === getDisabledOpenCodePluginContent();
  }
  const text = content.toString('utf8');
  // Validate first so malformed JSON retains its source context.
  disableOpenCodeHookPluginRegistration(text, operation.sourceRelativePath || operation.destinationPath);
  const config = JSON.parse(text);
  return !Array.isArray(config.plugin) || !config.plugin.includes('./plugins');
}

function assertOpenCodeHookDeactivationReady(plan, options = {}) {
  if (!shouldDisableOpenCodeHooks(plan)) {
    return new Map();
  }
  assertSafeInstallOperation(plan, { destinationPath: plan.installStatePath });
  const previousState = readPreviousInstallState(plan);
  if (previousState && (
    previousState.target.id !== plan.adapter.id
    || comparablePath(previousState.target.root) !== comparablePath(plan.targetRoot)
    || comparablePath(previousState.target.installStatePath) !== comparablePath(plan.installStatePath)
  )) {
    throw new Error('Refusing OpenCode hook deactivation: install-state target mismatch.');
  }
  const previous = new Map(((previousState && previousState.operations) || [])
    .filter(operation => operation.ownership === 'managed' && operation.destinationPath)
    .map(operation => [comparablePath(operation.destinationPath), operation]));
  const desired = new Map(plan.operations.filter(operation => getOpenCodeActivationKind(plan, operation))
    .map(operation => [comparablePath(operation.destinationPath), operation]));
  const snapshot = new Map();
  for (const [key, operation] of openCodeActivationCandidates(plan, [...previous.values()])) {
    const kind = getOpenCodeActivationKind(plan, operation);
    const expectedTransform = kind === 'plugin'
      ? 'opencode-disable-plugin-entrypoint' : 'opencode-disable-ecc-hooks';
    const replacement = desired.get(key);
    // Validate planned activation even when its destination does not yet exist.
    // Recorded operations may name an unrelated source or use render-template.
    if (replacement && (replacement.kind !== 'copy-file'
      || replacement.contentTransform !== expectedTransform)) {
      throw new Error(`Refusing OpenCode hook deactivation: unsupported activation operation at ${operation.destinationPath}`);
    }
    const content = readInstalledFileNoFollow(plan, operation);
    if (content === null && fs.existsSync(operation.destinationPath)) {
      throw new Error(`Refusing OpenCode hook deactivation: non-file activation at ${operation.destinationPath}`);
    }
    const digest = content === null ? null : crypto.createHash('sha256').update(content).digest('hex');
    snapshot.set(key, digest);
    if (content === null) continue;
    const inactive = activationIsInactive(kind, operation, content);
    if (options.requireInactive) {
      if (!inactive) {
        throw new Error(`OpenCode hook activation remains active at ${operation.destinationPath}`);
      }
      continue;
    }
    if (kind === 'plugin' && inactive) continue;
    const recorded = previous.get(key);
    if (!replacement || replacement.kind !== 'copy-file'
      || replacement.contentTransform !== expectedTransform
      || !recorded || recorded.contentSha256 !== digest) {
      throw new Error(`Refusing OpenCode hook deactivation: user-owned, modified, unverifiable or stale activation at ${operation.destinationPath}`);
    }
  }
  return snapshot;
}

function assertOpenCodeActivationUnchanged(plan, operation, snapshot) {
  const key = comparablePath(operation.destinationPath);
  if (!snapshot.has(key)) return;
  const content = readInstalledFileNoFollow(plan, operation);
  const digest = content === null ? null : crypto.createHash('sha256').update(content).digest('hex');
  if (digest !== snapshot.get(key)) {
    throw new Error(`Refusing OpenCode hook deactivation: activation changed after preflight at ${operation.destinationPath}`);
  }
}

function getOpenCodeActivationWriteOptions(operation, snapshot) {
  const key = comparablePath(operation.destinationPath);
  if (!snapshot.has(key)) return {};
  const digest = snapshot.get(key);
  return { expectedContent: Object.freeze(digest === null
    ? { kind: 'absent' } : { kind: 'sha256', digest }) };
}

function getOpenCodeInstallRoots(plan) {
  const roots = [plan.targetRoot];
  const legacy = getLegacyLocationForPlan(plan);
  if (legacy) {
    try {
      fs.lstatSync(legacy.targetRoot);
      roots.push(legacy.targetRoot);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return roots;
}

function findPreviousManagedHooks(previousState, plan, operation) {
  if (
    !previousState
    || previousState.target.id !== plan.adapter.id
    || comparablePath(previousState.target.root) !== comparablePath(plan.targetRoot)
    || comparablePath(previousState.target.installStatePath) !== comparablePath(plan.installStatePath)
  ) {
    return null;
  }

  const previousOperation = (previousState.operations || []).find(candidate => (
    candidate.kind === operation.kind
    && comparablePath(candidate.destinationPath) === comparablePath(operation.destinationPath)
  ));
  if (!previousOperation || !previousOperation.managedHooks) {
    return null;
  }

  return validateRecordedManagedHooks(
    previousOperation.managedHooks,
    'previous managed hooks'
  );
}

function preflightClaudeSettingsOperations(plan) {
  const settingsOperations = plan.operations.filter(operation => (
    operation.kind === 'update-claude-settings'
    || operation.kind === 'remove-claude-settings-hooks'
  ));
  if (settingsOperations.length === 0) {
    return new Map();
  }

  const previousState = readPreviousInstallState(plan);
  return new Map(settingsOperations.map(operation => {
    assertSafeInstallOperation(plan, operation);
    const managedHooks = validateManagedHooks(operation.managedHooks);
    const settings = readSettings(operation.destinationPath);
    const previousManagedHooks = findPreviousManagedHooks(previousState, plan, operation);
    if (operation.kind === 'remove-claude-settings-hooks') {
      const removal = uninstallManagedHooks(settings, managedHooks);
      if (removal.retained.length > 0) {
        throw new Error(
          `Refusing to disable modified Claude hooks in ${operation.destinationPath}; `
          + 'run the ECC uninstaller to review retained entries.'
        );
      }
    } else {
      mergeManagedHooks(settings, managedHooks, { previousManagedHooks });
    }
    return [operation, { managedHooks, previousManagedHooks }];
  }));
}

function prepareHookConsentMigration(plan, migration) {
  if (shouldDisableOpenCodeHooks(plan) && migration.requiresBridgeState) {
    const previousState = readPreviousInstallState(plan);
    if (previousState) {
      const previousConsent = getRecordedHookConsent(previousState);
      return {
        ...migration,
        // A checkpoint is not a completed consent transition. On failure,
        // retain the previous decision until every activation is inactive.
        bridgeState: {
          ...migration.bridgeState,
          request: { ...migration.bridgeState.request, hookConsent: previousConsent },
          resolution: {
            ...migration.bridgeState.resolution,
            selectedModules: previousConsent === 'enabled'
              ? [...new Set([...migration.bridgeState.resolution.selectedModules, 'hooks-runtime'])]
              : migration.bridgeState.resolution.selectedModules,
          },
        },
      };
    }
  }
  if (plan.hookConsent !== 'declined') {
    return migration;
  }
  const previousState = readPreviousInstallState(plan);
  if (!previousState) {
    return migration;
  }

  const removals = (previousState.operations || [])
    .filter(operation => operation.kind === 'update-claude-settings')
    .map(operation => ({
      ...operation,
      kind: 'remove-claude-settings-hooks',
      strategy: 'remove-hook-ids',
      scaffoldOnly: false,
    }));
  if (removals.length === 0) {
    return migration;
  }
  const removalDestinations = new Set(removals.map(operation => comparablePath(
    operation.destinationPath
  )));
  return {
    ...migration,
    // Disable hooks only after every ordinary install operation succeeds so a
    // partial reinstall cannot silently revoke working hooks before failing.
    appliedOperations: [...migration.appliedOperations, ...removals],
    finalState: {
      ...migration.finalState,
      operations: migration.finalState.operations.filter(operation => !(
        operation.kind === 'update-claude-settings'
        && removalDestinations.has(comparablePath(operation.destinationPath))
      )),
    },
    bridgeState: {
      ...migration.bridgeState,
      request: {
        ...migration.bridgeState.request,
        hookConsent: 'enabled',
      },
      resolution: {
        ...migration.bridgeState.resolution,
        selectedModules: [...new Set([
          ...migration.bridgeState.resolution.selectedModules,
          'hooks-runtime',
        ])],
      },
    },
    requiresBridgeState: true,
  };
}

function previewInstallPlan(plan) {
  assertOpenCodeHookDeactivationReady(plan);
  const migration = prepareHookConsentMigration(
    plan,
    prepareUserOwnedFileGuard(plan, prepareClaudeSkillMigration(plan))
  );
  const appliedPlan = {
    ...plan,
    operations: migration.appliedOperations,
  };
  preflightClaudeSettingsOperations(appliedPlan);
  const hookConsentWarnings = planMaterializesHookRuntime(plan) && plan.hookConsent !== 'enabled'
    ? ['Applying this plan requires an explicit hook decision: --enable-hooks or --no-hooks.']
    : [];
  return {
    ...plan,
    statePreview: migration.finalState,
    plannedOperations: [...plan.operations],
    operations: migration.appliedOperations,
    skippedOperations: migration.skippedOperations,
    warnings: [
      ...(Array.isArray(plan.warnings) ? plan.warnings : []),
      ...migration.warnings,
      ...hookConsentWarnings,
    ],
    applied: false,
  };
}

function applyInstallPlan(plan, dependencies = {}) {
  assertHookConsentReady(plan);
  if (plan.adapter?.target === 'opencode') {
    assertSafeInstallOperation(plan, { destinationPath: plan.installStatePath });
    return withOpenCodeInstallLocks(
      getOpenCodeInstallRoots(plan),
      () => applyInstallPlanLocked(plan, dependencies, false),
      dependencies.opencodeLease
    );
  }
  const isClaudeManualTarget = plan.adapter
    && (plan.adapter.target === 'claude' || plan.adapter.target === 'claude-project');
  const settingsPathToLock = isClaudeManualTarget
    ? getClaudeSettingsPath(plan.targetRoot)
    : null;
  if (settingsPathToLock) {
    assertSafeInstallOperation(plan, { destinationPath: settingsPathToLock });
  }
  return settingsPathToLock
    ? runWithSettingsLock(
      settingsPathToLock,
      () => applyInstallPlanLocked(plan, dependencies, true)
    )
    : applyInstallPlanLocked(plan, dependencies, false);
}

function applyInstallPlanLocked(plan, dependencies = {}, settingsLockHeld = false) {
  const persistInstallState = dependencies.writeInstallState || writeInstallState;
  const beforeInstallStateRead = dependencies.beforeInstallStateRead;
  const beforeOperationWrite = dependencies.beforeOperationWrite;
  const beforeInstallStateWrite = dependencies.beforeInstallStateWrite;
  if (typeof beforeInstallStateRead === 'function') {
    beforeInstallStateRead({ plan });
  }
  const activationSnapshot = assertOpenCodeHookDeactivationReady(plan);
  const migration = prepareExcludedPathsReconciliation(
    plan,
    prepareHookConsentMigration(
      plan,
      prepareUserOwnedFileGuard(plan, prepareClaudeSkillMigration(plan))
    )
  );
  const appliedPlan = {
    ...plan,
    operations: migration.appliedOperations,
  };
  const preparedClaudeSettings = preflightClaudeSettingsOperations(appliedPlan);
  const disabledServers = parseDisabledMcpServers(process.env.ECC_DISABLED_MCPS);
  const linkIndex = buildLinkIndexForPlan(appliedPlan);
  const hasLegacyMigration = migration.legacyOperationsToRemove.length > 0;
  const hookRemovalCount = appliedPlan.operations.filter(operation => (
    operation.kind === 'remove-claude-settings-hooks'
  )).length;
  let completedHookRemovalCount = 0;
  const writtenDestinations = new Set();
    if (migration.requiresBridgeState) {
      // Own every operation that may be written during a flat-skill migration
      // before the first copy. A later failure is retryable and uninstall can
      // clean the entire partial install, including non-skill files. During
      // legacy migration the bridge also retains the prior managed operations.
      if (typeof beforeInstallStateWrite === 'function') {
        beforeInstallStateWrite({ plan: appliedPlan, state: migration.bridgeState });
      }
      persistInstallState(plan.installStatePath, migration.bridgeState);
    }

    let finalState;
    try {
      for (const operation of appliedPlan.operations) {
      assertSafeInstallOperation(appliedPlan, operation);
      assertSafeClaudeSkillOperation(appliedPlan, operation);
      fs.mkdirSync(path.dirname(operation.destinationPath), { recursive: true });
      // Recheck directories that were absent during the first validation. This
      // narrows the symlink-swap window around mkdirSync, but path checks cannot
      // eliminate a later TOCTOU race before the file write.
      assertSafeInstallOperation(appliedPlan, operation);
      assertSafeClaudeSkillOperation(appliedPlan, operation);
      if (typeof beforeOperationWrite === 'function') {
        beforeOperationWrite({ plan: appliedPlan, operation });
      }
      assertNoNewUserOwnedFile(migration, operation, appliedPlan);
      assertOpenCodeActivationUnchanged(appliedPlan, operation, activationSnapshot);

      if (
        operation.kind === 'update-claude-settings'
        || operation.kind === 'remove-claude-settings-hooks'
      ) {
        // Re-read at the write boundary so unrelated settings added after
        // planning are preserved. A same-ID change still fails closed.
        const prepared = preparedClaudeSettings.get(operation);
        assertSafeInstallOperation(appliedPlan, operation);
        updateSettingsAtomic(operation.destinationPath, latestSettings => {
          const merged = operation.kind === 'remove-claude-settings-hooks'
            ? uninstallManagedHooks(latestSettings, prepared.managedHooks)
            : mergeManagedHooks(latestSettings, prepared.managedHooks, {
              previousManagedHooks: prepared.previousManagedHooks,
            });
          if (
            operation.kind === 'remove-claude-settings-hooks'
            && merged.retained.length > 0
          ) {
            throw new Error(
              `Refusing to disable modified Claude hooks in ${operation.destinationPath}; `
              + 'run the ECC uninstaller to review retained entries.'
            );
          }
          return merged;
        }, {
          lockHeld: settingsLockHeld,
          beforeCommit() {
            assertSafeInstallOperation(appliedPlan, operation);
          },
        });
        writtenDestinations.add(operation.destinationPath);
        if (operation.kind === 'remove-claude-settings-hooks') {
          completedHookRemovalCount += 1;
        }
        continue;
      }

      if (operation.kind === 'merge-json') {
        const payload = cloneJsonValue(operation.mergePayload);
        if (payload === undefined) {
          throw new Error(`Missing merge payload for ${operation.destinationPath}`);
        }

        const filteredPayload = (
          isMcpConfigPath(operation.destinationPath) && disabledServers.length > 0
        )
          ? filterMcpConfig(payload, disabledServers).config
          : payload;

        const currentValue = readOptionalJsonObject(
          operation.destinationPath,
          'existing JSON config'
        );
        const mergedValue = deepMergeJson(currentValue, filteredPayload);
        fs.writeFileSync(operation.destinationPath, formatJson(mergedValue), 'utf8');
        writtenDestinations.add(operation.destinationPath);
        continue;
      }

      if (operation.kind === 'copy-file' && isMcpConfigPath(operation.destinationPath) && disabledServers.length > 0) {
        const sourceConfig = readJsonObject(operation.sourcePath, 'MCP config');
        const filteredConfig = filterMcpConfig(sourceConfig, disabledServers).config;
        fs.writeFileSync(operation.destinationPath, formatJson(filteredConfig), 'utf8');
        writtenDestinations.add(operation.destinationPath);
        continue;
      }

      // Declared transforms are part of the install contract and always apply.
      // Markdown link rewriting is additive when the plan has a usable index.
      const needsLinkRewrite = Boolean(
        linkIndex
        && operation.sourceRelativePath
        && isMarkdownPath(operation.destinationPath)
      );
      if (operation.kind === 'copy-file' && (operation.contentTransform || needsLinkRewrite)) {
        const transformed = transformInstallContent(
          operation,
          fs.readFileSync(operation.sourcePath, 'utf8')
        );
        const installedContent = needsLinkRewrite
          ? rewriteRelativeLinks(transformed, {
            sourceRel: operation.sourceRelativePath,
            index: linkIndex,
          })
          : transformed;
        const writeOptions = getOpenCodeActivationWriteOptions(operation, activationSnapshot);
        if (writeOptions.expectedContent) {
          writeFileNoFollow(operation.destinationPath, installedContent, {
            ...writeOptions,
            action: 'install OpenCode activation',
            validateDestination(destinationPath) {
              assertSafeInstallOperation(appliedPlan, { destinationPath });
              assertSafeClaudeSkillOperation(appliedPlan, { destinationPath });
              return destinationPath;
            },
          });
        } else {
          fs.writeFileSync(operation.destinationPath, installedContent, 'utf8');
        }
        writtenDestinations.add(operation.destinationPath);
        continue;
      }

      fs.copyFileSync(operation.sourcePath, operation.destinationPath);
      writtenDestinations.add(operation.destinationPath);
      }

      if (hasLegacyMigration) {
        removeLegacyClaudeSkillFiles(migration, plan.targetRoot);
      }

      if (shouldSetClaudeCommitAttributionPreference(appliedPlan)) {
        writeClaudeCommitAttributionPreference(
          getClaudeSettingsPath(plan.targetRoot),
          { lockHeld: settingsLockHeld }
        );
      }

      assertOpenCodeHookDeactivationReady(appliedPlan, { requireInactive: true });
      finalState = stateWithContentDigests(migration.finalState, appliedPlan);
      if (typeof beforeInstallStateWrite === 'function') {
        beforeInstallStateWrite({ plan: appliedPlan, state: finalState });
      }
      persistInstallState(plan.installStatePath, finalState);
    } catch (error) {
      if (migration.requiresBridgeState) {
        try {
          // The bridge was committed before any writes. Refresh it with hashes of
          // files that now exist so uninstall can remove only bytes this attempt
          // actually installed while preserving user changes.
          persistInstallState(
            plan.installStatePath,
            stateWithContentDigests(
              preserveUnwrittenFiles(
                hookRemovalCount > 0 && completedHookRemovalCount === hookRemovalCount
                  ? migration.finalState
                  : migration.bridgeState,
                migration,
                writtenDestinations
              ),
              {
                ...appliedPlan,
                operations: appliedPlan.operations.filter(operation => (
                  writtenDestinations.has(operation.destinationPath)
                )),
              }
            )
          );
        } catch (checkpointError) {
          throw new Error(
            `${error.message} Install-state checkpoint also failed: ${checkpointError.message}`,
            { cause: error }
          );
        }
      }
      throw error;
    }
    let antigravityMigrationWarnings = [];
  try {
    const antigravityMigration = cleanupLegacyAntigravityInstall(appliedPlan);
    if (antigravityMigration.detected && !antigravityMigration.complete) {
      antigravityMigrationWarnings = [
        'Legacy Antigravity migration is incomplete. ECC preserved modified, unverifiable, or unmanaged content under .agent; review and move anything you want to keep, then rerun the Antigravity install.',
        ...(Array.isArray(antigravityMigration.warnings) ? antigravityMigration.warnings : []),
      ];
    }
  } catch (error) {
    antigravityMigrationWarnings = [
      `Legacy Antigravity cleanup did not finish: ${error.message}. Content under .agent was preserved; remove it manually or rerun the Antigravity install.`,
    ];
  }

  let opencodeMigrationWarnings = [];
  try {
    const opencodeMigration = cleanupLegacyOpencodeInstall(appliedPlan);
    if (opencodeMigration.detected && !opencodeMigration.complete) {
      opencodeMigrationWarnings = [
        'Legacy OpenCode migration is incomplete. ECC preserved modified or unverifiable managed content under ~/.opencode; review it and rerun the OpenCode install.',
        ...(Array.isArray(opencodeMigration.warnings) ? opencodeMigration.warnings : []),
      ];
    }
  } catch (error) {
    opencodeMigrationWarnings = [
      `Legacy OpenCode cleanup did not finish: ${error.message}. Content under ~/.opencode was preserved; rerun the OpenCode install or review it manually.`,
    ];
  }

  let excludedPathsRemoved = [];
  let excludedPathsWarnings = [];
  try {
    const excludedReconciliation = completeExcludedPathsReconciliation(migration, appliedPlan);
    excludedPathsRemoved = excludedReconciliation.removedPaths;
    excludedPathsWarnings = excludedReconciliation.warnings;
  } catch (error) {
    excludedPathsWarnings = [
      `Excluded-paths reconciliation did not finish: ${error.message}. Previously managed files under excluded source paths were preserved; remove them manually or rerun the install.`,
    ];
  }

    return {
      ...plan,
      statePreview: finalState,
      plannedOperations: [...plan.operations],
      operations: migration.appliedOperations,
      skippedOperations: migration.skippedOperations,
      reconciledExcludedPaths: excludedPathsRemoved,
      warnings: [
        ...(Array.isArray(plan.warnings) ? plan.warnings : []),
        ...migration.warnings,
        ...antigravityMigrationWarnings,
        ...opencodeMigrationWarnings,
        ...excludedPathsWarnings,
      ],
      applied: true,
    };
}

module.exports = {
  applyInstallPlan,
  assertOpenCodeActivationUnchanged,
  assertOpenCodeHookDeactivationReady,
  getOpenCodeActivationKind,
  getOpenCodeActivationWriteOptions,
  getOpenCodeInstallRoots,
  assertSafeInstallOperation,
  prepareHookConsentMigration,
  previewInstallPlan,
};
