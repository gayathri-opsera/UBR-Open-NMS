'use strict';

/**
 * definitionParser.js
 * ===================
 * Converts raw XML / XLS / JSON product-definition uploads into a normalised
 * internal structure that the wireframe builder and MongoDB registry can use
 * directly — bypassing the Java service for non-NMS formats.
 *
 * Supported inputs
 * ────────────────
 * 1. NMS XML  – has xmlns="urn:nms:productdef:1.0"       → pass-through flag
 * 2. Raw XML  – flat <Section><SubSection><parameter>…    → parsed here
 * 3. XLS/XLSX – spreadsheet with columns: group, id, …   → parsed here
 * 4. JSON     – {groups:[{id,parameters:[…]}]} or flat    → parsed here
 *
 * Output shape (ParsedDefinition)
 * ────────────────────────────────
 * {
 *   isNmsFormat: boolean,     // true → gateway should proxy to Java unchanged
 *   id:          string,      // slug for productDefinitionId
 *   vendor:      string,
 *   model:       string,
 *   description: string,
 *   groups: [{
 *     groupId:      string,
 *     label:        string,
 *     displayOrder: number,
 *     parameters: [{
 *       parameterId:   string,
 *       displayName:   string,
 *       groupId:       string,
 *       subGroup:      string | null,
 *       dataType:      string,
 *       snmpOid:       string | null,
 *       uiWidget:      string | null,
 *       readOnly:      boolean,
 *       defaultValue:  string | null,
 *       enumValues:    string[],
 *       minValue:      number | null,
 *       maxValue:      number | null,
 *       displayOrder:  number,
 *     }]
 *   }]
 * }
 */

