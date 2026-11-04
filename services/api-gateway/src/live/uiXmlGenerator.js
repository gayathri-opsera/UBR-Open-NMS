'use strict';

function escapeXmlAttr(value) {
  if (value == null) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function slugScreenId(screenName) {
  return (screenName || 'screen')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '') || 'screen';
}

function writeModeAttr(sectionWriteMode) {
  if (sectionWriteMode === 'apply-button') return 'apply';
  if (sectionWriteMode === 'direct') return 'direct';
  return null;
}

function formatPollSeconds(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return '30s';
  return `${Math.round(n)}s`;
}

function fieldAttrs(field) {
  const parts = [];
  if (field.label) parts.push(`label="${escapeXmlAttr(field.label)}"`);
  if (field.mibObject) parts.push(`object="${escapeXmlAttr(field.mibObject)}"`);
  if (field.oid) parts.push(`oid="${escapeXmlAttr(field.oid)}"`);
  if (field.widget) parts.push(`widget="${escapeXmlAttr(field.widget)}"`);
  if (field.minValue != null) parts.push(`min="${escapeXmlAttr(field.minValue)}"`);
  if (field.maxValue != null) parts.push(`max="${escapeXmlAttr(field.maxValue)}"`);
  if (field.units) parts.push(`units="${escapeXmlAttr(field.units)}"`);
  if (field.confirmWrite) parts.push('confirm="true"');
  return parts.join(' ');
}

/**
 * Build XML screen descriptor from a persisted UI builder document.
 *
 * @param {object} descriptor  UiDescriptor plain object (sections + metadata)
 * @returns {string}
 */
function generateUiXml(descriptor) {
  const screenId = slugScreenId(descriptor.screenName);
  const mib = escapeXmlAttr(descriptor.mibModule || 'UNKNOWN-MIB');
  const lines = [`<screen id="${screenId}" mib="${mib}">`];

  const sections = [...(descriptor.sections || [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const allFields = sections.flatMap((s) => s.fields || []);
  const screenHeading = allFields.find((f) => f.elementType === 'heading');
  const headingText = screenHeading?.label || descriptor.screenName || 'Screen';
  lines.push(`  <heading text="${escapeXmlAttr(headingText)}"/>`);

  for (const section of sections) {
    const fields = [...(section.fields || [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const bindable = fields.filter((f) => f.elementType === 'field-label' || f.elementType === 'table-block');
    if (bindable.length === 0 && !section.title) continue;

    const hasTable = bindable.some((f) => f.elementType === 'table-block') || section.fullWidth;
    const columnsAttr = hasTable ? 'full' : String(section.columns === 1 ? 1 : 2);

    const sectionParts = [`text="${escapeXmlAttr(section.title || 'Section')}"`, `columns="${columnsAttr}"`];
    sectionParts.push(`poll="${formatPollSeconds(section.pollInterval)}"`);
    const write = writeModeAttr(section.writeMode);
    if (write) sectionParts.push(`write="${write}"`);

    lines.push(`  <section ${sectionParts.join(' ')}>`);

    for (const field of fields) {
      if (field.elementType === 'sub-heading' && field.label) {
        lines.push(`    <subheading text="${escapeXmlAttr(field.label)}"/>`);
      }
    }

    for (const field of bindable) {
      if (field.elementType === 'table-block') {
        const tableParts = [];
        if (field.mibObject) tableParts.push(`object="${escapeXmlAttr(field.mibObject)}"`);
        tableParts.push('widget="grid"');
        tableParts.push('walk="bulk"');
        const cols = Array.isArray(field.enumMap?.columns)
          ? field.enumMap.columns.join(',')
          : (typeof field.enumMap?.columns === 'string' ? field.enumMap.columns : 'auto');
        tableParts.push(`columns="${escapeXmlAttr(cols || 'auto')}"`);
        if (field.oid) tableParts.push(`oid="${escapeXmlAttr(field.oid)}"`);
        lines.push(`    <table ${tableParts.join(' ')}/>`);
        continue;
      }

      const attrs = fieldAttrs(field);
      if (attrs) lines.push(`    <field ${attrs}/>`);
    }

    lines.push('  </section>');
  }

  lines.push('</screen>');
  return `${lines.join('\n')}\n`;
}

module.exports = { generateUiXml, escapeXmlAttr, slugScreenId };
