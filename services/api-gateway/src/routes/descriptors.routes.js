'use strict';

/**
 * Descriptor Registry Routes  —  /api/descriptors
 * ================================================
 * Implements the full Device Descriptor lifecycle from the Unified NMS Architecture PPT
 * (Slides 3, 9) and the PDL requirements.
 *
 * Lifecycle state machine:
 *   Draft → Validating → Valid/Invalid → Approved → Active → Deprecated → Retired → Purged
 *
 * API surface:
 *   GET    /api/descriptors                                    list all products + active version
 *   POST   /api/descriptors                                    upload new Draft
 *   GET    /api/descriptors/:id/versions                       list all versions
 *   GET    /api/descriptors/:id/versions/:v                    get one version
 *   GET    /api/descriptors/:id/versions/:v/dependents         dependency counts + paged records
 *   GET    /api/descriptors/:id/versions/:v/impact             impact report (PDL-066)
 *   POST   /api/descriptors/:id/versions/:v/validate           trigger lint (Draft→Valid/Invalid)
 *   POST   /api/descriptors/:id/versions/:v/approve            approve (Valid→Approved) — maker-checker
 *   POST   /api/descriptors/:id/versions/:v/activate           activate (Approved→Active)
 *   POST   /api/descriptors/:id/versions/:v/deprecate          Active→Deprecated
 *   POST   /api/descriptors/:id/versions/:v/retire             Deprecated→Retired (delete guard)
 *   POST   /api/descriptors/:id/versions/:v/purge              Retired→Purged (retention check)
 *   DELETE /api/descriptors/:id/versions/:v                    delete Draft/Invalid only
 *   POST   /api/devices/deprovision                            bulk deprovision by filter
 *   POST   /api/descriptors/:id/versions/:v/migrate            bulk migrate to target version
 */

const express    = require('express');
const { v4: uuidv4 } = require('uuid');
const multer     = require('multer');
const crypto     = require('crypto');
const mongoose   = require('mongoose');
const logger     = require('../utils/logger');
const { requireDescriptorAction } = require('../middleware/rbac.middleware');
const { DescriptorVersion }       = require('../models/descriptorVersion.model');
const { validateDescriptor }      = require('../live/descriptorValidator');
// Note: parseDefinitionFile is NOT used here — descriptors use a distinct 6-part
// schema (urn:nms:descriptor:2.0) that is parsed by parseDescriptorFile() below.
const live                        = require('../live/liveParameters');
const { buildWireframe }          = require('../live/wireframeBuilder');
const { NodeViewWireframe, invalidateCache } = require('../models/nodeViewWireframe.model');

const router  = express.Router();
const upload  = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ── Helpers ───────────────────────────────────────────────────────────────────

function actor(req) {
  return {
    userId:   req.user?.userId || req.user?.sub || 'unknown',
    username: req.user?.username || req.user?.userId || 'unknown',
    role:     req.user?.role || 'unknown',
  };
}

function errEnvelope(code, message, extra = {}) {
  return { status: 'error', error: { code, message, ...extra } };
}

function okEnvelope(data, meta = {}) {
  return { status: 'ok', ...meta, data };
}

// ══════════════════════════════════════════════════════════════════════════════
// Configurations GUI format helpers
// Supports two equivalent representations of the same UBR device parameter sheet:
//   • XML:  <Wireless>/<Network>/<Monitor> modules with <parameter> children
//   • XLSX: tabular [#, Module, Section, Parameter, Model, Default, Possible Value, O.I.D]
// ══════════════════════════════════════════════════════════════════════════════

/** IANA enterprise number → human-readable vendor/model */
const OID_ENTERPRISE_MAP = {
  '52619': { vendor: 'UBR Networks', model: 'UBR-650' },
  '4413':  { vendor: 'Ubiquiti',     model: 'airMAX'  },
  '41112': { vendor: 'Cambium',      model: 'ePMP'    },
};

function detectEnterpriseFromText(oidText) {
  const m = (oidText || '').match(/1\.3\.6\.1\.4\.1\.(\d+)/);
  return m ? (OID_ENTERPRISE_MAP[m[1]] || null) : null;
}

function cfgWidgetToDataType(widgetOrModel) {
  const w = (widgetOrModel || '').toLowerCase().replace(/[^a-z]/g, '');
  if (['dropdown', 'enum', 'select'].includes(w)) return 'ENUM';
  if (['integer', 'int'].includes(w))             return 'INT32';
  if (['float', 'double'].includes(w))            return 'FLOAT';
  if (['boolean', 'checkbox', 'bool'].includes(w)) return 'BOOLEAN';
  return 'STRING';
}

function cfgNormalizeWidget(widgetOrModel, isSecret) {
  if (isSecret) return 'password';
  const map = {
    dropdown: 'dropdown', select: 'dropdown', enum: 'dropdown',
    textfield: 'text', text: 'text', string: 'text',
    integer: 'number', int: 'number', number: 'number', float: 'number',
    password: 'password', secret: 'password',
    checkbox: 'checkbox', bool: 'checkbox', boolean: 'checkbox',
    textarea: 'textarea',
  };
  const w = (widgetOrModel || '').toLowerCase().replace(/[^a-z]/g, '');
  return map[w] || 'text';
}

/** True when the XML is the Configurations GUI format (multiple module roots, <parameter> + <oid>) */
function isConfigGuiXml(text) {
  return (
    (text.includes('<Wireless>') || text.includes('<Network>') || text.includes('<Monitor>')) &&
    text.includes('<parameter') &&
    text.includes('<oid>')
  );
}

/**
 * Parse Configurations GUI XML → array of group objects.
 * The file has multiple root elements (Wireless, Network, Monitor) which is technically
 * invalid XML, so we use regex rather than a DOM parser.
 */
function parseConfigGuiXml(text) {
  const MODULE_SECTION = { wireless: 'config', network: 'config', monitor: 'monitor' };
  const groups = [];

  // Match top-level module blocks
  const moduleRe = /<(Wireless|Network|Monitor)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let modM;
  while ((modM = moduleRe.exec(text)) !== null) {
    const moduleName  = modM[1];
    const moduleBody  = modM[2];
    const sectionType = MODULE_SECTION[moduleName.toLowerCase()] || 'config';

    // Match named sections inside the module (e.g. <Properties>, <DDRS>, <IPConfiguration label="…">)
    const secRe = /<([A-Z][A-Za-z0-9_]*)\b([^>]*)>([\s\S]*?)<\/\1>/g;
    let secM;
    while ((secM = secRe.exec(moduleBody)) !== null) {
      const secTag   = secM[1];
      const secAttrs = secM[2];
      const secBody  = secM[3];
      if (!secBody.includes('<parameter')) continue;

      const labelM      = secAttrs.match(/label=["']([^"']*)["']/i);
      const sectionLabel = labelM ? labelM[1] : secTag;
      const groupId     = `${moduleName.toLowerCase()}-${secTag.toLowerCase().replace(/[^a-z0-9]/g, '-')}`;

      const parameters = [];
      let order = 0;
      const paramRe = /<parameter\b([^>]*)>([\s\S]*?)<\/parameter>/gi;
      let paramM;
      while ((paramM = paramRe.exec(secBody)) !== null) {
        const pAttrs   = paramM[1];
        const pContent = paramM[2];

        const nameAttr = (pAttrs.match(/name=["']([^"']*)["']/i) || [])[1] || '';
        const idAttr   = (pAttrs.match(/id=["']([^"']*)["']/i)   || [])[1] || '';

        function pText(tag) {
          const m2 = pContent.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
          return m2 ? m2[1].trim() : '';
        }

        const oid      = pText('oid');
        const widget   = pText('uiWidget');
        const dataType = pText('dataType');
        const defVal   = pText('default');
        const readOnly = pText('readOnly') === 'true' || sectionType === 'monitor';
        const isSecret = ['password', 'secret'].includes((widget || '').toLowerCase());

        // Extract <enumValues><choice>...</choice></enumValues>
        const enumXml  = pText('enumValues');
        const enumVals = [];
        const choiceRe = /<choice[^>]*>([\s\S]*?)<\/choice>/gi;
        let cm;
        while ((cm = choiceRe.exec(enumXml)) !== null) enumVals.push(cm[1].trim());

        // If declared as enum/dropdown but no choices found, try parsing <value> field
        // e.g. <value>HT20 / HT40+ / HT80</value>  →  split on ' / ' or ','
        const resolvedWidget   = widget || dataType;
        const looksLikeEnum    = /enum|dropdown|select/i.test(resolvedWidget);
        if (looksLikeEnum && enumVals.length === 0) {
          const valueText = pText('value');
          if (valueText) {
            const sep = valueText.includes(' / ') ? ' / ' : ',';
            valueText.split(sep).map((s) => s.trim()).filter(Boolean).forEach((s) => enumVals.push(s));
          }
        }
        // If still no choices, fall back to STRING so validator doesn't reject it
        const effectiveDataType = (looksLikeEnum && enumVals.length === 0) ? 'STRING' : cfgWidgetToDataType(resolvedWidget);
        const effectiveWidget   = (looksLikeEnum && enumVals.length === 0) ? 'text'   : cfgNormalizeWidget(resolvedWidget, isSecret);

        const param = {
          parameterId:  idAttr || nameAttr.toLowerCase().replace(/[^a-z0-9]/g, '_'),
          displayName:  nameAttr || idAttr,
          groupId,
          snmpOid:      oid || null,
          dataType:     effectiveDataType,
          uiWidget:     effectiveWidget,
          readOnly,
          defaultValue: defVal || null,
          enumValues:   enumVals,
          minValue:     null, maxValue: null,
          displayOrder: order++,
          isSecret,
          units:        null,
        };
        if (sectionType === 'monitor') {
          param.pollIntervalSec = 60;
          param.normalRange     = null;
          param.section         = 'monitor';
        }
        parameters.push(param);
      }

      if (parameters.length > 0) {
        groups.push({
          groupId,
          displayName: `${moduleName} / ${sectionLabel}`,
          displayOrder: groups.length,
          parameters,
          section: sectionType,
        });
      }
    }
  }
  return groups;
}

