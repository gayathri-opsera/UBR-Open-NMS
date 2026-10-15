'use strict';

/**
 * DescriptorVersion — Mongoose model for Device Descriptor lifecycle
 * ==================================================================
 * Implements the 9-state lifecycle from the Unified NMS Architecture PPT (Slide 9)
 * and the PDL dependency/delete-guard requirements.
 *
 * State machine:
 *   Draft → Validating → Valid → Approved → Active → Deprecated → Retired → Purged
 *                      ↘ Invalid (terminal for this upload; re-upload creates new Draft)
 *
 * Key invariants:
 *   - Immutable from Approved onward (PDL-021)
 *   - dependency.boundDevices must be 0 before retirement (PDL-060)
 *   - Purge allowed only after retiredAt + PURGE_RETENTION_DAYS (PDL-067, default 90)
 *   - Approve must be a different user from the uploader (PDL-110 maker-checker)
 */

const mongoose = require('mongoose');

// ── Sub-schemas ───────────────────────────────────────────────────────────────

/** Identity block (PPT Slide 3 / PDL-002) */
const IdentitySchema = new mongoose.Schema({
  vendor:         { type: String, required: true },
  productFamily:  { type: String, default: '' },
  model:          { type: String, required: true },
  variants:       [{ type: String }],           // e.g. ['BTS', 'CPE']
  firmwareRange:  { type: String, default: '' }, // informational only (PDL-002 / D-04)
  // Device-matching rules (PDL-003): system uses these at discovery to auto-bind
  matchRules: [{
    priority:   { type: Number, default: 1 },
    field:      { type: String, required: true },  // e.g. 'sysObjectId', 'sysDescr'
    op:         { type: String, enum: ['exact', 'regex', 'contains', 'prefix'], default: 'exact' },
    value:      { type: String, required: true },  // exact or regex pattern
  }],
}, { _id: false });

/** Per-version dependency counter (PDL-041) — updated transactionally on bind/unbind */
const DependencySchema = new mongoose.Schema({
  boundDevices:          { type: Number, default: 0 },
  preProvisionedDevices: { type: Number, default: 0 },
  discoveryRules:        { type: Number, default: 0 },
  configProfiles:        { type: Number, default: 0 },
  runningJobs:           { type: Number, default: 0 },
  openAlarms:            { type: Number, default: 0 },
}, { _id: false });

/** Single lifecycle audit entry (PDL-029) */
const LifecycleEventSchema = new mongoose.Schema({
  fromState:        { type: String },
  toState:          { type: String, required: true },
  actorUserId:      { type: String, required: true },
  actorUsername:    { type: String, default: '' },
  actorRole:        { type: String, default: '' },
  reason:           { type: String, default: '' },
  dependencyCounts: { type: Object, default: {} }, // snapshot at transition time
  timestamp:        { type: Date, default: Date.now },
}, { _id: false });

// ── Main schema ───────────────────────────────────────────────────────────────

