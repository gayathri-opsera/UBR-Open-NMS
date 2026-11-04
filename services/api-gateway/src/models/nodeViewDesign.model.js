'use strict';
/**
 * Node View Design Model
 * ======================
 * Pre-MIB phase: the admin designs the visual layout of a node view
 * (sections, labels, index levels, lock/freeze) BEFORE uploading a MIB.
 *
 * Lifecycle:
 *   draft  →  ready (once saved with at least one section)
 *
 * After the design is saved, the admin can link a MIB via the MIB Builder.
 * The nodeViewId is passed to the UI Builder as a reference.
 */
const mongoose = require('mongoose');

// ── Label sub-schema ───────────────────────────────────────────────────────────

const LabelSchema = new mongoose.Schema({
  labelId:     { type: String, required: true },
  text:        { type: String, required: true },
  unit:        { type: String, default: null },
  order:       { type: Number, default: 0 },
  /** x/y position within the section grid (columns × rows of 40px cells) */
  position:    { type: { x: Number, y: Number }, default: () => ({ x: 0, y: 0 }) },
  frozen:      { type: Boolean, default: false },
  /** Filled in after the MIB mapping phase (placeholder until then). */
  mappedField: { type: String, default: null },
}, { _id: false });

// ── Section sub-schema ────────────────────────────────────────────────────────

const SectionSchema = new mongoose.Schema({
  sectionId:      { type: String, required: true },
  title:          { type: String, required: true },
  /** Sub-level nesting: null = top-level, otherwise sectionId of the parent. */
  parentSectionId:{ type: String, default: null },
  /**
   * SNMP index level — critical for later MIB object matching.
   *   scalar  = single value (e.g. system name)
   *   single  = indexed by one key (e.g. radio index)
   *   double  = indexed by two keys (e.g. radio + client)
   *   triple  = indexed by three keys (e.g. radio + BSS + client)
   */
  indexLevel:     { type: String, enum: ['scalar', 'single', 'double', 'triple'], default: 'scalar' },
  order:          { type: Number, default: 0 },
  /** Top-left position in the layout canvas (pixels) */
  position:       { type: { x: Number, y: Number }, default: () => ({ x: 0, y: 0 }) },
  /** Width/height in pixels */
  size:           { type: { width: Number, height: Number }, default: () => ({ width: 400, height: 200 }) },
  frozen:         { type: Boolean, default: false },
  labels:         { type: [LabelSchema], default: [] },
}, { _id: false });

// ── Root schema ───────────────────────────────────────────────────────────────

const NodeViewDesignSchema = new mongoose.Schema({
  nodeViewId:    { type: String, required: true, unique: true },
  name:          { type: String, required: true },
  /** Device family — vendor/product category (e.g. "Senao AP", "UBR Radio") */
  deviceFamily:  { type: String, default: '' },
  description:   { type: String, default: '' },
  /** draft = work in progress; ready = at least one section saved, MIB upload enabled */
  status:        { type: String, enum: ['draft', 'ready'], default: 'draft' },
  /** When true, no labels or sections can be moved/resized (whole layout lock) */
  locked:        { type: Boolean, default: false },
  gridSize:      { type: Number, default: 40 },
  sections:      { type: [SectionSchema], default: [] },
  /** Set after the admin clicks "Open in MIB Builder" and saves a UiDescriptor */
  linkedDescriptorId: { type: String, default: null },
  /** Copied from which design (audit trail) */
  copiedFromId:  { type: String, default: null },
  createdBy:     { type: String, default: null },
  updatedBy:     { type: String, default: null },
  createdAt:     { type: Date, default: Date.now },
  updatedAt:     { type: Date, default: Date.now },
}, { collection: 'node_view_designs' });

NodeViewDesignSchema.pre('save', function (next) {
  this.updatedAt = new Date();
  // Auto-promote to "ready" when at least one section exists
  if (this.sections.length > 0 && this.status === 'draft') {
    this.status = 'ready';
  } else if (this.sections.length === 0) {
    this.status = 'draft';
  }
  next();
});

module.exports = mongoose.model('NodeViewDesign', NodeViewDesignSchema);