/**
 * Parse Configurations GUI XLSX format.
 * Header: [#, Module, Section, Parameter, Model, Default, Possible Value, O.I.D]
 */
function parseConfigGuiXlsx(buffer) {
  const XLSX = require('xlsx');
  const wb   = XLSX.read(buffer, { type: 'buffer' });
  const ws   = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

  // Find header row (contains "Module")
  let headerIdx = 0;
  for (let i = 0; i < Math.min(rows.length, 5); i++) {
    if (rows[i].some((c) => String(c).toLowerCase() === 'module')) { headerIdx = i; break; }
  }
  const header = rows[headerIdx].map((c) => String(c).toLowerCase().trim());
  const ci = (name) => header.findIndex((h) => h.includes(name));

  const C_MOD  = ci('module');
  const C_SEC  = ci('section');
  const C_PARM = ci('parameter');
  const C_WGT  = ci('model');
  const C_DEF  = ci('default');
  const C_VALS = ci('possible');
  const C_OID  = ci('o.i.d') >= 0 ? ci('o.i.d') : ci('oid');

  const MODULE_SECTION = { wireless: 'config', network: 'config', monitor: 'monitor' };
  const groupMap = new Map();
  let paramOrder = 0;

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row     = rows[i];
    const modName = String(row[C_MOD]  || '').trim();
    const secName = String(row[C_SEC]  || '').trim();
    const pName   = String(row[C_PARM] || '').trim();
    if (!modName || !pName) continue;

    const widget   = String(row[C_WGT]  || '').trim();
    const defVal   = String(row[C_DEF]  || '').trim();
    const possible = String(row[C_VALS] || '').trim();
    let   oid      = String(row[C_OID]  || '').trim();
    if (oid && !oid.startsWith('.')) oid = '.' + oid;

    const secType  = MODULE_SECTION[modName.toLowerCase()] || 'config';
    const groupId  = `${modName.toLowerCase()}-${secName.toLowerCase().replace(/[^a-z0-9]/g, '-')}`;
    const isSecret  = /password|secret/i.test(widget);
    const looksEnum = /dropdown|enum|select/i.test(widget);
    const enumVals  = possible ? possible.split(',').map((s) => s.trim()).filter(Boolean) : [];
    // Fall back to STRING if declared enum but no choices available
    const xlsxDataType = (looksEnum && enumVals.length === 0) ? 'STRING' : cfgWidgetToDataType(widget);
    const xlsxWidget   = (looksEnum && enumVals.length === 0) ? 'text'   : cfgNormalizeWidget(widget, isSecret);

    const param = {
      parameterId:  pName.toLowerCase().replace(/[^a-z0-9]/g, '_'),
      displayName:  pName,
      groupId,
      snmpOid:      oid || null,
      dataType:     xlsxDataType,
      uiWidget:     xlsxWidget,
      readOnly:     secType === 'monitor',
      defaultValue: defVal || null,
      enumValues:   enumVals,
      minValue: null, maxValue: null,
      displayOrder: paramOrder++,
      isSecret,
      units: null,
    };
    if (secType === 'monitor') {
      param.pollIntervalSec = 60;
      param.normalRange     = null;
      param.section         = 'monitor';
    }

    if (!groupMap.has(groupId)) {
      groupMap.set(groupId, {
        groupId,
        displayName: `${modName} / ${secName}`,
        displayOrder: groupMap.size,
        parameters:  [],
        section:     secType,
      });
    }
    groupMap.get(groupId).parameters.push(param);
  }
  return [...groupMap.values()];
}

/** Build a canonical descriptor shape from Configurations GUI groups */
function buildConfigGuiDescriptor(groups, filename) {
  const allOids  = groups.flatMap((g) => g.parameters.map((p) => p.snmpOid || '')).join(' ');
  const ent      = detectEnterpriseFromText(allOids);
  const vendor   = ent?.vendor || 'Unknown';
  const model    = ent?.model  || filename.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9 -]/g, '').trim();

  // Auto-build matchRules from the OID enterprise prefix so the validator passes PDL-003
  const oidM      = allOids.match(/1\.3\.6\.1\.4\.1\.(\d+)/);
  const matchRules = oidM
    ? [{ priority: 1, field: 'sysObjectId', op: 'prefix', value: `.1.3.6.1.4.1.${oidM[1]}` }]
    : [];

  const configGroups  = groups.filter((g) => g.section !== 'monitor');
  const monitorGroups = groups.filter((g) => g.section === 'monitor');

  return {
    isNmsFormat:  false,
    sourceFormat: 'config-gui',
    identity: {
      vendor,
      productFamily: vendor,
      model,
      variants: [],
      firmwareRange: '–',
      matchRules,
    },
    capabilities: {
      protocols: [{ type: 'snmp', version: 'v2c', defaultPort: 161 }],
      features:  { snmp: 'true' },
      snmpMibs:  [],
    },
    config:     { groups: configGroups },
    monitor:    { groups: monitorGroups },
    alarms:     { mappings: [] },
    operations: { actions: [] },
    groups,
  };
}

/**
 * Parse uploaded file buffer into the canonical 6-part descriptor shape.
 *
 * Supports:
 *   • Configurations GUI XML  (<Wireless>/<Network>/<Monitor> modules)  ← NEW
 *   • Configurations GUI XLSX (tabular Module/Section/Parameter/OID)    ← NEW
 *   • urn:nms:descriptor:2.0 XML  (new 6-part schema)
 *   • urn:nms:productdef:1.0 XML  (old NMS format — rejected; use product-definition-service)
 *   • JSON                        ({ identity, capabilities, config, monitor, alarms, operations })
 *
 * Returns { isNmsFormat, identity, capabilities, config, monitor, alarms, operations, groups }
 */