const DescriptorVersionSchema = new mongoose.Schema({
  // ── Identity ──────────────────────────────────────────────────────────────
  productDefinitionId: { type: String, required: true, index: true },
  version:             { type: String, required: true },  // semver e.g. '1.2.0'
  identity:            { type: IdentitySchema, required: true },

  // ── Lifecycle state (PDL-020) ─────────────────────────────────────────────
  state: {
    type: String,
    enum: ['Draft', 'Validating', 'Invalid', 'Valid', 'Approved', 'Active', 'Deprecated', 'Retired', 'Purged'],
    default: 'Draft',
    index: true,
  },

  // ── Source file reference ─────────────────────────────────────────────────
  sourceFormat:   { type: String, enum: ['xml', 'json', 'xls', 'xlsx'], default: 'xml' },
  sourceFilename: { type: String, default: '' },
  // Canonical definition stored as JSON (the parsed 6-part model)
  canonicalJson:  { type: Object, default: null },
  // Content hash for duplicate detection (PDL-022)
  contentHash:    { type: String, default: '' },

  // ── Validation results ────────────────────────────────────────────────────
  // Each finding: { field, message[, path] } — matches ValidationFinding TS type
  validationErrors:   [{ field: String, message: String, path: String }],
  validationWarnings: [{ field: String, message: String, path: String }],
  validatedAt:        { type: Date, default: null },

  // ── Approval (maker-checker, PDL-110) ─────────────────────────────────────
  uploadedByUserId:   { type: String, default: '' },
  uploadedByUsername: { type: String, default: '' },
  approvedByUserId:   { type: String, default: null },  // must differ from uploader
  approvedByUsername: { type: String, default: null },
  approvedAt:         { type: Date, default: null },

  // ── Default-for-new-bindings flag (PDL-024) ───────────────────────────────
  isDefault: { type: Boolean, default: false },

  // ── Dependency tracking (PDL-041) ─────────────────────────────────────────
  dependency: { type: DependencySchema, default: () => ({}) },

  // ── Retirement & purge (PDL-067) ──────────────────────────────────────────
  deprecatedAt: { type: Date, default: null },
  retiredAt:    { type: Date, default: null },
  purgedAt:     { type: Date, default: null },
  // Days after retirement before purge is allowed (default 90, PDL-067)
  purgeRetentionDays: { type: Number, default: 90 },

  // ── Audit trail (PDL-029, PDL-112) ────────────────────────────────────────
  // Append-only; never deleted even after purge (PDL-113)
  lifecycleHistory: [LifecycleEventSchema],

  // ── Timestamps ────────────────────────────────────────────────────────────
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
}, {
  collection:  'descriptor_versions',
  versionKey:  false,
});

// Compound unique index: one record per product + semantic version (PDL-022)
DescriptorVersionSchema.index({ productDefinitionId: 1, version: 1 }, { unique: true });
// Fast lookup of all active descriptors for a product
DescriptorVersionSchema.index({ productDefinitionId: 1, state: 1 });
// Fast default-version lookup
DescriptorVersionSchema.index({ productDefinitionId: 1, isDefault: 1 });

DescriptorVersionSchema.pre('save', function (next) {
  this.updatedAt = new Date();
  next();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Append a lifecycle event (immutable — never removed, not even on purge).
 * Caller must call save() after.
 */
DescriptorVersionSchema.methods.addLifecycleEvent = function (toState, actor, reason, dependencyCounts) {
  this.lifecycleHistory.push({
    fromState:     this.state,
    toState,
    actorUserId:   actor.userId || actor.sub || 'unknown',
    actorUsername: actor.username || actor.userId || 'unknown',
    actorRole:     actor.role || 'unknown',
    reason:        reason || '',
    dependencyCounts: dependencyCounts || {},
    timestamp:     new Date(),
  });
};

/**
 * Returns true if all blocking dependents are zero (safe to retire).
 */
DescriptorVersionSchema.methods.canRetire = function () {
  const d = this.dependency || {};
  return (
    (d.boundDevices          || 0) === 0 &&
    (d.preProvisionedDevices || 0) === 0 &&
    (d.discoveryRules        || 0) === 0 &&
    (d.configProfiles        || 0) === 0 &&
    (d.runningJobs           || 0) === 0 &&
    (d.openAlarms            || 0) === 0
  );
};

/**
 * Returns true if the purge retention period has elapsed since retirement.
 */
DescriptorVersionSchema.methods.canPurge = function () {
  if (!this.retiredAt) return false;
  const elapsed = (Date.now() - new Date(this.retiredAt).getTime()) / 86_400_000;
  return elapsed >= (this.purgeRetentionDays || 90);
};

/**
 * Build the dependency summary object for API responses / audit snapshots.
 */
DescriptorVersionSchema.methods.dependencySummary = function () {
  return { ...(this.dependency || {}).toObject?.() || this.dependency };
};

const DescriptorVersion = mongoose.model('DescriptorVersion', DescriptorVersionSchema);

module.exports = { DescriptorVersion, DescriptorVersionSchema };
