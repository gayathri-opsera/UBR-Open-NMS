'use strict';
const mongoose = require('mongoose');

// Schema for a single field binding in the builder
const FieldSchema = new mongoose.Schema({
  fieldId:       String,  // unique within section
  elementType:   { type: String, enum: ['heading', 'sub-heading', 'field-label', 'table-block', 'divider'] },
  label:         String,
  labelLevel:    { type: String, enum: ['heading', 'sub-heading', 'field'] },
  // MIB binding
  mibObject:     String,   // object name e.g. 'radioTxPower'
  oid:           String,   // e.g. '.1.3.6.1.4.1.14125.1.1.2.0'
  syntax:        String,   // e.g. 'Integer32 (0..30)'
  units:         String,
  access:        { type: String, enum: ['read-only', 'read-write', 'not-accessible', null] },
  // Widget config
  widget:        String,   // 'slider', 'toggle', 'gauge', 'dropdown', 'text', 'status-badge', 'rate-chart', 'duration', 'data-table'
  minValue:      Number,
  maxValue:      Number,
  pollInterval:  { type: Number, default: 30 },
  writeMode:     { type: String, enum: ['apply-button', 'direct', null] },
  helpText:      String,
  confirmWrite:  { type: Boolean, default: false },
  enumMap:       mongoose.Schema.Types.Mixed,  // { '1': 'up', '2': 'down' }
  /** Where the value comes from: 'mib' (oid, default) | 'static' (staticValue) | 'calc' (calc). */
  valueSource:   { type: String, enum: ['mib', 'static', 'calc', null] },
  staticValue:   String,
  /** { expr, format, decimals, inputs: [{ name, oid, sample }] } — see live/calcExpr.js */
  calc:          mongoose.Schema.Types.Mixed,
  /** How the label was chosen: 'custom' | 'mibName' | 'mibDescription' (the label text itself is always stored). */
  labelSource:   String,
  /** Values that mean "no value" for this field (default: -1, -NA-, NA, -) — shown as an empty value. [] = show them as they are. */
  emptyValues:   { type: [String], default: undefined },
  order:         Number,
});

const SectionSchema = new mongoose.Schema({
  sectionId:     String,
  title:         String,
  columns:       { type: Number, default: 2, enum: [1, 2] },  // 1 or 2 column layout
  fullWidth:     { type: Boolean, default: false },  // true for table blocks
  pollInterval:  { type: Number, default: 30 },
  /** Real-time refresh of this section in Node View, in seconds (0 = off). Read-only sections only. */
  liveRefreshSeconds: { type: Number, default: 0 },
  writeMode:     { type: String, enum: ['apply-button', 'direct', 'read-only'], default: 'read-only' },
  /** Optional Node View tree position (sidebar Page / Parent / Tab). Empty = legacy flat layout (screen name / section title). */
  uiPage:        String,
  uiParent:      String,
  uiTab:         String,
  /** Device-style view (Builder v2): page heading, note under the form, and how the section is drawn. */
  uiTitle:       String,
  uiNote:        String,
  uiLayout:      { type: String, enum: ['form', 'card', 'table', 'matrix', null] },
  /** Summary cards only: pin the card to the left or right column (empty = flow). */
  uiColumn:      { type: String, enum: ['left', 'right', null] },
  /** Skip this section (and an emptied tab / menu item) in Node View when the device returns no data for it. */
  uiHideWhenEmpty: Boolean,
  /** 'matrix' layout: { columns: [{ index, label }], hideEmptyColumns } — one column per table row (radio), rows = the section's fields. */
  uiMatrix:      mongoose.Schema.Types.Mixed,
  fields:        [FieldSchema],
  order:         Number,
});

const UiDescriptorSchema = new mongoose.Schema({
  descriptorId:         { type: String, unique: true },
  nodeViewId:           String,
  screenName:           { type: String, required: true },
  deviceProfile:        String,  // e.g. '[Vendor] - [Product family]'
  productDefinitionId:  String,  // linked after publish
  vendor:               String,
  productFamily:        String,
  mibModule:            String,  // e.g. 'SAMPLE-RADIO-MIB'
  status:               { type: String, enum: ['draft', 'published'], default: 'draft' },
  sections:             [SectionSchema],
  /** Device-style header for Builder v2 (product name, version line, uptime, radio badges). Optional. */
  deviceUi:             mongoose.Schema.Types.Mixed,
  /** 'device' = Builder v2 screen: Node View renders it in the device's own look. Absent/'classic' = the original card layout. */
  layoutMode:           { type: String, enum: ['classic', 'device', null] },
  /** Screen-wide default poll interval (seconds) given to new sections; each section can override it. */
  defaultPollInterval:  Number,
  generatedXml:         String,  // cached XML output
  /** Full MibObjectSummary array for ALL objects selected in Stage 1.
   *  Stored so any admin can restore the session without re-uploading the MIB. */
  selectedObjects:      { type: [mongoose.Schema.Types.Mixed], default: [] },
  createdBy:            String,
  updatedBy:            String,
  createdAt:            { type: Date, default: Date.now },
  updatedAt:            { type: Date, default: Date.now },
}, { collection: 'ui_descriptor_drafts' });

UiDescriptorSchema.pre('save', function preSave(next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model('UiDescriptor', UiDescriptorSchema);