function parseUpload(buf, filename = '') {
  const text = buf.toString('utf8');

  // ── JSON ──────────────────────────────────────────────────────────────────
  const lname = filename.toLowerCase();
  if (lname.endsWith('.json') || (text.trimStart().startsWith('{'))) {
    try {
      const obj = JSON.parse(text);
      if (obj.identity || obj.config || obj.monitor) {
        return {
          isNmsFormat: false,
          identity:     obj.identity     || { vendor: 'Unknown', model: 'Unknown', matchRules: [] },
          capabilities: obj.capabilities || { protocols: [], features: {} },
          config:       obj.config       || { groups: [] },
          monitor:      obj.monitor      || { groups: [] },
          alarms:       obj.alarms       || { mappings: [] },
          operations:   obj.operations   || { actions: [] },
          groups:       [...(obj.config?.groups || []), ...(obj.monitor?.groups || [])],
        };
      }
    } catch (_) { /* not JSON */ }
  }

  // ── Configurations GUI XLSX ────────────────────────────────────────────────
  if (lname.endsWith('.xlsx') || lname.endsWith('.xls')) {
    try {
      const groups = parseConfigGuiXlsx(buf);
      if (groups.length > 0) {
        logger.info({ msg: 'Detected Configurations GUI XLSX format', groups: groups.length });
        return buildConfigGuiDescriptor(groups, filename);
      }
    } catch (xlsxErr) {
      logger.warn({ msg: 'ConfigGui XLSX parse failed', err: xlsxErr.message });
    }
  }

  // ── XML ───────────────────────────────────────────────────────────────────
  if (!text.includes('<')) {
    return { isNmsFormat: true }; // not recognizable
  }

  // ── Configurations GUI XML ─────────────────────────────────────────────────
  if (isConfigGuiXml(text)) {
    try {
      const groups = parseConfigGuiXml(text);
      if (groups.length > 0) {
        logger.info({ msg: 'Detected Configurations GUI XML format', groups: groups.length });
        return buildConfigGuiDescriptor(groups, filename);
      }
    } catch (xmlErr) {
      logger.warn({ msg: 'ConfigGui XML parse failed', err: xmlErr.message });
    }
  }

  // Reject old NMS product-definition format
  if (text.includes('urn:nms:productdef')) {
    return { isNmsFormat: true };
  }

  // ── Parse new 6-part descriptor XML ────────────────────────────────────────
  // Strip XML comments first so comment content doesn't match element tags.
  const clean = text.replace(/<!--[\s\S]*?-->/g, '');

  // We use simple regex extraction — no external XML parser dependency needed.
  function extractText(xml, tag) {
    const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
    return m ? m[1].trim() : '';
  }
  function extractAll(xml, tag) {
    const re  = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'gi');
    const results = [];
    let m;
    while ((m = re.exec(xml)) !== null) results.push(m[1].trim());
    return results;
  }
  // Extract full match (including opening tag) to get attributes
  function extractAllFull(xml, tag) {
    const re  = new RegExp(`(<${tag}[^>]*>)[\\s\\S]*?</${tag}>`, 'gi');
    const results = [];
    let m;
    while ((m = re.exec(xml)) !== null) {
      results.push({ full: m[0], content: m[0].replace(m[1], '').replace(new RegExp(`</${tag}>$`, 'i'), '').trim(), openTag: m[1] });
    }
    return results;
  }
  function extractAttr(xml, attr) {
    const m = xml.match(new RegExp(`${attr}=["']([^"']*)["']`, 'i'));
    return m ? m[1] : '';
  }

  // ── Identity ────────────────────────────────────────────────────────────────
  const identityXml    = extractText(clean, 'identity') || clean;
  const fingerprintXmls = extractAll(clean, 'fingerprint');
  const ruleXmls        = extractAll(clean, 'rule');
  const variantValues   = extractAll(extractText(clean, 'variants'), 'variant');

  const identity = {
    vendor:        extractText(identityXml, 'vendor')        || 'Unknown',
    productFamily: extractText(identityXml, 'productFamily') || '',
    model:         extractText(identityXml, 'model')         || 'Unknown',
    variants:      variantValues,
    firmwareRange: `${extractText(identityXml, 'firmwareFrom')}–${extractText(identityXml, 'firmwareTo')}`,
    matchRules:    ruleXmls.map((r, i) => ({
      priority: parseInt(extractText(r, 'priority') || String(i + 1), 10),
      field:    extractText(r, 'field'),
      op:       extractText(r, 'op'),
      value:    extractText(r, 'value'),
    })),
  };

  // Ensure matchRules has at least one entry from fingerprints if empty
  if (identity.matchRules.length === 0 && fingerprintXmls.length > 0) {
    identity.matchRules = fingerprintXmls.map((fp, i) => ({
      priority: i + 1,
      field:    'sysObjectId',
      op:       'exact',
      value:    extractText(fp, 'sysObjectId'),
    })).filter((r) => r.value);
  }

  // ── Capabilities ────────────────────────────────────────────────────────────
  const capXml     = extractText(clean, 'capabilities') || '';
  const protoXmls  = extractAll(capXml, 'protocol');
  const featXmls   = extractAll(capXml, 'feature');
  const mibValues  = extractAll(extractText(capXml, 'snmpMibs'), 'mib');

  const capabilities = {
    protocols: protoXmls.map((p) => ({
      type:        extractText(p, 'type'),
      version:     extractText(p, 'version'),
      defaultPort: parseInt(extractText(p, 'defaultPort') || '161', 10),
    })),
    features: Object.fromEntries(
      featXmls.map((f) => [extractAttr(f, 'name') || f.split('>')[0], f.replace(/<[^>]+>/g, '').trim()]),
    ),
    snmpMibs: mibValues,
  };

  // ── Helper: parse a group element (opening tag + content) ───────────────────
  function parseGroup(groupFull, section) {
    // Extract id and displayName from the opening <group> tag
    const openTagMatch = groupFull.match(/^<group([^>]*)>/i);
    const openTag      = openTagMatch ? openTagMatch[1] : '';
    const gid          = extractAttr(`<x${openTag}>`, 'id');
    const gname        = extractAttr(`<x${openTag}>`, 'displayName') || gid;
    const gorder       = parseInt(extractAttr(`<x${openTag}>`, 'displayOrder') || '0', 10);
    const paramXmls    = extractAll(groupFull, 'parameter');

    const parameters = paramXmls.map((p) => {
      const base = {
        parameterId:   extractText(p, 'parameterId') || extractText(p, 'id'),
        displayName:   extractText(p, 'displayName') || extractText(p, 'name'),
        groupId:       gid,
        snmpOid:       extractText(p, 'snmpOid') || null,
        dataType:      (extractText(p, 'dataType') || 'STRING').toUpperCase(),
        uiWidget:      extractText(p, 'uiWidget')  || (section === 'monitor' ? 'gauge' : 'text'),
        readOnly:      extractText(p, 'readOnly') === 'true' || section === 'monitor',
        defaultValue:  extractText(p, 'defaultValue') || null,
        enumValues:    (extractText(p, 'enumValues') || '').split(',').map((s) => s.trim()).filter(Boolean),
        minValue:      extractText(p, 'minValue')  ? Number(extractText(p, 'minValue'))  : null,
        maxValue:      extractText(p, 'maxValue')  ? Number(extractText(p, 'maxValue'))  : null,
        displayOrder:  parseInt(extractText(p, 'displayOrder') || '0', 10),
        isSecret:      extractText(p, 'isSecret') === 'true',
        units:         extractText(p, 'units')     || null,
      };
      if (section === 'monitor') {
        base.pollIntervalSec = parseInt(extractText(p, 'pollIntervalSec') || '60', 10);
        base.normalRange     = extractText(p, 'normalRange') || null;
        base.section         = 'monitor';
      }
      return base;
    });

    return { groupId: gid, displayName: gname, displayOrder: gorder, parameters, section };
  }

  // ── Config groups ────────────────────────────────────────────────────────────
  const configXml = extractText(clean, 'config') || '';
  // Extract full group elements (with opening tags for attribute extraction)
  const configGroupFulls = [];
  const cgRe = /<group([^>]*)>([\s\S]*?)<\/group>/gi;
  let cgm;
  while ((cgm = cgRe.exec(configXml)) !== null) configGroupFulls.push(cgm[0]);
  const configGroups = configGroupFulls.map((g) => parseGroup(g, 'config'));

  // ── Monitor groups ───────────────────────────────────────────────────────────
  const monitorXml = extractText(clean, 'monitor') || '';
  const monGroupFulls = [];
  const mgRe = /<group([^>]*)>([\s\S]*?)<\/group>/gi;
  let mgm;
  while ((mgm = mgRe.exec(monitorXml)) !== null) monGroupFulls.push(mgm[0]);
  const monitorGroups = monGroupFulls.map((g) => parseGroup(g, 'monitor'));

  // ── Alarms ─────────────────────────────────────────────────────────────────
  const alarmsXml   = extractText(clean, 'alarms') || '';
  const mappingXmls = extractAll(alarmsXml, 'mapping');
  const alarms = {
    mappings: mappingXmls.map((m) => ({
      canonicalType:  extractText(m, 'canonicalType'),
      severity:       extractText(m, 'severity'),
      source:         extractText(m, 'source'),
      trapOid:        extractText(m, 'trapOid')         || null,
      clearTrapOid:   extractText(m, 'clearTrapOid')    || null,
      syslogPattern:  extractText(m, 'syslogPattern')   || null,
      description:    extractText(m, 'description'),
      autoAck:        extractText(m, 'autoAck') === 'true',
    })),
  };

  // ── Operations ──────────────────────────────────────────────────────────────
  const opsXml    = extractText(clean, 'operations') || '';
  const actionXmls = extractAll(opsXml, 'action');
  const operations = {
    actions: actionXmls.map((a) => ({
      id:                   extractText(a, 'id'),
      displayName:          extractText(a, 'displayName'),
      description:          extractText(a, 'description'),
      protocol:             extractText(a, 'protocol'),
      snmpSetOid:           extractText(a, 'snmpSetOid')       || null,
      snmpSetValue:         extractText(a, 'snmpSetValue')     || null,
      requiresConfirmation: extractText(a, 'requiresConfirmation') === 'true',
      requiredRole:         extractText(a, 'requiredRole')     || 'operator',
      expectedDurationSec:  parseInt(extractText(a, 'expectedDurationSec') || '30', 10),
    })),
  };

  // All groups flat (for wireframe builder)
  const allGroups = [...configGroups, ...monitorGroups];

  return {
    isNmsFormat:  false,
    identity,
    capabilities,
    config:       { groups: configGroups },
    monitor:      { groups: monitorGroups },
    alarms,
    operations,
    groups:       allGroups,
  };
}

