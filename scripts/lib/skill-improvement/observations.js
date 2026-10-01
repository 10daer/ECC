'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const OBSERVATION_SCHEMA_VERSION = 'ecc.skill-observation.v1';

function resolveProjectRoot(options = {}) {
  return path.resolve(options.projectRoot || options.cwd || process.cwd());
}

function getSkillTelemetryRoot(options = {}) {
  return path.join(resolveProjectRoot(options), '.claude', 'ecc', 'skills');
}

function getSkillObservationsPath(options = {}) {
  return path.join(getSkillTelemetryRoot(options), 'observations.jsonl');
}

function ensureString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }

  return value.trim();
}

function createObservationId() {
  return `obs-${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
}

function createSkillObservation(input) {
  const task = ensureString(input.task, 'task');
  const skillId = ensureString(input.skill && input.skill.id, 'skill.id');
  const skillPath = typeof input.skill.path === 'string' && input.skill.path.trim().length > 0
    ? input.skill.path.trim()
    : null;
  const success = Boolean(input.success);
  const error = input.error === null || input.error === undefined ? null : String(input.error);
  const feedback = input.feedback === null || input.feedback === undefined ? null : String(input.feedback);
  const variant = typeof input.variant === 'string' && input.variant.trim().length > 0
    ? input.variant.trim()
    : 'baseline';

  return {
    schemaVersion: OBSERVATION_SCHEMA_VERSION,
    observationId: typeof input.observationId === 'string' && input.observationId.length > 0
      ? input.observationId
      : createObservationId(),
    timestamp: typeof input.timestamp === 'string' && input.timestamp.length > 0
      ? input.timestamp
      : new Date().toISOString(),
    task,
    skill: {
      id: skillId,
      path: skillPath
    },
    outcome: {
      success,
      status: success ? 'success' : 'failure',
      error,
      feedback
    },
    run: {
      variant,
      amendmentId: input.amendmentId || null,
      sessionId: input.sessionId || null,
      source: input.source || 'manual'
    }
  };
}

function appendSkillObservation(observation, options = {}) {
  const outputPath = getSkillObservationsPath(options);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.appendFileSync(outputPath, `${JSON.stringify(observation)}${os.EOL}`, 'utf8');
  return outputPath;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isOptionalString(value) {
  return value === null || value === undefined || typeof value === 'string';
}

// Validate fields consumed by health, amendment and evaluation reports while
// leaving optional metadata and extension fields intact.
function isReadableSkillObservation(record) {
  return isObject(record)
    && record.schemaVersion === OBSERVATION_SCHEMA_VERSION
    && typeof record.task === 'string' && record.task.trim().length > 0
    && isObject(record.skill)
    && typeof record.skill.id === 'string' && record.skill.id.trim().length > 0
    && isOptionalString(record.skill.path)
    && isObject(record.outcome)
    && typeof record.outcome.success === 'boolean'
    && isOptionalString(record.outcome.error)
    && isOptionalString(record.outcome.feedback)
    && (record.run === null || record.run === undefined || (
      isObject(record.run) && isOptionalString(record.run.variant)
    ));
}

function readSkillObservations(options = {}) {
  const observationPath = path.resolve(options.observationsPath || getSkillObservationsPath(options));
  if (!fs.existsSync(observationPath)) {
    return [];
  }

  return fs.readFileSync(observationPath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(isReadableSkillObservation);
}

module.exports = {
  OBSERVATION_SCHEMA_VERSION,
  appendSkillObservation,
  createSkillObservation,
  getSkillObservationsPath,
  getSkillTelemetryRoot,
  readSkillObservations,
  resolveProjectRoot
};