// Lazy-load optional packages so the module doesn't crash on startup when the
// packages haven't been installed yet in the container.
function getXMLParser() {
  try { const { XMLParser } = require('fast-xml-parser'); return XMLParser; }
  catch { throw new Error('fast-xml-parser is not installed. Run: npm install fast-xml-parser --save inside the container.'); }
}
function getXLSX() {
  try { return require('xlsx'); }
  catch { throw new Error('xlsx is not installed. Run: npm install xlsx --save inside the container.'); }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function slugify(str = '') {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'unknown';
}

function extractOid(raw = '') {
  const s = String(raw).trim();
  // strip leading dot → canonical form without leading dot for storage,
  // but keep the pattern: digits separated by dots
  return s.replace(/^\.+/, '').replace(/\.+$/, '') || null;
}

function normaliseDataType(raw = '') {
  const map = {
    string: 'STRING', str: 'STRING',
    uint: 'INTEGER', int: 'INTEGER', integer: 'INTEGER',
    boolean: 'BOOLEAN', bool: 'BOOLEAN',
    enum: 'ENUM',
    ipv4: 'IPADDRESS', ipv6: 'IPADDRESS', ipaddress: 'IPADDRESS',
    gauge: 'GAUGE', counter: 'COUNTER',
    timeticks: 'TIMETICKS', oid: 'OID',
  };
  const k = String(raw || 'STRING').toLowerCase().trim();
  return map[k] || 'STRING';
}

// ── Format detection ──────────────────────────────────────────────────────────

/**
 * Returns 'NMS_XML' | 'RAW_XML' | 'XLS' | 'JSON'
 */
function detectFormat(filename = '', buf) {
  const lc = filename.toLowerCase();
  if (lc.endsWith('.xlsx') || lc.endsWith('.xls')) return 'XLS';
  if (lc.endsWith('.json')) return 'JSON';

  if (lc.endsWith('.xml') || !lc.includes('.')) {
    const head = buf.slice(0, 2000).toString('utf8');
    if (head.includes('urn:nms:productdef')) return 'NMS_XML';
    if (head.includes('<parameter') || head.includes('<Parameter')) return 'RAW_XML';
    return 'NMS_XML'; // assume NMS for unknown XML
  }
  // Try to detect from content
  const head = buf.slice(0, 4);
  if (head[0] === 0x50 && head[1] === 0x4B) return 'XLS'; // PK magic = zip = xlsx
  if (buf.slice(0, 1).toString() === '{' || buf.slice(0, 1).toString() === '[') return 'JSON';
  if (buf.slice(0, 5).toString().includes('<?xml') || buf.slice(0, 1).toString() === '<') return 'RAW_XML';
  return 'RAW_XML';
}

// ── Raw XML parser ────────────────────────────────────────────────────────────

/**
 * Parses the raw <Section><SubSection><parameter> format.
 * Top-level elements → groups
 * Second-level elements → sub-groups
 * <parameter> elements → parameters
 */
function parseRawXml(buf, filename = '') {
  const xmlStr = buf.toString('utf8');

  const XMLParser = getXMLParser();
  const parser = new XMLParser({
    ignoreAttributes:    false,
    attributeNamePrefix: '@_',
    isArray: (name) => ['parameter', 'choice'].includes(name),
    allowBooleanAttributes: true,
  });

  const root = parser.parse(xmlStr);

  // Derive ID from filename or first top-level element
  const topKeys = Object.keys(root).filter((k) => !k.startsWith('?'));
  const baseName = filename.replace(/\.[^.]+$/, '') || topKeys[0] || 'unknown';
  const id = slugify(baseName);

  const groups = [];
  let groupOrder = 0;

  for (const groupKey of topKeys) {
    groupOrder++;
    const groupNode = root[groupKey];
    if (!groupNode || typeof groupNode !== 'object') continue;

    // Collect direct parameters (no sub-group) + sub-group sections
    const subKeys = Object.keys(groupNode).filter((k) => !k.startsWith('@_'));
    const hasDirectParams = subKeys.includes('parameter');

    const groupId    = slugify(groupKey);
    const groupLabel = groupKey.charAt(0).toUpperCase() + groupKey.slice(1);
    const params     = [];
    let   paramOrder = 0;

    if (hasDirectParams) {
      // Direct parameters at group level (no sub-group)
      const rawParams = Array.isArray(groupNode.parameter)
        ? groupNode.parameter : [groupNode.parameter];
      for (const p of rawParams) {
        if (!p) continue;
        paramOrder++;
        params.push(buildParam(p, groupId, null, paramOrder));
      }
    }

    // Sub-group sections (second-level elements that contain parameters)
    for (const subKey of subKeys) {
      if (subKey === 'parameter') continue; // already handled
      const subNode = groupNode[subKey];
      if (!subNode || typeof subNode !== 'object') continue;

      // Resolve sub-group label (may have a `label` attribute)
      const subGroupLabel = (subNode['@_label'] || subKey);
      const subGroupId    = slugify(subKey);

      const rawParams = Array.isArray(subNode.parameter)
        ? subNode.parameter : (subNode.parameter ? [subNode.parameter] : []);
      for (const p of rawParams) {
        if (!p) continue;
        paramOrder++;
        params.push(buildParam(p, groupId, subGroupId, paramOrder, subGroupLabel));
      }
    }

    if (params.length > 0) {
      groups.push({ groupId, label: groupLabel, displayOrder: groupOrder, parameters: params });
    }
  }

  return {
    isNmsFormat: false,
    id,
    vendor:      deriveVendor(id, xmlStr),
    model:       deriveModel(id, xmlStr),
    description: `Imported from ${filename || 'raw XML'}`,
    groups,
  };
}

function buildParam(p, groupId, subGroup, displayOrder, subGroupLabel = null) {
  const id          = p['@_id'] || slugify(p['@_name'] || `param_${displayOrder}`);
  const displayName = p['@_name'] || id;

  // enumValues: <enumValues><choice>X</choice>...</enumValues>
  let enumValues = [];
  if (p.enumValues && p.enumValues.choice) {
    const raw = Array.isArray(p.enumValues.choice) ? p.enumValues.choice : [p.enumValues.choice];
    enumValues = raw.map((c) => String(c).trim()).filter(Boolean);
  }

  return {
    parameterId:  id,
    displayName,
    groupId,
    subGroup:     subGroup || null,
    subGroupLabel: subGroupLabel || null,
    dataType:     normaliseDataType(p.dataType),
    snmpOid:      extractOid(p.oid),
    uiWidget:     p.uiWidget || null,
    readOnly:     String(p.readOnly).toLowerCase() === 'true',
    defaultValue: p.default != null ? String(p.default) : null,
    enumValues,
    minValue:     p.min != null ? Number(p.min) : null,
    maxValue:     p.max != null ? Number(p.max) : null,
    displayOrder,
  };
}

function deriveVendor(id, xmlStr) {
  // Try OID-based vendor heuristics
  if (xmlStr.includes('1.3.6.1.4.1.52619')) return 'EOC';
  if (xmlStr.includes('1.3.6.1.4.1.2636'))  return 'Juniper';
  if (xmlStr.includes('1.3.6.1.4.1.9.'))    return 'Cisco';
  if (xmlStr.includes('1.3.6.1.4.1.14988')) return 'MikroTik';
  return 'Unknown';
}

function deriveModel(id, xmlStr) {
  // Try to extract from file basename
  const cleaned = id.replace(/_/g, ' ').replace(/-/g, ' ');
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

// ── XLS / XLSX parser ─────────────────────────────────────────────────────────

/**
 * Expected column headers (case-insensitive):
 *   group | subgroup | id | name/displayName | dataType | oid | widget | readOnly
 *   | default | enumValues | min | max
 *
 * First row = headers. Each subsequent row = one parameter.
 */
function parseXls(buf, filename = '') {
  const XLSX     = getXLSX();
  const workbook = XLSX.read(buf, { type: 'buffer' });
  const sheet    = workbook.Sheets[workbook.SheetNames[0]];
  const rows     = XLSX.utils.sheet_to_json(sheet, { defval: '' });

  const baseName = filename.replace(/\.[^.]+$/, '') || 'imported';
  const id       = slugify(baseName);

  // ── Extract vendor / model from spreadsheet metadata rows ──────────────────
  // Some spreadsheets (especially operator-built EOC XLS files) include one or more
  // metadata rows above the parameter data where the first column contains a label
  // like "Vendor", "Manufacturer", or "Model" and the second column has the value.
  // We scan the first 10 rows (before dropping into parameter parsing) to collect them.
  let xlsVendor = '';
  let xlsModel  = '';
  for (const row of rows.slice(0, 10)) {
    const vals = Object.values(row).map((v) => String(v || '').trim());
    const key  = vals[0].toLowerCase();
    const val  = vals[1] || vals[2] || '';
    if (!val) continue;
    if (/^vendor$|^manufacturer$|^make$/.test(key))   xlsVendor = val;
    if (/^model$|^model.?name$|^product.?model$/.test(key)) xlsModel  = val;
  }

  // Normalise header keys
  function col(row, ...candidates) {
    for (const k of Object.keys(row)) {
      if (candidates.some((c) => k.toLowerCase().includes(c.toLowerCase()))) return String(row[k] || '').trim();
    }
    return '';
  }

  const groupMap = new Map();
  let paramOrder = 0;

  for (const row of rows) {
    const groupId    = slugify(col(row, 'group') || 'general');
    const subGroupId = col(row, 'subgroup', 'sub_group', 'sub-group') || null;
    const paramId    = col(row, 'id', 'parameterid') || slugify(col(row, 'name', 'displayname', 'parameter'));
    if (!paramId) continue;
    paramOrder++;

    const enumRaw    = col(row, 'enum', 'choices', 'values');
    const enumValues = enumRaw ? enumRaw.split(/[,;|]/).map((s) => s.trim()).filter(Boolean) : [];

    const param = {
      parameterId:  paramId,
      displayName:  col(row, 'name', 'displayname', 'label') || paramId,
      groupId,
      subGroup:     subGroupId ? slugify(subGroupId) : null,
      dataType:     normaliseDataType(col(row, 'datatype', 'type')),
      snmpOid:      extractOid(col(row, 'oid', 'snmp')),
      uiWidget:     col(row, 'widget', 'uiwidget') || null,
      readOnly:     ['true', 'yes', '1', 'ro', 'read-only'].includes(col(row, 'readonly', 'read_only', 'access').toLowerCase()),
      defaultValue: col(row, 'default') || null,
      enumValues,
      minValue:     col(row, 'min') !== '' ? Number(col(row, 'min')) : null,
      maxValue:     col(row, 'max') !== '' ? Number(col(row, 'max')) : null,
      displayOrder: paramOrder,
    };

    if (!groupMap.has(groupId)) {
      groupMap.set(groupId, {
        groupId,
        label:        col(row, 'grouplabel', 'group_label') || groupId.charAt(0).toUpperCase() + groupId.slice(1).replace(/_/g, ' '),
        displayOrder: groupMap.size + 1,
        parameters:   [],
      });
    }
    groupMap.get(groupId).parameters.push(param);
  }

  return {
    isNmsFormat: false,
    id,
    vendor:      xlsVendor || 'Unknown',
    model:       xlsModel  || baseName.replace(/[-_]/g, ' '),
    description: `Imported from ${filename}`,
    groups:      [...groupMap.values()],
  };
}

// ── JSON parser ───────────────────────────────────────────────────────────────

/**
 * Accepts two JSON shapes:
 *
 * Shape A (grouped):
 *   { id?, vendor?, model?, groups: [{ id/groupId, label?, parameters: [{id, name, oid, ...}] }] }
 *
 * Shape B (flat parameter list):
 *   [ { group, subgroup, id, name, oid, dataType, ... }, ... ]
 *   OR { parameters: [...] }
 */
function parseJson(buf, filename = '') {
  const obj = JSON.parse(buf.toString('utf8'));
  const baseName = filename.replace(/\.[^.]+$/, '') || 'imported';

  // ── Shape C: NMS productdef JSON schema (productDefinition.identity + productDefinition.parameters)
  // e.g. { "$schema": "urn:nms:productdef:json:1.0", "productDefinition": { "identity": {...}, "parameters": [{groupName, parameters}] } }
  if (obj?.productDefinition) {
    const pd      = obj.productDefinition;
    const identity = pd.identity || {};
    const id       = slugify(identity.name || identity.model || baseName);
    const groupsRaw = Array.isArray(pd.parameters) ? pd.parameters : [];
    const groups = groupsRaw.map((g, gi) => {
      const groupId = slugify(g.groupName || g.id || g.groupId || `group_${gi}`);
      const params  = (g.parameters || []).map((p, pi) => {
        const oid = p.snmpMapping?.oid || p.snmpOid || p.oid || null;
        return {
          parameterId:  p.id || p.parameterId || slugify(p.displayName || p.name || `param_${pi}`),
          displayName:  p.displayName || p.name || p.id || `Parameter ${pi + 1}`,
          groupId,
          subGroup:     p.subGroup ? slugify(p.subGroup) : null,
          dataType:     normaliseDataType(p.dataType || p.type),
          snmpOid:      extractOid(oid),
          uiWidget:     p.uiWidget || p.widget || null,
          readOnly:     !!p.readOnly || !!p.read_only,
          defaultValue: p.defaultValue ?? p.default ?? null,
          enumValues:   Array.isArray(p.enumValues) ? p.enumValues : [],
          minValue:     p.minValue ?? p.min ?? null,
          maxValue:     p.maxValue ?? p.max ?? null,
          displayOrder: p.displayOrder ?? pi + 1,
        };
      });
      return { groupId, label: g.label || g.groupName || groupId, displayOrder: g.displayOrder ?? gi + 1, parameters: params };
    });
    return {
      isNmsFormat: false,
      id,
      vendor:      identity.vendor || obj.vendor || 'Unknown',
      model:       identity.model  || obj.model  || baseName,
      description: identity.name   || obj.description || `Imported from ${filename}`,
      fingerprints: Array.isArray(pd.fingerprints) ? pd.fingerprints : [],
      groups,
    };
  }

  // ── Shape A: has `groups` or `parameterGroups` key ───────────────────────
  const groupsArr = Array.isArray(obj?.groups) ? obj.groups
    : Array.isArray(obj?.parameterGroups) ? obj.parameterGroups
    : null;
  if (obj && !Array.isArray(obj) && groupsArr) {
    const id = slugify(obj.id || obj.productDefinitionId || baseName);
    const groups = groupsArr.map((g, gi) => {
      // Support: g.id / g.groupId / g.group (Configurations_GUI.json uses 'group')
      const groupId = slugify(g.id || g.groupId || g.group || `group_${gi}`);
      const params  = (g.parameters || g.params || []).map((p, pi) => ({
        parameterId:  p.id || p.parameterId || slugify(p.name || p.displayName || `param_${pi}`),
        displayName:  p.name || p.displayName || p.id || `Parameter ${pi + 1}`,
        groupId,
        subGroup:     p.subGroup ? slugify(p.subGroup) : null,
        dataType:     normaliseDataType(p.dataType || p.type),
        snmpOid:      extractOid(p.snmpOid || p.oid),
        uiWidget:     p.uiWidget || p.widget || null,
        readOnly:     !!p.readOnly || !!p.read_only,
        defaultValue: p.defaultValue ?? p.default ?? null,
        enumValues:   Array.isArray(p.enumValues) ? p.enumValues : [],
        minValue:     p.minValue ?? p.min ?? null,
        maxValue:     p.maxValue ?? p.max ?? null,
        displayOrder: p.displayOrder ?? pi + 1,
      }));
      return {
        groupId,
        label:        g.label || g.name || groupId,
        displayOrder: g.displayOrder ?? gi + 1,
        parameters:   params,
      };
    });
    return {
      isNmsFormat: false,
      id,
      vendor:      obj.vendor || 'Unknown',
      model:       obj.model  || baseName,
      description: obj.description || `Imported from ${filename}`,
      groups,
    };
  }

  // ── Shape B: flat array or {parameters:[...]} ─────────────────────────────
  const rows = Array.isArray(obj) ? obj : (obj.parameters || []);
  const id   = slugify(obj.id || obj.productDefinitionId || baseName);
  const groupMap = new Map();
  let pi = 0;

  for (const row of rows) {
    const groupId = slugify(row.group || row.groupId || 'general');
    if (!groupMap.has(groupId)) {
      groupMap.set(groupId, {
        groupId,
        label:        row.groupLabel || groupId,
        displayOrder: groupMap.size + 1,
        parameters:   [],
      });
    }
    pi++;
    groupMap.get(groupId).parameters.push({
      parameterId:  row.id || row.parameterId || slugify(row.name || `param_${pi}`),
      displayName:  row.name || row.displayName || row.id || `Parameter ${pi}`,
      groupId,
      subGroup:     row.subGroup ? slugify(row.subGroup) : null,
      dataType:     normaliseDataType(row.dataType),
      snmpOid:      extractOid(row.snmpOid || row.oid),
      uiWidget:     row.uiWidget || null,
      readOnly:     !!row.readOnly,
      defaultValue: row.defaultValue ?? null,
      enumValues:   Array.isArray(row.enumValues) ? row.enumValues : [],
      minValue:     row.minValue ?? null,
      maxValue:     row.maxValue ?? null,
      displayOrder: pi,
    });
  }

  return {
    isNmsFormat: false,
    id,
    vendor:      obj.vendor || 'Unknown',
    model:       obj.model  || baseName,
    description: obj.description || `Imported from ${filename}`,
    groups:      [...groupMap.values()],
  };
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Parse a file buffer into a normalised ParsedDefinition.
 * Returns { isNmsFormat: true } for NMS XML — caller should proxy to Java.
 */
function parseDefinitionFile(buf, filename = '') {
  const fmt = detectFormat(filename, buf);

  if (fmt === 'NMS_XML') {
    return { isNmsFormat: true };
  }
  if (fmt === 'RAW_XML') {
    return parseRawXml(buf, filename);
  }
  if (fmt === 'XLS') {
    return parseXls(buf, filename);
  }
  if (fmt === 'JSON') {
    return parseJson(buf, filename);
  }
  return { isNmsFormat: true }; // unknown → let Java handle it
}

module.exports = { parseDefinitionFile, detectFormat, parseRawXml, parseXls, parseJson };