/** Build content hash for duplicate detection (PDL-022) */
function contentHash(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** Resolve productDefinitionId from route param (already the ID) */
async function resolveVersion(id, v) {
  return DescriptorVersion.findOne({ productDefinitionId: id, version: v });
}

// ── GET /api/descriptors ──────────────────────────────────────────────────────
// Lists all distinct products with their latest active (or highest) version
router.get('/', requireDescriptorAction('read'), async (req, res) => {
  try {
    const { state, vendor } = req.query;
    const filter = {};
    if (state)  filter.state  = state;
    if (vendor) filter['identity.vendor'] = new RegExp(vendor, 'i');

    const versions = await DescriptorVersion.find(filter, {
      productDefinitionId: 1, version: 1, state: 1, 'identity.vendor': 1,
      'identity.model': 1, 'identity.variants': 1, isDefault: 1,
      'dependency.boundDevices': 1, updatedAt: 1, createdAt: 1,
    }).sort({ productDefinitionId: 1, version: -1 }).lean();

    return res.json(okEnvelope(versions, { total: versions.length }));
  } catch (err) {
    logger.error({ msg: 'descriptors.list error', err: err.message });
    return res.status(500).json(errEnvelope('INTERNAL_ERROR', err.message));
  }
});

// ── POST /api/descriptors ─────────────────────────────────────────────────────
// Upload a new Draft descriptor (XML, JSON, XLS/XLSX)
router.post('/', requireDescriptorAction('upload'), upload.single('file'), async (req, res) => {
  const correlationId = req.headers['x-correlation-id'] || uuidv4();
  try {
    if (!req.file) return res.status(400).json(errEnvelope('MISSING_FILE', 'A file must be uploaded'));

    let { productDefinitionId, version } = req.body;

    // Auto-derive productDefinitionId from file OIDs when not provided
    if (!productDefinitionId && req.file) {
      try {
        const snippet = req.file.buffer.toString('utf8', 0, Math.min(req.file.buffer.length, 8192));
        const ent = detectEnterpriseFromText(snippet);
        if (ent) {
          const vendorSlug = ent.vendor.toLowerCase().replace(/[^a-z0-9]+/g, '-');
          const modelSlug  = ent.model.toLowerCase().replace(/[^a-z0-9]+/g, '-');
          productDefinitionId = `${vendorSlug}.${modelSlug}`;
        } else {
          // Fallback: slugify filename
          productDefinitionId = (req.file.originalname || 'unknown')
            .replace(/\.[^.]+$/, '')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '');
        }
        logger.info({ msg: 'Auto-derived productDefinitionId', productDefinitionId });
      } catch (_) {
        return res.status(400).json(errEnvelope('MISSING_FIELD', 'productDefinitionId is required'));
      }
    }

    if (!productDefinitionId) return res.status(400).json(errEnvelope('MISSING_FIELD', 'productDefinitionId is required'));
    if (!version)             return res.status(400).json(errEnvelope('MISSING_FIELD', 'version is required'));

    // Semver format check
    if (!/^\d+\.\d+\.\d+$/.test(version.trim()))
      return res.status(400).json(errEnvelope('INVALID_VERSION', 'version must be semver (e.g. 1.0.0)'));

    // PDL-022: check for duplicate productDefinitionId + version
    const existing = await DescriptorVersion.findOne({ productDefinitionId, version });
    if (existing) {
      const hash = contentHash(req.file.buffer);
      if (hash === existing.contentHash) {
        // ── Same content, same version ──────────────────────────────────────
        // Behavior depends on the current lifecycle state of the existing version.
        const REACTIVATABLE = ['Deprecated', 'Retired'];
        const ALREADY_LIVE  = ['Active'];
        const IN_PROGRESS   = ['Draft', 'Invalid', 'Validating', 'Valid', 'Approved'];

        if (ALREADY_LIVE.includes(existing.state)) {
          // Descriptor is already Active — nothing to do
          return res.status(409).json(errEnvelope('ALREADY_ACTIVE',
            `${productDefinitionId} v${version} is already Active. No upload needed.`,
            { productDefinitionId, version, state: existing.state }));
        }

        if (IN_PROGRESS.includes(existing.state)) {
          // Duplicate of an in-progress version — return it so the UI can resume
          return res.json(okEnvelope(existing.toObject(), {
            note: 'DUPLICATE_IN_PROGRESS',
            message: `Identical content found as ${existing.state} version. Resume from where you left off.`,
          }));
        }

        if (REACTIVATABLE.includes(existing.state)) {
          // ── Key Fix: Deprecated/Retired + same content ──────────────────
          // Auto-create a new Draft version with a bumped patch number so the
          // user can immediately proceed through validate → approve → activate.
          const parts = version.trim().split('.').map(Number);
          parts[2] = (parts[2] || 0) + 1;
          const newVersion = parts.join('.');

          // Make sure the bumped version doesn't already exist
          let candidate = newVersion;
          let bump = parts[2];
          while (await DescriptorVersion.findOne({ productDefinitionId, version: candidate })) {
            bump++;
            candidate = `${parts[0]}.${parts[1]}.${bump}`;
          }

          const canonical = parseUpload(req.file.buffer, req.file.originalname);
          const a = actor(req);
          const newDoc = new DescriptorVersion({
            productDefinitionId,
            version:            candidate,
            identity:           canonical.identity,
            state:              'Draft',
            sourceFormat:       (req.file.originalname || '').split('.').pop().toLowerCase() || 'xml',
            sourceFilename:     req.file.originalname,
            canonicalJson:      canonical,
            contentHash:        hash,
            uploadedByUserId:   a.userId,
            uploadedByUsername: a.username,
          });
          newDoc.addLifecycleEvent('Draft', a,
            `Re-upload of ${productDefinitionId} v${version} (was ${existing.state}). New version ${candidate} created.`);
          await newDoc.save();

          logger.info({ msg: 'descriptor re-upload: new version from deprecated content',
            productDefinitionId, fromVersion: version, newVersion: candidate, correlationId });

          return res.status(201).json(okEnvelope(newDoc.toObject(), {
            note:         'DUPLICATE_REACTIVATED',
            message:      `Previous v${version} was ${existing.state}. New version v${candidate} created as Draft — validate → approve → activate to make it live.`,
            previousVersion: version,
            previousState:   existing.state,
          }));
        }

        // Purged or unknown state — allow fresh upload as a new Draft
        return res.json(okEnvelope(existing.toObject(), { note: 'Identical content; returning existing record' }));
      }

      // Same version, different content
      return res.status(409).json(errEnvelope('VERSION_EXISTS',
        `Version ${version} of ${productDefinitionId} already exists (PDL-022). Upload a new version number.`,
        { productDefinitionId, version }));
    }

    // ── Cross-version duplicate content check ─────────────────────────────────
    // If the same file was previously uploaded under a different version number,
    // detect it and inform the user which version already has this content.
    // Priority: Active > in-progress states > reactivatable — check all matches
    const hash = contentHash(req.file.buffer);
    const hashMatches = await DescriptorVersion.find({ productDefinitionId, contentHash: hash });
    if (hashMatches.length > 0) {
      const REACTIVATABLE = ['Deprecated', 'Retired'];
      const IN_PROGRESS   = ['Draft', 'Invalid', 'Validating', 'Valid', 'Approved'];
      // Active takes highest priority — block immediately
      const activeMatch = hashMatches.find(m => m.state === 'Active');
      if (activeMatch) {
        return res.status(409).json(errEnvelope('DUPLICATE_CONTENT',
          `This file content already exists as version ${activeMatch.version} (Active). No upload needed.`,
          { productDefinitionId, existingVersion: activeMatch.version, existingState: 'Active' }));
      }
      // In-progress (non-Active) — block and point user to resume
      const inProgressMatch = hashMatches.find(m => IN_PROGRESS.includes(m.state));
      if (inProgressMatch) {
        return res.status(409).json(errEnvelope('DUPLICATE_CONTENT',
          `This file content already exists as version ${inProgressMatch.version} (${inProgressMatch.state}). Use that version to continue.`,
          { productDefinitionId, existingVersion: inProgressMatch.version, existingState: inProgressMatch.state }));
      }
      // All matches are Deprecated/Retired — allow new Draft (fall through)
      const reactivatableMatch = hashMatches.find(m => REACTIVATABLE.includes(m.state));
      if (reactivatableMatch) {
        logger.info({ msg: 'descriptor upload: content matches deprecated/retired version, creating new Draft',
          productDefinitionId, matchedVersion: reactivatableMatch.version, newVersion: version });
      }
    }

    // Parse the file
    const canonical = parseUpload(req.file.buffer, req.file.originalname);
    if (canonical.isNmsFormat) {
      return res.status(422).json(errEnvelope('NMS_FORMAT_NOT_SUPPORTED',
        'NMS XML format is handled by the product-definition-service. Use the Framework Product Definitions endpoint.'));
    }

    const a = actor(req);
    const doc = new DescriptorVersion({
      productDefinitionId,
      version:            version.trim(),
      identity:           canonical.identity,
      state:              'Draft',
      sourceFormat:       (req.file.originalname || '').split('.').pop().toLowerCase() || 'xml',
      sourceFilename:     req.file.originalname,
      canonicalJson:      canonical,
      contentHash:        hash || contentHash(req.file.buffer),
      uploadedByUserId:   a.userId,
      uploadedByUsername: a.username,
    });
    doc.addLifecycleEvent('Draft', a, 'Initial upload');
    await doc.save();

    logger.info({ msg: 'descriptor uploaded', productDefinitionId, version, correlationId });
    return res.status(201).json(okEnvelope(doc.toObject()));
  } catch (err) {
    logger.error({ msg: 'descriptors.upload error', err: err.message, correlationId });
    return res.status(500).json(errEnvelope('INTERNAL_ERROR', err.message, { correlationId }));
  }
});

// ── GET /api/descriptors/:id/versions ─────────────────────────────────────────
router.get('/:id/versions', requireDescriptorAction('read'), async (req, res) => {
  try {
    const versions = await DescriptorVersion.find(
      { productDefinitionId: req.params.id },
      { canonicalJson: 0 }, // omit large blob from list
    ).sort({ createdAt: -1 }).lean();
    return res.json(okEnvelope(versions, { total: versions.length }));
  } catch (err) {
    return res.status(500).json(errEnvelope('INTERNAL_ERROR', err.message));
  }
});

