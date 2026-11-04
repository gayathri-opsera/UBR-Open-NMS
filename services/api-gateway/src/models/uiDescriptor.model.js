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
  order:         Number,
});

const SectionSchema = new mongoose.Schema({
  sectionId:     String,
  title:         String,
  columns:       { type: Number, default: 2, enum: [1, 2] },  // 1 or 2 column layout
  fullWidth:     { type: Boolean, default: false },  // true for table blocks
  pollInterval:  { type: Number, default: 30 },
  writeMode:     { type: String, enum: ['apply-button', 'direct', 'read-only'], default: 'read-only' },
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
