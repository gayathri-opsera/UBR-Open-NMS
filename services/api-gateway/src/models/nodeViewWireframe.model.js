'use strict';

/**
 * Node View Wireframe — MongoDB model + Redis cache helpers
 * =========================================================
 *
 * Collection: node_view_wireframes   (in the ubrnms database)
 *
 * One document per (productDefinitionId, versionId) pair.
 * When a definition is activated, its wireframe becomes the active one for that
 * productDefinitionId. Previous versions remain for history / rollback.
 *
 * Cache key: nwf:{productDefinitionId}   → active wireframe JSON
 * TTL: 1 hour (invalidated immediately on new activation).
 */

const mongoose = require('mongoose');

// ── Sub-schemas ───────────────────────────────────────────────────────────────

const ParameterSpecSchema = new mongoose.Schema({
  parameterId:     { type: String, required: true },
  displayName:     { type: String, required: true },
  dataType:        { type: String, default: 'STRING' },
  unit:            { type: String, default: null },
  uiWidget:        { type: String, default: null },
  effectiveWidget: { type: String, required: true },
  readOnly:        { type: Boolean, default: true },
  snmpOid:         { type: String, default: null },
  hidden:          { type: Boolean, default: false },
  displayOrder:    { type: Number, default: 0 },
  subGroup:        { type: String, default: null },
  enumValues:      { type: [String], default: [] },
  options:         { type: [new mongoose.Schema({ value: String, label: String }, { _id: false })], default: [] },
  minValue:        { type: Number, default: null },
  maxValue:        { type: Number, default: null },
  defaultValue:    { type: String, default: null },
  description:     { type: String, default: null },
  thresholds:      { type: mongoose.Schema.Types.Mixed, default: null },
  uiVisibleTo:     { type: [String], default: [] },
  sensitive:       { type: Boolean, default: false },
}, { _id: false });

const GroupSpecSchema = new mongoose.Schema({
  groupId:             { type: String, required: true },
  label:               { type: String, required: true },
  displayOrder:        { type: Number, default: 0 },
  pollIntervalSeconds: { type: Number, default: 60 },
  subGroups:           { type: [String], default: [] },
  parameters:          { type: [ParameterSpecSchema], default: [] },
}, { _id: false });

const WireframeBodySchema = new mongoose.Schema({
  groups: { type: [GroupSpecSchema], default: [] },
}, { _id: false });

// ── Main schema ───────────────────────────────────────────────────────────────

const NodeViewWireframeSchema = new mongoose.Schema(
  {
    /** Stable identifier from the product-definition-service (e.g. 'ubiquiti-airmax-radio'). */
    productDefinitionId: { type: String, required: true, index: true },
    /** UUID version identifier from the product-definition-service. */
    versionId:           { type: String, required: true },
    /** Human-readable registry version string (e.g. 'v3'). */
    registryVersion:     { type: String, default: '' },
    /** ACTIVE = this is the current wireframe for the productDefinitionId.
     *  SUPERSEDED = a newer activation has taken over.
     *  DRAFT = built but not yet the active one. */
    status: {
      type: String,
      enum: ['ACTIVE', 'SUPERSEDED', 'DRAFT'],
      default: 'DRAFT',
      index: true,
    },
    /** The full layout — groups, sub-groups, parameters + all rendering metadata. */
    wireframe:      { type: WireframeBodySchema, required: true },
    /** Shape version of the persisted wireframe; older documents are rebuilt on read. */
    schemaVersion:  { type: Number, default: 1 },
    /** Hash of the registry entries the wireframe was built from — a changed registry triggers a rebuild. */
    fingerprint:    { type: String, default: '' },
    parameterCount: { type: Number, default: 0 },
    groupCount:     { type: Number, default: 0 },
    /** Non-fatal issues found during build (logged, not blocking). */
    validationWarnings: { type: [String], default: [] },
  },
  {
    timestamps: true,   // adds createdAt, updatedAt
    collection: 'node_view_wireframes',
  },
);

// Compound index: fast lookup of the active wireframe for a definition.
NodeViewWireframeSchema.index({ productDefinitionId: 1, status: 1 });
// Fast lookup by (definitionId, versionId) — used for versioned lookups.
NodeViewWireframeSchema.index({ productDefinitionId: 1, versionId: 1 }, { unique: true });

const NodeViewWireframe = mongoose.model('NodeViewWireframe', NodeViewWireframeSchema);

// ── Redis cache helpers ───────────────────────────────────────────────────────

const CACHE_TTL_SECONDS = 3600;   // 1 hour

function cacheKey(productDefinitionId) {
  return `nwf:${productDefinitionId}`;
}

/**
 * Read the active wireframe from Redis cache.
 * Returns null when cache is cold or Redis is unavailable.
 *
 * @param {import('ioredis').Redis|null} redis
 * @param {string} productDefinitionId
 */
async function getFromCache(redis, productDefinitionId) {
  if (!redis) return null;
  try {
    const raw = await redis.get(cacheKey(productDefinitionId));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * Write the active wireframe document to Redis.
 *
 * @param {import('ioredis').Redis|null} redis
 * @param {string} productDefinitionId
 * @param {object} doc   Plain JS object (the wireframe document).
 */
async function setInCache(redis, productDefinitionId, doc) {
  if (!redis) return;
  try {
    await redis.set(cacheKey(productDefinitionId), JSON.stringify(doc), 'EX', CACHE_TTL_SECONDS);
  } catch { /* non-fatal */ }
}

/**
 * Invalidate the cache for a product definition (call on new activation).
 *
 * @param {import('ioredis').Redis|null} redis
 * @param {string} productDefinitionId
 */
async function invalidateCache(redis, productDefinitionId) {
  if (!redis) return;
  try {
    await redis.del(cacheKey(productDefinitionId));
  } catch { /* non-fatal */ }
}

module.exports = {
  NodeViewWireframe,
  getFromCache,
  setInCache,
  invalidateCache,
};