// ── GET /api/descriptors/:id/versions/:v ──────────────────────────────────────
router.get('/:id/versions/:v', requireDescriptorAction('read'), async (req, res) => {
  try {
    const doc = await resolveVersion(req.params.id, req.params.v);
    if (!doc) return res.status(404).json(errEnvelope('NOT_FOUND', 'Descriptor version not found'));
    return res.json(okEnvelope(doc.toObject()));
  } catch (err) {
    return res.status(500).json(errEnvelope('INTERNAL_ERROR', err.message));
  }
});

// ── GET /api/descriptors/:id/versions/:v/dependents ───────────────────────────
// PDL-065: counts per type + first 100 blocking records
router.get('/:id/versions/:v/dependents', requireDescriptorAction('read'), async (req, res) => {
  try {
    const doc = await resolveVersion(req.params.id, req.params.v);
    if (!doc) return res.status(404).json(errEnvelope('NOT_FOUND', 'Descriptor version not found'));

    // Live device count from MongoDB
    const nmsDb = mongoose.connection.readyState === 1 ? mongoose.connection.db : null;
    let boundDevices = [];
    if (nmsDb) {
      boundDevices = await nmsDb.collection('devices')
        .find({ productDefinitionId: doc.productDefinitionId, isDeprovisioned: { $ne: true } },
              { projection: { _id: 1, serialNumber: 1, ipAddress: 1, status: 1 } })
        .limit(100).toArray();
    }

    const counts = doc.dependencySummary();
    counts.boundDevices = boundDevices.length; // live count overrides stored counter

    return res.json(okEnvelope({
      productDefinitionId: doc.productDefinitionId,
      version:             doc.version,
      state:               doc.state,
      counts,
      records: {
        boundDevices: boundDevices.map((d) => ({
          deviceId:   String(d._id),
          serialNumber: d.serialNumber || null,
          ipAddress:  d.ipAddress || null,
          status:     d.status || 'UNKNOWN',
        })),
      },
      detailsUrl: `/api/descriptors/${doc.productDefinitionId}/versions/${doc.version}/dependents`,
    }));
  } catch (err) {
    return res.status(500).json(errEnvelope('INTERNAL_ERROR', err.message));
  }
});

// ── GET /api/descriptors/:id/versions/:v/impact ───────────────────────────────
// PDL-066: impact report before retirement
router.get('/:id/versions/:v/impact', requireDescriptorAction('read'), async (req, res) => {
  try {
    const doc = await resolveVersion(req.params.id, req.params.v);
    if (!doc) return res.status(404).json(errEnvelope('NOT_FOUND', 'Descriptor version not found'));

    const nmsDb = mongoose.connection.readyState === 1 ? mongoose.connection.db : null;
    let devices = [];
    if (nmsDb) {
      devices = await nmsDb.collection('devices')
        .find({ productDefinitionId: doc.productDefinitionId, isDeprovisioned: { $ne: true } },
              { projection: { _id: 1, serialNumber: 1, ipAddress: 1, status: 1, region: 1, lastSeenAt: 1 } })
        .toArray();
    }

    const now = Date.now();
    const unreachableThresholdDays = parseInt(process.env.UNREACHABLE_FLAG_DAYS || '30', 10);
    const unreachable = devices.filter((d) => {
      if (!d.lastSeenAt) return false;
      return (now - new Date(d.lastSeenAt).getTime()) / 86_400_000 > unreachableThresholdDays;
    });

    // Group by region
    const byRegion = {};
    for (const d of devices) {
      const r = d.region || 'unknown';
      if (!byRegion[r]) byRegion[r] = { total: 0, unreachable: 0 };
      byRegion[r].total++;
      if (unreachable.find((u) => String(u._id) === String(d._id))) byRegion[r].unreachable++;
    }

    return res.json(okEnvelope({
      productDefinitionId: doc.productDefinitionId,
      version:             doc.version,
      state:               doc.state,
      summary: {
        totalBoundDevices:     devices.length,
        unreachableDevices:    unreachable.length,
        runningJobs:           doc.dependency.runningJobs || 0,
        openAlarms:            doc.dependency.openAlarms  || 0,
        configProfiles:        doc.dependency.configProfiles || 0,
      },
      devicesByRegion: byRegion,
      unreachableDevices: unreachable.slice(0, 100).map((d) => ({
        deviceId:   String(d._id),
        serialNumber: d.serialNumber || null,
        ipAddress:  d.ipAddress,
        lastSeenAt: d.lastSeenAt,
      })),
      clearingPaths: [
        { action: 'migrate',      label: 'Migrate all devices to another Active version', url: `/api/descriptors/${doc.productDefinitionId}/versions/${doc.version}/migrate` },
        { action: 'deprovision',  label: 'Deprovision all bound devices',                 url: `/api/devices/deprovision?productDefinitionId=${doc.productDefinitionId}&version=${doc.version}` },
      ],
    }));
  } catch (err) {
    return res.status(500).json(errEnvelope('INTERNAL_ERROR', err.message));
  }
});

// ── POST /api/descriptors/:id/versions/:v/validate ───────────────────────────
// Lint step: Draft → Valid or Invalid
router.post('/:id/versions/:v/validate', requireDescriptorAction('validate'), async (req, res) => {
  const correlationId = req.headers['x-correlation-id'] || uuidv4();
  try {
    const doc = await resolveVersion(req.params.id, req.params.v);
    if (!doc) return res.status(404).json(errEnvelope('NOT_FOUND', 'Descriptor version not found'));
    if (!['Draft', 'Invalid'].includes(doc.state))
      return res.status(409).json(errEnvelope('INVALID_STATE', `Validation requires state Draft or Invalid, current: ${doc.state}`));

    doc.state = 'Validating';
    await doc.save();

    const canonical = doc.canonicalJson || {};
    const { errors: rawErrors, warnings: rawWarnings, isValid } = validateDescriptor(canonical, doc.version);

    // Normalize to { field, message } objects for consistent API shape
    const toFinding = (e, defaultField = 'descriptor') => {
      if (typeof e === 'string') {
        // Extract field name from messages like "Identity.vendor is required"
        const m = e.match(/^([A-Za-z0-9_.[\]]+):/);
        return { field: m ? m[1] : defaultField, message: e };
      }
      return { field: e.field || defaultField, message: e.message || String(e) };
    };
    const errors   = rawErrors.map((e) => toFinding(e));
    const warnings = rawWarnings.map((e) => toFinding(e, 'warning'));

    doc.state              = isValid ? 'Valid' : 'Invalid';
    doc.validationErrors   = errors;
    doc.validationWarnings = warnings;
    doc.validatedAt        = new Date();
    const a = actor(req);
    doc.addLifecycleEvent(doc.state, a, `Validation ${isValid ? 'passed' : 'failed'} (${errors.length} errors, ${warnings.length} warnings)`,
      doc.dependencySummary());
    await doc.save();

    return res.json(okEnvelope({
      productDefinitionId: doc.productDefinitionId,
      version:             doc.version,
      state:               doc.state,
      isValid,
      errors,
      warnings,
      validatedAt: doc.validatedAt,
    }, { correlationId }));
  } catch (err) {
    logger.error({ msg: 'descriptors.validate error', err: err.message, correlationId });
    return res.status(500).json(errEnvelope('INTERNAL_ERROR', err.message, { correlationId }));
  }
});

// ── POST /api/descriptors/:id/versions/:v/approve ─────────────────────────────
// Valid → Approved. MUST be a different user from the uploader (PDL-110).
router.post('/:id/versions/:v/approve', requireDescriptorAction('approve'), async (req, res) => {
  const correlationId = req.headers['x-correlation-id'] || uuidv4();
  try {
    const doc = await resolveVersion(req.params.id, req.params.v);
    if (!doc) return res.status(404).json(errEnvelope('NOT_FOUND', 'Descriptor version not found'));
    if (doc.state !== 'Valid')
      return res.status(409).json(errEnvelope('INVALID_STATE', `Approval requires state Valid, current: ${doc.state}`));

    const a = actor(req);
    // Maker-checker: approver must differ from uploader (PDL-110)
    if (a.userId !== 'unknown' && doc.uploadedByUserId !== 'unknown' &&
        a.userId === doc.uploadedByUserId) {
      return res.status(403).json(errEnvelope('MAKER_CHECKER_VIOLATION',
        'The approver must be a different user from the one who uploaded this descriptor (PDL-110)',
        { uploadedBy: doc.uploadedByUsername, correlationId }));
    }

    doc.state              = 'Approved';
    doc.approvedByUserId   = a.userId;
    doc.approvedByUsername = a.username;
    doc.approvedAt         = new Date();
    doc.addLifecycleEvent('Approved', a, req.body?.reason || 'Approved for activation', doc.dependencySummary());
    await doc.save();

    logger.info({ msg: 'descriptor approved', productDefinitionId: doc.productDefinitionId, version: doc.version, approvedBy: a.username, correlationId });
    return res.json(okEnvelope(doc.toObject(), { correlationId }));
  } catch (err) {
    return res.status(500).json(errEnvelope('INTERNAL_ERROR', err.message, { correlationId }));
  }
});

// ── POST /api/descriptors/:id/versions/:v/activate ───────────────────────────
// Approved → Active. Also builds + persists the wireframe (PDL-025 transactional).
router.post('/:id/versions/:v/activate', requireDescriptorAction('activate'), async (req, res) => {
  const correlationId = req.headers['x-correlation-id'] || uuidv4();
  try {
    const doc = await resolveVersion(req.params.id, req.params.v);
    if (!doc) return res.status(404).json(errEnvelope('NOT_FOUND', 'Descriptor version not found'));
    if (doc.state !== 'Approved')
      return res.status(409).json(errEnvelope('INVALID_STATE', `Activation requires state Approved, current: ${doc.state}`));

    const a = actor(req);
    doc.state = 'Active';
    doc.addLifecycleEvent('Active', a, req.body?.reason || 'Activated', doc.dependencySummary());

    // Write to product_definition_active_versions so liveParameters.loadDefinition() can find it
    const PDEF_DB = process.env.PRODUCTDEF_DB_NAME || 'ubrnms_productdef';
    const db = mongoose.connection.readyState === 1
      ? mongoose.connection.client.db(PDEF_DB) : null;

    if (db) {
      const now = new Date();
      await db.collection('product_definition_active_versions').updateOne(
        { productDefinitionId: doc.productDefinitionId },
        { $set: {
          productDefinitionId: doc.productDefinitionId,
          activeVersionId:     String(doc._id),
          versionId:           String(doc._id),
          vendor:              doc.identity?.vendor || null,
          model:               doc.identity?.model  || null,
          updatedAt:           now,
        }, $setOnInsert: { createdAt: now } },
        { upsert: true },
      );

      // Write parameter_registry_entries for all config + monitor params so wireframe builder works
      const groups = [
        ...(doc.canonicalJson?.config?.groups || doc.canonicalJson?.groups || []),
        ...(doc.canonicalJson?.monitor?.groups || []),
      ];
      const entries = [];
      const versionId = String(doc._id);
      for (const g of groups) {
        for (const p of (g.parameters || [])) {
          entries.push({
            productDefinitionId: doc.productDefinitionId,
            versionId,
            parameterId:   p.parameterId || p.id,
            displayName:   p.displayName || p.label || p.name || p.parameterId || p.id,
            groupId:       p.groupId || g.groupId,
            subGroup:      p.subGroup || null,
            dataType:      p.dataType || 'STRING',
            snmpOid:       p.snmpOid ? `.${p.snmpOid.replace(/^\./, '')}` : (p.oid ? `.${p.oid.replace(/^\./, '')}` : null),
            uiWidget:      p.uiWidget || p.widget || null,
            readOnly:      !!p.readOnly,
            defaultValue:  p.defaultValue ?? null,
            enumValues:    p.enumValues || [],
            minValue:      p.minValue ?? null,
            maxValue:      p.maxValue ?? null,
            displayOrder:  p.displayOrder || 0,
            groupDisplayOrder: g.displayOrder || 0,
            createdAt:     now,
            updatedAt:     now,
          });
        }
      }
      if (entries.length > 0) {
        await db.collection('parameter_registry_entries').deleteMany({ productDefinitionId: doc.productDefinitionId });
        await db.collection('parameter_registry_entries').insertMany(entries);
      }

      // ── fingerprint_registry_entries: used by the discovery engine to auto-match
      // devices to this product definition by sysObjectId / sysDescrPattern (PDL-003)
      const matchRules = doc.identity?.matchRules || [];
      if (matchRules.length > 0) {
        const fpEntries = matchRules.map((rule) => ({
          productDefinitionId: doc.productDefinitionId,
          versionId,
          fingerprintType:     rule.field === 'sysObjectId' ? 'SNMP_OID'
                             : rule.field === 'sysDescr'    ? 'SNMP_SYSDESCR'
                             : 'CUSTOM',
          fingerprintValue:    rule.value,
          matchOp:             rule.op || 'prefix',
          priority:            rule.priority || 1,
          vendor:              doc.identity?.vendor        || null,
          model:               doc.identity?.model         || null,
          productFamily:       doc.identity?.productFamily || doc.identity?.vendor || null,
          firmwareFrom:        (doc.identity?.firmwareRange || '').split('–')[0]?.trim() || null,
          firmwareTo:          (doc.identity?.firmwareRange || '').split('–')[1]?.trim() || null,
          supportedProtocols:  (doc.capabilities?.protocols || []).map((p) =>
                                 (typeof p === 'string' ? p : p.type || 'SNMP').toUpperCase()),
          registryVersion:     { high: 0, low: 1, unsigned: false },
          createdAt:           now,
          updatedAt:           now,
        }));
        await db.collection('fingerprint_registry_entries').deleteMany({ productDefinitionId: doc.productDefinitionId });
        await db.collection('fingerprint_registry_entries').insertMany(fpEntries);
        logger.info({ msg: 'descriptor: fingerprint registry updated', productDefinitionId: doc.productDefinitionId, fingerprints: fpEntries.length });
      }

      // ── product_definition_versions: discovery + Java service reads from here ─────
      const normalizedGroups = [...(doc.canonicalJson?.config?.groups || []), ...(doc.canonicalJson?.monitor?.groups || [])]
        .map((g) => ({
          groupName:  g.groupId,
          parameters: (g.parameters || []).map((p) => ({
            id:            p.parameterId || p.id,
            displayName:   p.displayName || p.parameterId,
            dataType:      p.dataType || 'STRING',
            unit:          p.units || null,
            defaultValue:  p.defaultValue ?? null,
            minValue:      p.minValue ?? null,
            maxValue:      p.maxValue ?? null,
            enumValues:    p.enumValues?.length ? p.enumValues : null,
            snmpOid:       p.snmpOid ? `.${p.snmpOid.replace(/^\./, '')}` : null,
            cliCommand:    null, cliParseRegex: null, apiPath: null, grpcPath: null,
            uiVisibleTo:   p.readOnly ? ['ReadOnly'] : ['Operator'],
            thresholdHigh: null, thresholdLow: null,
          })),
        }));
      await db.collection('product_definition_versions').updateOne(
        { definitionId: doc.productDefinitionId },
        { $set: {
          definitionId:          doc.productDefinitionId,
          versionId,
          name:                  `${doc.identity?.vendor || ''} ${doc.identity?.model || ''}`.trim(),
          vendor:                doc.identity?.vendor || null,
          model:                 doc.identity?.model  || null,
          schemaVersion:         'urn:nms:descriptor:2.0',
          lifecycleStatus:       'ACTIVE',
          validationStatus:      'VALID',
          contentHash:           doc.contentHash || null,
          uploadedFormat:        (doc.sourceFormat || 'xml').toUpperCase(),
          actorUserId:           a.userId,
          actorUsername:         a.username,
          activatedBy:           a.username,
          activatedAt:           now,
          updatedAt:             now,
          normalizedMetadataJson: JSON.stringify({
            name:            `${doc.identity?.vendor || ''} ${doc.identity?.model || ''}`.trim(),
            vendor:          doc.identity?.vendor || null,
            model:           doc.identity?.model  || null,
            productFamily:   doc.identity?.productFamily || null,
            fingerprints:    matchRules.map((r) => ({ sysObjectId: r.value, matchOp: r.op })),
            supportedProtocols: (doc.capabilities?.protocols || []).map((p) =>
                                  (typeof p === 'string' ? p : p.type || 'SNMP').toUpperCase()),
            parameterGroups: normalizedGroups,
          }),
        }, $setOnInsert: { createdAt: now } },
        { upsert: true },
      );
    }

    await doc.save();

    // Build wireframe asynchronously (PDL-025 — best effort after save)
    const redis = req.app.get('redis');
    setImmediate(async () => {
      try {
        const definition = await live.loadDefinition(doc.productDefinitionId);
        if (definition && definition.entries?.length > 0) {
          const built = buildWireframe(definition);
          await NodeViewWireframe.updateMany(
            { productDefinitionId: doc.productDefinitionId, status: 'ACTIVE' },
            { $set: { status: 'SUPERSEDED', updatedAt: new Date() } },
          );
          await NodeViewWireframe.findOneAndUpdate(
            { productDefinitionId: doc.productDefinitionId, versionId: definition.versionId },
            { $set: { productDefinitionId: doc.productDefinitionId, versionId: definition.versionId,
                registryVersion: definition.registryVersion, status: 'ACTIVE',
                wireframe: built.wireframe, parameterCount: built.parameterCount,
                groupCount: built.groupCount, updatedAt: new Date() },
              $setOnInsert: { createdAt: new Date() } },
            { upsert: true },
          );
          await invalidateCache(redis, doc.productDefinitionId);
          logger.info({ msg: 'descriptor: wireframe built', productDefinitionId: doc.productDefinitionId, parameterCount: built.parameterCount });
        }
      } catch (e) {
        logger.warn({ msg: 'descriptor: wireframe build failed', err: e.message });
      }
    });

    logger.info({ msg: 'descriptor activated', productDefinitionId: doc.productDefinitionId, version: doc.version, correlationId });
    return res.json(okEnvelope(doc.toObject(), { correlationId }));
  } catch (err) {
    return res.status(500).json(errEnvelope('INTERNAL_ERROR', err.message, { correlationId }));
  }
});

// ── POST /api/descriptors/:id/versions/:v/deprecate ──────────────────────────
// Active → Deprecated (PDL-027): blocks new bindings but keeps existing managed
router.post('/:id/versions/:v/deprecate', requireDescriptorAction('deprecate'), async (req, res) => {
  const correlationId = req.headers['x-correlation-id'] || uuidv4();
  try {
    const doc = await resolveVersion(req.params.id, req.params.v);
    if (!doc) return res.status(404).json(errEnvelope('NOT_FOUND', 'Descriptor version not found'));
    if (doc.state !== 'Active')
      return res.status(409).json(errEnvelope('INVALID_STATE', `Deprecation requires state Active, current: ${doc.state}`));

    // PDL-063: cannot deprecate the default version unless another default is set
    if (doc.isDefault) {
      const otherDefault = await DescriptorVersion.findOne({
        productDefinitionId: doc.productDefinitionId,
        state: 'Active', isDefault: true, _id: { $ne: doc._id },
      });
      if (!otherDefault) {
        return res.status(409).json(errEnvelope('DEFAULT_VERSION_CONFLICT',
          'Cannot deprecate the default version until another Active version is set as default (PDL-063)',
          { correlationId }));
      }
    }

    const a = actor(req);
    doc.state        = 'Deprecated';
    doc.deprecatedAt = new Date();
    doc.isDefault    = false;
    doc.addLifecycleEvent('Deprecated', a, req.body?.reason || '', doc.dependencySummary());
    await doc.save();

    // Mark as deprecated in product_definition_active_versions so Discovery
    // shows it as [DEPRECATED] and blocks new device bindings (but keeps
    // existing managed devices running).
    try {
      const PDEF_DB = process.env.PRODUCTDEF_DB_NAME || 'ubrnms_productdef';
      const pdb = mongoose.connection.readyState === 1
        ? mongoose.connection.client.db(PDEF_DB) : null;
      if (pdb) {
        await pdb.collection('product_definition_active_versions').updateOne(
          { productDefinitionId: doc.productDefinitionId },
          { $set: { lifecycleStatus: 'DEPRECATED', updatedAt: new Date() } },
        );
      }
    } catch (e) {
      logger.warn({ msg: 'descriptor: failed to mark deprecated in pdef registry', err: e.message });
    }

    logger.info({ msg: 'descriptor deprecated', productDefinitionId: doc.productDefinitionId, version: doc.version, correlationId });
    return res.json(okEnvelope(doc.toObject(), { correlationId }));
  } catch (err) {
    return res.status(500).json(errEnvelope('INTERNAL_ERROR', err.message, { correlationId }));
  }
});

// ── POST /api/descriptors/:id/versions/:v/retire ──────────────────────────────
// Deprecated → Retired. SERVER-SIDE delete guard (PDL-060, PDL-061).
router.post('/:id/versions/:v/retire', requireDescriptorAction('retire'), async (req, res) => {
  const correlationId = req.headers['x-correlation-id'] || uuidv4();
  try {
    const doc = await resolveVersion(req.params.id, req.params.v);
    if (!doc) return res.status(404).json(errEnvelope('NOT_FOUND', 'Descriptor version not found'));
    if (doc.state !== 'Deprecated')
      return res.status(409).json(errEnvelope('INVALID_STATE', `Retirement requires state Deprecated, current: ${doc.state}`));

    // Maker-checker: second approver must differ from the one who deprecated it
    const a = actor(req);
    const deprecatedEvent = [...doc.lifecycleHistory].reverse().find((e) => e.toState === 'Deprecated');
    if (deprecatedEvent && a.userId !== 'unknown' &&
        deprecatedEvent.actorUserId !== 'unknown' &&
        a.userId === deprecatedEvent.actorUserId) {
      return res.status(403).json(errEnvelope('MAKER_CHECKER_VIOLATION',
        'The user who deprecated this version cannot also retire it (PDL-110)',
        { deprecatedBy: deprecatedEvent.actorUsername, correlationId }));
    }

    // Refresh live device count
    const nmsDb = mongoose.connection.readyState === 1 ? mongoose.connection.db : null;
    if (nmsDb) {
      const liveCount = await nmsDb.collection('devices').countDocuments({
        productDefinitionId: doc.productDefinitionId, isDeprovisioned: { $ne: true },
      });
      doc.dependency.boundDevices = liveCount;
    }

    // PDL-060: server-side dependency guard
    if (!doc.canRetire()) {
      const counts = doc.dependencySummary();
      return res.status(409).json({
        status: 'error',
        error: {
          code:    'DEFINITION_IN_USE',
          message: `Cannot retire ${doc.productDefinitionId} v${doc.version}: it is still in use.`,
          productDefinitionId: doc.productDefinitionId,
          version:             doc.version,
          dependents:          counts,
          nextSteps: [
            'Migrate devices to an Active version',
            'Deprovision devices that are no longer needed',
            'Cancel or wait for running jobs',
            'Clear open alarms',
          ],
          detailsUrl:  `/api/descriptors/${doc.productDefinitionId}/versions/${doc.version}/dependents`,
          correlationId,
        },
      });
    }

    doc.state     = 'Retired';
    doc.retiredAt = new Date();
    doc.addLifecycleEvent('Retired', a, req.body?.reason || '', doc.dependencySummary());
    await doc.save();

    // ── Retire: remove from discovery engine immediately ──────────────────────
    // fingerprint_registry_entries removed → device will no longer auto-match
    // product_definition_active_versions removed → disappears from Discovery dropdown
    // parameter_registry_entries KEPT → existing bound devices can still render config UI
    try {
      const PDEF_DB = process.env.PRODUCTDEF_DB_NAME || 'ubrnms_productdef';
      const pdb = mongoose.connection.readyState === 1
        ? mongoose.connection.client.db(PDEF_DB) : null;
      if (pdb) {
        await pdb.collection('fingerprint_registry_entries').deleteMany({ productDefinitionId: doc.productDefinitionId });
        await pdb.collection('product_definition_active_versions').deleteOne({ productDefinitionId: doc.productDefinitionId });
        await pdb.collection('product_definition_versions').updateOne(
          { definitionId: doc.productDefinitionId },
          { $set: { lifecycleStatus: 'RETIRED', updatedAt: new Date() } },
        );
        logger.info({ msg: 'descriptor: removed from discovery registry on retire', productDefinitionId: doc.productDefinitionId });
      }
    } catch (e) {
      logger.warn({ msg: 'descriptor: retire registry cleanup failed', err: e.message });
    }

    logger.info({ msg: 'descriptor retired', productDefinitionId: doc.productDefinitionId, version: doc.version, correlationId });
    return res.json(okEnvelope(doc.toObject(), { correlationId }));
  } catch (err) {
    return res.status(500).json(errEnvelope('INTERNAL_ERROR', err.message, { correlationId }));
  }
});

// ── POST /api/descriptors/:id/versions/:v/purge ───────────────────────────────
// Retired → Purged after retention period (PDL-067, default 90 days)
router.post('/:id/versions/:v/purge', requireDescriptorAction('purge'), async (req, res) => {
  const correlationId = req.headers['x-correlation-id'] || uuidv4();
  try {
    const doc = await resolveVersion(req.params.id, req.params.v);
    if (!doc) return res.status(404).json(errEnvelope('NOT_FOUND', 'Descriptor version not found'));
    if (doc.state !== 'Retired')
      return res.status(409).json(errEnvelope('INVALID_STATE', `Purge requires state Retired, current: ${doc.state}`));

    // Maker-checker for purge (PDL-110)
    const a = actor(req);
    const retiredEvent = [...doc.lifecycleHistory].reverse().find((e) => e.toState === 'Retired');
    if (retiredEvent && a.userId !== 'unknown' &&
        retiredEvent.actorUserId !== 'unknown' &&
        a.userId === retiredEvent.actorUserId) {
      return res.status(403).json(errEnvelope('MAKER_CHECKER_VIOLATION',
        'The user who retired this version cannot also purge it (PDL-110)', { correlationId }));
    }

    // Retention period check (PDL-067)
    if (!doc.canPurge()) {
      const elapsed = doc.retiredAt ? ((Date.now() - new Date(doc.retiredAt).getTime()) / 86_400_000).toFixed(1) : 0;
      return res.status(409).json(errEnvelope('RETENTION_NOT_MET',
        `Purge is not allowed yet. Retired ${elapsed} day(s) ago; must wait ${doc.purgeRetentionDays} days (PDL-067).`,
        { retiredAt: doc.retiredAt, purgeRetentionDays: doc.purgeRetentionDays, elapsedDays: elapsed, correlationId }));
    }

    // Purge: remove ALL derived artifacts — complete cleanup (PDL-068, PDL-044)
    // Keeps: lifecycle history + canonical JSON in descriptor_versions (audit trail)
    // Removes: all registry entries, wireframes, product_definition_versions record
    const PDEF_DB = process.env.PRODUCTDEF_DB_NAME || 'ubrnms_productdef';
    const db = mongoose.connection.readyState === 1 ? mongoose.connection.client.db(PDEF_DB) : null;
    if (db) {
      await db.collection('parameter_registry_entries').deleteMany({ productDefinitionId: doc.productDefinitionId });
      await db.collection('fingerprint_registry_entries').deleteMany({ productDefinitionId: doc.productDefinitionId });
      await db.collection('product_definition_active_versions').deleteOne({ productDefinitionId: doc.productDefinitionId });
      await db.collection('product_definition_versions').deleteOne({ definitionId: doc.productDefinitionId });
      logger.info({ msg: 'descriptor: full registry purge complete', productDefinitionId: doc.productDefinitionId });
    }
    await NodeViewWireframe.deleteMany({ productDefinitionId: doc.productDefinitionId });
    const redis = req.app.get('redis');
    if (redis) await invalidateCache(redis, doc.productDefinitionId).catch(() => {});

    doc.state    = 'Purged';
    doc.purgedAt = new Date();
    // Clear the source file reference but keep canonicalJson for archive (PDL-044)
    doc.sourceFilename = null;
    doc.addLifecycleEvent('Purged', a, req.body?.reason || 'Purged', {});
    await doc.save();

    logger.info({ msg: 'descriptor purged', productDefinitionId: doc.productDefinitionId, version: doc.version, correlationId });
    return res.json(okEnvelope({ productDefinitionId: doc.productDefinitionId, version: doc.version, state: 'Purged', purgedAt: doc.purgedAt }, { correlationId }));
  } catch (err) {
    return res.status(500).json(errEnvelope('INTERNAL_ERROR', err.message, { correlationId }));
  }
});

// ── DELETE /api/descriptors/:id/versions/:v ───────────────────────────────────
// Allowed ONLY for Draft or Invalid (PDL-070); audited
router.delete('/:id/versions/:v', requireDescriptorAction('delete_draft'), async (req, res) => {
  const correlationId = req.headers['x-correlation-id'] || uuidv4();
  try {
    const doc = await resolveVersion(req.params.id, req.params.v);
    if (!doc) return res.status(404).json(errEnvelope('NOT_FOUND', 'Descriptor version not found'));
    if (!['Draft', 'Invalid'].includes(doc.state)) {
      return res.status(409).json(errEnvelope('USE_RETIRE_FLOW',
        `Only Draft or Invalid versions may be deleted directly. Use the deprecate → retire → purge flow for state "${doc.state}" (PDL-070).`,
        { state: doc.state, retireUrl: `/api/descriptors/${doc.productDefinitionId}/versions/${doc.version}/deprecate`, correlationId }));
    }

    const a = actor(req);
    // Audit before delete (PDL-070)
    doc.addLifecycleEvent('Deleted', a, req.body?.reason || 'Deleted (Draft)', {});
    await doc.save(); // save audit entry first
    await DescriptorVersion.deleteOne({ _id: doc._id });

    logger.info({ msg: 'descriptor draft deleted', productDefinitionId: doc.productDefinitionId, version: doc.version, correlationId });
    return res.json(okEnvelope({ productDefinitionId: doc.productDefinitionId, version: doc.version, deleted: true }, { correlationId }));
  } catch (err) {
    return res.status(500).json(errEnvelope('INTERNAL_ERROR', err.message, { correlationId }));
  }
});

// ── POST /api/devices/deprovision ─────────────────────────────────────────────
// Bulk deprovision by filter (PDL-084)
router.post('/devices/deprovision', requireDescriptorAction('deprovision'), async (req, res) => {
  const correlationId = req.headers['x-correlation-id'] || uuidv4();
  try {
    const { productDefinitionId, version, deviceIds, dryRun = false } = req.body || {};
    const nmsDb = mongoose.connection.readyState === 1 ? mongoose.connection.db : null;
    if (!nmsDb) return res.status(503).json(errEnvelope('SERVICE_UNAVAILABLE', 'MongoDB not connected'));

    const filter = { isDeprovisioned: { $ne: true } };
    if (productDefinitionId) filter.productDefinitionId = productDefinitionId;
    if (Array.isArray(deviceIds) && deviceIds.length > 0) filter._id = { $in: deviceIds };

    const devices = await nmsDb.collection('devices').find(filter).toArray();
    if (dryRun) {
      return res.json(okEnvelope({ dryRun: true, totalMatched: devices.length,
        devices: devices.map((d) => ({ deviceId: String(d._id), serialNumber: d.serialNumber, ipAddress: d.ipAddress })),
      }, { correlationId }));
    }

    const results = [];
    for (const d of devices) {
      try {
        // PDL-080: ordered deprovision steps (simplified — stop polling, clear binding, mark deprovisioned)
        await nmsDb.collection('devices').updateOne(
          { _id: d._id },
          { $set: {
            isDeprovisioned:     true,
            productDefinitionId: null,
            deprovisionedAt:     new Date(),
            deprovisionedBy:     actor(req).userId,
            updatedAt:           new Date(),
          }},
        );
        // Delete current parameter values
        await nmsDb.collection('device_parameter_values').deleteOne({ _id: String(d._id) }).catch(() => {});
        results.push({ deviceId: String(d._id), success: true });
      } catch (e) {
        results.push({ deviceId: String(d._id), success: false, error: e.message });
      }
    }

    // Update dependency counts for affected descriptors
    if (productDefinitionId) {
      const remaining = await nmsDb.collection('devices').countDocuments({
        productDefinitionId, isDeprovisioned: { $ne: true },
      });
      await DescriptorVersion.updateMany(
        { productDefinitionId, state: { $in: ['Active', 'Deprecated'] } },
        { $set: { 'dependency.boundDevices': remaining, updatedAt: new Date() } },
      );
    }

    return res.json(okEnvelope({ total: devices.length, results }, { correlationId }));
  } catch (err) {
    return res.status(500).json(errEnvelope('INTERNAL_ERROR', err.message, { correlationId }));
  }
});

// ── POST /api/descriptors/:id/versions/:v/migrate ────────────────────────────
// Bulk migrate devices from this version to a target Active version (PDL-090)
router.post('/:id/versions/:v/migrate', requireDescriptorAction('migrate'), async (req, res) => {
  const correlationId = req.headers['x-correlation-id'] || uuidv4();
  try {
    const { targetVersion, dryRun = true, batchSize = 100 } = req.body || {};
    if (!targetVersion) return res.status(400).json(errEnvelope('MISSING_FIELD', 'targetVersion is required'));

    const sourceDoc = await resolveVersion(req.params.id, req.params.v);
    if (!sourceDoc) return res.status(404).json(errEnvelope('NOT_FOUND', 'Source version not found'));

    const targetDoc = await DescriptorVersion.findOne({ productDefinitionId: req.params.id, version: targetVersion });
    if (!targetDoc) return res.status(404).json(errEnvelope('NOT_FOUND', 'Target version not found'));
    if (targetDoc.state !== 'Active')
      return res.status(422).json(errEnvelope('TARGET_NOT_ACTIVE', 'Target version must be Active (PDL-090)'));

    const nmsDb = mongoose.connection.readyState === 1 ? mongoose.connection.db : null;
    if (!nmsDb) return res.status(503).json(errEnvelope('SERVICE_UNAVAILABLE', 'MongoDB not connected'));

    const devices = await nmsDb.collection('devices')
      .find({ productDefinitionId: sourceDoc.productDefinitionId, isDeprovisioned: { $ne: true } })
      .limit(parseInt(batchSize, 10))
      .toArray();

    // Dry-run: just show what would change
    if (dryRun) {
      const sourceParams = new Set((sourceDoc.canonicalJson?.config?.groups || [])
        .flatMap((g) => (g.parameters || []).map((p) => p.parameterId || p.id)));
      const targetParams = new Set((targetDoc.canonicalJson?.config?.groups || [])
        .flatMap((g) => (g.parameters || []).map((p) => p.parameterId || p.id)));

      const added   = [...targetParams].filter((p) => !sourceParams.has(p));
      const removed = [...sourceParams].filter((p) => !targetParams.has(p));

      return res.json(okEnvelope({
        dryRun: true,
        sourceVersion: sourceDoc.version,
        targetVersion: targetDoc.version,
        devicesAffected: devices.length,
        parameterDiff: { added, removed, addedCount: added.length, removedCount: removed.length },
      }, { correlationId }));
    }

    // Live migration: rebind devices to target version (PDL-094)
    const results = [];
    for (const d of devices) {
      try {
        await nmsDb.collection('devices').updateOne(
          { _id: d._id },
          { $set: { productDefinitionId: targetDoc.productDefinitionId, updatedAt: new Date() } },
        );
        results.push({ deviceId: String(d._id), success: true });
      } catch (e) {
        results.push({ deviceId: String(d._id), success: false, error: e.message });
      }
    }

    // Update dependency counts
    const sourceRemaining = await nmsDb.collection('devices').countDocuments({
      productDefinitionId: sourceDoc.productDefinitionId, isDeprovisioned: { $ne: true },
    });
    await DescriptorVersion.updateMany(
      { productDefinitionId: sourceDoc.productDefinitionId, state: { $in: ['Active', 'Deprecated'] } },
      { $set: { 'dependency.boundDevices': sourceRemaining, updatedAt: new Date() } },
    );

    return res.json(okEnvelope({ total: devices.length, results }, { correlationId }));
  } catch (err) {
    return res.status(500).json(errEnvelope('INTERNAL_ERROR', err.message, { correlationId }));
  }
});

module.exports = router;
