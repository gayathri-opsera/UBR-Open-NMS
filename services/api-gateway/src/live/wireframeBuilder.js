'use strict';

/**
 * Wireframe Builder
 * =================
 * Converts a set of parameter_registry_entries (from the active product definition)
 * into a persisted Node View wireframe document.
 *
 * Design principles:
 *  - PURE: no I/O. Accepts entries[], returns a wireframe object.
 *  - SINGLE canonical path: XML / JSON / XLS all normalise into the same
 *    parameter_registry_entries shape before reaching here, so one builder
 *    handles every format.
 *  - BUILD-TIME not RUNTIME: this runs once (on activation) and is stored.
 *    The runtime Node View simply loads the stored document — no rebuilding.
 *
 * Wireframe document shape (see nodeViewWireframe.model.js for the Mongoose schema):
 * {
 *   productDefinitionId : string,
 *   versionId           : string,        // product-definition-service version UUID
 *   registryVersion     : string,        // fingerprint/registry version string
 *   status              : 'ACTIVE',
 *   wireframe           : {
 *     groups : [ GroupSpec ]
 *   },
 *   parameterCount      : number,
 *   groupCount          : number,
 *   createdAt           : Date,
 *   updatedAt           : Date,
 * }
 *
 * GroupSpec:
 * {
 *   groupId    : string,
 *   label      : string,
 *   displayOrder : number,
 *   subGroups  : string[],               // ordered, unique sub-group names
 *   parameters : [ ParameterSpec ],
 * }
 *
 * ParameterSpec: all layout/rendering metadata needed at runtime — no SNMP values.
 */

const { parseEnumOptions } = require('./enumOptions');

// ── Widget auto-selection (mirrors the ui-template route) ─────────────────────

/**
 * Derive the effective UI widget from data type + metadata.
 * An explicit `uiWidget` in the definition always wins.
 */
function deriveWidget(entry) {
  if (entry.uiWidget) return entry.uiWidget;
  const dt = (entry.dataType || 'STRING').toString().toLowerCase();
  const hasEnum = Array.isArray(entry.enumValues) && entry.enumValues.length > 0;
  if (dt === 'boolean')                                        return 'toggle';
  if (dt === 'enum' || hasEnum)                               return 'dropdown';
  if (entry.minValue != null && entry.maxValue != null)       return 'slider';
  if (dt === 'gauge')                                         return 'gauge';
  if (dt === 'counter')                                       return 'counter';
  return 'textfield';
}

/** Parameters whose value is a credential — the UI masks them by default. */
const SENSITIVE_RE = /(passphrase|password|passwd|secret|\bkey\b|community)/i;

/** Bump when the persisted wireframe shape changes — older stored wireframes are rebuilt on read. */
const WIREFRAME_SCHEMA_VERSION = 2;

// ── Duplicate-ID deduplication (mirrors Java parser prefix logic) ─────────────

/**
 * Within a single group, parameter IDs must be unique.
 * If the definition has duplicates (same id in different sub-groups), prefix them
 * with their sub-group, matching what the Java XmlProductDefinitionParser does.
 */
function deduplicateIds(params) {
  const seen = new Map();   // parameterId → count
  for (const p of params) {
    seen.set(p.parameterId, (seen.get(p.parameterId) || 0) + 1);
  }
  const prefixed = params.map((p) => {
    if (seen.get(p.parameterId) > 1 && p.subGroup) {
      return { ...p, parameterId: `${p.subGroup}_${p.parameterId}` };
    }
    return p;
  });
  // Last resort: still-colliding ids (same id in the same sub-group) get a numeric suffix,
  // so every parameter of a group has a unique id.
  const used = new Map();
  return prefixed.map((p) => {
    const n = (used.get(p.parameterId) || 0) + 1;
    used.set(p.parameterId, n);
    return n > 1 ? { ...p, parameterId: `${p.parameterId}_${n}` } : p;
  });
}

// ── Validation ────────────────────────────────────────────────────────────────

const VALID_WIDGETS = new Set(['textfield', 'slider', 'dropdown', 'toggle', 'gauge', 'counter', 'readonly']);
const VALID_DATATYPES = new Set(['STRING', 'INTEGER', 'GAUGE', 'COUNTER', 'BOOLEAN', 'ENUM',
  'IPADDRESS', 'OCTET_STRING', 'TIMETICKS', 'OID', 'BITS']);

/**
 * Validate a parameter entry during wireframe build.
 * Returns an array of validation-error strings (empty = OK).
 */
function validateParameter(entry, groupId) {
  const errs = [];
  if (!entry.parameterId) errs.push(`[${groupId}] parameter missing id`);
  if (!entry.displayName)  errs.push(`[${groupId}::${entry.parameterId}] missing displayName`);
  const dt = (entry.dataType || '').toUpperCase();
  if (dt && !VALID_DATATYPES.has(dt)) errs.push(`[${groupId}::${entry.parameterId}] unknown dataType "${dt}"`);
  if (entry.uiWidget && !VALID_WIDGETS.has(entry.uiWidget))
    errs.push(`[${groupId}::${entry.parameterId}] unknown uiWidget "${entry.uiWidget}"`);
  if (entry.enumValues && !Array.isArray(entry.enumValues))
    errs.push(`[${groupId}::${entry.parameterId}] enumValues must be an array`);
  return errs;
}

// ── Core builder ──────────────────────────────────────────────────────────────

/**
 * Build a Node View wireframe from parameter registry entries.
 *
 * @param {object}   definition   Output of liveParameters.loadDefinition()
 *                                { productDefinitionId, versionId, registryVersion, entries[] }
 * @param {object}   [options]
 * @param {boolean}  [options.strict=false]  Throw on validation errors instead of logging them.
 * @returns {{ wireframe: object, parameterCount: number, groupCount: number, validationErrors: string[] }}
 */

// ── UI Hierarchy helpers ───────────────────────────────────────────────────────

function humanizeGroupLabel(groupId) {
  const ACRONYMS = new Set(['ip', 'vlan', 'dhcp', 'dcs', 'ddrs', 'atpc', 'snr', 'qos', 'gps', 'ofdma', 'snmp', 'kpi', 'mtu']);
  return (groupId || '')
    .replace(/[-_.]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((w) => ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * Derive sidebar hierarchy (uiPage, uiParent, uiTab) from a descriptor groupId.
 * Mirrors the real device UI structure (Wireless → Radio 1/2/2.4GHz/QoS, Network, Management, Monitor).
 * @param {string} groupId
 * @param {object} [firstEntry]  first parameter entry (forward-compat: may carry uiPage from future Java service)
 * @returns {{ uiPage: string, uiParent: string, uiTab: string }}
 */
function deriveUiHierarchy(groupId, firstEntry) {
  if (firstEntry && firstEntry.uiPage) {
    return { uiPage: firstEntry.uiPage, uiParent: firstEntry.uiParent || '', uiTab: firstEntry.uiTab || '' };
  }
  const id = (groupId || '').toLowerCase();

  // ── Radio 1 ─────────────────────────────────────────────────────────────────
  if (id === 'radio1.properties' || id === 'radio.properties')
    return { uiPage: 'Wireless', uiParent: 'Radio 1', uiTab: 'Properties' };
  if (id === 'radio1.ddrs' || id === 'radio1.ddrsatpc' || id === 'radio1.atpc')
    return { uiPage: 'Wireless', uiParent: 'Radio 1', uiTab: 'DDRS/ATPC' };
  if (id === 'radio1.dfs')  return { uiPage: 'Wireless', uiParent: 'Radio 1', uiTab: 'DFS' };
  if (id === 'radio1.dcs')  return { uiPage: 'Wireless', uiParent: 'Radio 1', uiTab: 'DCS' };
  if (id === 'radio1.kpi')  return { uiPage: 'Monitor',  uiParent: 'Radio 1', uiTab: 'KPIs' };
  if (id.startsWith('radio1.'))
    return { uiPage: 'Wireless', uiParent: 'Radio 1', uiTab: humanizeGroupLabel(id.replace('radio1.', '')) };

  // ── Radio 2 ─────────────────────────────────────────────────────────────────
  if (id === 'radio2.properties')
    return { uiPage: 'Wireless', uiParent: 'Radio 2', uiTab: 'Properties' };
  if (id === 'radio2.ddrs' || id === 'radio2.ddrsatpc' || id === 'radio2.atpc')
    return { uiPage: 'Wireless', uiParent: 'Radio 2', uiTab: 'DDRS/ATPC' };
  if (id === 'radio2.dfs')  return { uiPage: 'Wireless', uiParent: 'Radio 2', uiTab: 'DFS' };
  if (id === 'radio2.dcs')  return { uiPage: 'Wireless', uiParent: 'Radio 2', uiTab: 'DCS' };
  if (id === 'radio2.kpi')  return { uiPage: 'Monitor',  uiParent: 'Radio 2', uiTab: 'KPIs' };
  if (id.startsWith('radio2.'))
    return { uiPage: 'Wireless', uiParent: 'Radio 2', uiTab: humanizeGroupLabel(id.replace('radio2.', '')) };

  // ── 2.4 GHz Radio ───────────────────────────────────────────────────────────
  if (id === 'radio24.properties' || id === 'radio24ghz.properties' || id === 'radio24' || id === 'radio24ghz')
    return { uiPage: 'Wireless', uiParent: '2.4 GHz Radio', uiTab: 'Properties' };
  if (id === 'radio24.kpi' || id === 'radio24ghz.kpi')
    return { uiPage: 'Monitor',  uiParent: '2.4 GHz Radio', uiTab: 'KPIs' };
  if (id.startsWith('radio24.'))
    return { uiPage: 'Wireless', uiParent: '2.4 GHz Radio', uiTab: humanizeGroupLabel(id.replace('radio24.', '')) };

  // ── QoS ─────────────────────────────────────────────────────────────────────
  if (id === 'qos') return { uiPage: 'Wireless', uiParent: 'QoS', uiTab: 'QoS Settings' };

  // ── Hyphen-separated variants (legacy descriptors: wireless-properties, network-ipconfiguration…) ──
  if (id === 'wireless-properties' || id === 'wireless.properties')
    return { uiPage: 'Wireless', uiParent: 'Radio 1', uiTab: 'Properties' };
  if (id === 'wireless-ddrs' || id === 'wireless.ddrs')
    return { uiPage: 'Wireless', uiParent: 'Radio 1', uiTab: 'DDRS/ATPC' };
  if (id === 'wireless-atpc' || id === 'wireless.atpc')
    return { uiPage: 'Wireless', uiParent: 'Radio 1', uiTab: 'ATPC' };
  if (id === 'wireless-dcs' || id === 'wireless.dcs')
    return { uiPage: 'Wireless', uiParent: 'Radio 1', uiTab: 'DCS' };
  if (id === 'wireless-dfs' || id === 'wireless.dfs')
    return { uiPage: 'Wireless', uiParent: 'Radio 1', uiTab: 'DFS' };
  if (id.startsWith('wireless-') || id.startsWith('wireless.'))
    return { uiPage: 'Wireless', uiParent: 'Radio 1', uiTab: humanizeGroupLabel(id.replace(/^wireless[-.]/, '')) };

  if (id === 'network-ipconfiguration' || id === 'network-ip' || id === 'network.ipconfiguration')
    return { uiPage: 'Network', uiParent: 'IP Configuration', uiTab: 'IPv4' };
  if (id === 'network-vlan' || id === 'network.vlan')
    return { uiPage: 'Network', uiParent: 'VLAN', uiTab: 'VLAN Settings' };
  if (id === 'network-ethernet' || id === 'network.ethernet')
    return { uiPage: 'Network', uiParent: 'Ethernet', uiTab: 'Ethernet Settings' };
  if (id === 'network-dhcp' || id === 'network-dhcp24' || id === 'network.dhcp')
    return { uiPage: 'Network', uiParent: 'DHCP / Leases', uiTab: id.includes('24') ? '2.4 GHz' : 'DHCP Settings' };
  if (id.startsWith('network-') || id.startsWith('network.'))
    return { uiPage: 'Network', uiParent: humanizeGroupLabel(id.replace(/^network[-.]/, '')), uiTab: 'Settings' };

  if (id === 'monitor-linkstats' || id === 'monitor.linkstats' || id === 'monitor-links')
    return { uiPage: 'Monitor', uiParent: 'Links', uiTab: 'Link Statistics' };
  if (id === 'monitor-wirelessstats' || id === 'monitor.wirelessstats')
    return { uiPage: 'Monitor', uiParent: 'Wireless', uiTab: 'Wireless KPIs' };
  if (id.startsWith('monitor-') || id.startsWith('monitor.'))
    return { uiPage: 'Monitor', uiParent: humanizeGroupLabel(id.replace(/^monitor[-.]/, '')), uiTab: 'KPIs' };

  // ── Generic "radio" (single-radio devices) ───────────────────────────────────
  if (id === 'radio' || id === 'wireless' || id === 'radio.settings')
    return { uiPage: 'Wireless', uiParent: 'Radio 1', uiTab: 'Properties' };
  if (id.startsWith('radio.'))
    return { uiPage: 'Wireless', uiParent: 'Radio 1', uiTab: humanizeGroupLabel(id.replace('radio.', '')) };

  // ── Network ─────────────────────────────────────────────────────────────────
  if (id === 'network.ip.5ghz')
    return { uiPage: 'Network', uiParent: 'IP Configuration', uiTab: '5 GHz Radio' };
  if (id === 'network.ip.24ghz' || id === 'network.ip.2ghz')
    return { uiPage: 'Network', uiParent: 'IP Configuration', uiTab: '2.4 GHz Radio' };
  if (id === 'network.ip' || id === 'network.ipconfiguration' || id.startsWith('network.ip'))
    return { uiPage: 'Network', uiParent: 'IP Configuration', uiTab: 'IPv4' };
  if (id === 'network.vlan' || id === 'vlan')
    return { uiPage: 'Network', uiParent: 'VLAN', uiTab: 'VLAN Settings' };
  if (id === 'network.ethernet' || id === 'ethernet' || id === 'ethernet.settings')
    return { uiPage: 'Network', uiParent: 'Ethernet', uiTab: 'Ethernet Settings' };
  if (id === 'network.dhcp' || id === 'dhcp' || id === 'network.dhcpleases')
    return { uiPage: 'Network', uiParent: 'DHCP / Leases', uiTab: 'DHCP Settings' };
  if (id === 'network' || id === 'network.settings')
    return { uiPage: 'Network', uiParent: 'IP Configuration', uiTab: 'Settings' };
  if (id.startsWith('network.'))
    return { uiPage: 'Network', uiParent: humanizeGroupLabel(id.replace('network.', '')), uiTab: 'Settings' };

  // ── Management ──────────────────────────────────────────────────────────────
  if (id === 'management' || id === 'mgmt')
    return { uiPage: 'Management', uiParent: 'Management', uiTab: 'Settings' };
  if (id === 'snmp' || id === 'snmp.settings')
    return { uiPage: 'Management', uiParent: 'Management', uiTab: 'SNMP' };

  // ── Monitor — well-known telemetry/stats groupIds ───────────────────────────
  if (id === 'summary')          return { uiPage: 'Monitor', uiParent: 'Summary',     uiTab: 'Overview' };
  if (id === 'system' || id === 'system.health')
    return { uiPage: 'Monitor', uiParent: 'System',     uiTab: 'Health' };
  if (id === 'cpu')              return { uiPage: 'Monitor', uiParent: 'System',     uiTab: 'CPU' };
  if (id === 'memory')           return { uiPage: 'Monitor', uiParent: 'System',     uiTab: 'Memory' };
  if (id === 'environment')      return { uiPage: 'Monitor', uiParent: 'System',     uiTab: 'Environment' };
  if (id === 'interface' || id === 'interfaces')
    return { uiPage: 'Monitor', uiParent: 'Interfaces',  uiTab: 'Port Stats' };
  if (id === 'spanning_tree' || id === 'spanning-tree')
    return { uiPage: 'Monitor', uiParent: 'Interfaces',  uiTab: 'Spanning Tree' };
  if (id === 'vpn')              return { uiPage: 'Monitor', uiParent: 'Security',   uiTab: 'VPN' };
  if (id === 'security')         return { uiPage: 'Monitor', uiParent: 'Security',   uiTab: 'Policies' };
  if (id === 'radio_rf' || id === 'radio-rf')
    return { uiPage: 'Wireless', uiParent: 'Radio 1',   uiTab: 'RF Settings' };
  if (id === 'link_quality' || id === 'link-quality')
    return { uiPage: 'Monitor', uiParent: 'Links',       uiTab: 'Link Quality' };
  if (id === 'throughput')       return { uiPage: 'Monitor', uiParent: 'Links',       uiTab: 'Throughput' };
  if (id === 'ethernet.kpi' || id === 'ethernet.stats' || id === 'ethernet-kpi' || id === 'ethernet-stats')
    return { uiPage: 'Monitor', uiParent: 'Ethernet',   uiTab: 'Port KPIs' };
  if (id.includes('kpi') || id.includes('.stats') || id.includes('-stats') || id.startsWith('monitor.'))
    return { uiPage: 'Monitor', uiParent: humanizeGroupLabel(id.replace(/[-_.](kpi|stats|monitor)$/, '')), uiTab: 'KPIs' };

  // ── Default: treat as a Wireless setting ────────────────────────────────────
  return { uiPage: 'Wireless', uiParent: 'Settings', uiTab: humanizeGroupLabel(id) };
}

function buildWireframe(definition, { strict = false } = {}) {
  const { productDefinitionId, versionId, registryVersion, entries = [] } = definition;

  if (!productDefinitionId) throw new Error('buildWireframe: productDefinitionId is required');

  // ── 1. Group entries (same logic as liveParameters.groupEntries) ───────────
  const groupMap = new Map();   // groupId → { groupId, displayOrder, params[] }
  for (const entry of entries) {
    const gid = entry.groupId || 'default';
    if (!groupMap.has(gid)) {
      groupMap.set(gid, {
        groupId:      gid,
        displayOrder: entry.groupDisplayOrder || groupMap.size + 1,
        params:       [],
      });
    }
    groupMap.get(gid).params.push(entry);
  }

  // ── 2. Sort groups by their displayOrder ───────────────────────────────────
  const sortedGroups = [...groupMap.values()]
    .sort((a, b) => a.displayOrder - b.displayOrder);

  // ── 3. Build each group ────────────────────────────────────────────────────
  const validationErrors = [];
  let totalParams = 0;

  const groups = sortedGroups.map((g, gi) => {
    // Sort parameters within the group: explicit displayOrder first, then document order
    // (never alphabetical — the definition's own order is the hierarchy order).
    const sortedParams = g.params
      .map((e, i) => ({ e, i }))
      .sort((a, b) => {
        const ka = a.e.displayOrder > 0 ? a.e.displayOrder : Number.MAX_SAFE_INTEGER;
        const kb = b.e.displayOrder > 0 ? b.e.displayOrder : Number.MAX_SAFE_INTEGER;
        return ka < kb ? -1 : ka > kb ? 1 : a.i - b.i;
      })
      .map((x) => x.e);

    // Validate and deduplicate
    const allErrs = sortedParams.flatMap((e) => validateParameter(e, g.groupId));
    validationErrors.push(...allErrs);

    const deduped = deduplicateIds(sortedParams);

    // Collect ordered unique sub-groups (order of first appearance in the definition)
    const subGroups = [];
    for (const p of deduped) {
      if (p.subGroup && !subGroups.includes(p.subGroup)) subGroups.push(p.subGroup);
    }

    // Build parameter specs
    const parameters = deduped.map((e, pi) => {
      const dataType       = (e.dataType || 'STRING').toString();
      const effectiveWidget = deriveWidget(e);
      return {
        parameterId:     e.parameterId,
        displayName:     e.displayName || e.parameterId,
        dataType,
        unit:            e.unit            || null,
        uiWidget:        e.uiWidget        || null,
        effectiveWidget,
        readOnly:        e.readOnly === true,
        snmpOid:         e.snmpOid         || null,
        hidden:          e.hidden === true,
        displayOrder:    pi + 1,                 // final, gap-free position within the group
        subGroup:        e.subGroup        || null,
        enumValues:      Array.isArray(e.enumValues) ? e.enumValues : [],
        options:         parseEnumOptions(e.enumValues),
        minValue:        e.minValue        ?? null,
        maxValue:        e.maxValue        ?? null,
        defaultValue:    e.defaultValue    ?? null,
        description:     e.description     || null,
        thresholds:      e.thresholds      || null,
        sensitive:       SENSITIVE_RE.test(`${e.parameterId} ${e.displayName || ''}`),
        uiVisibleTo:     e.uiVisibleTo     || null,   // kept for server-side role filtering at runtime
      };
    });

    totalParams += parameters.length;

    // ── Derive UI hierarchy (sidebar structure) from groupId naming convention ──
    // groupId patterns (dot-separated): <page>.<parent>.<tab>
    // e.g. "radio1.properties" → Wireless / Radio 1 / Properties
    //      "network.ip.5ghz"   → Network / IP Configuration / 5 GHz Radio
    // Falls back gracefully for legacy flat groupIds ("radio", "network", "snmp").
    const uiHierarchy = deriveUiHierarchy(g.groupId, g.params[0]);

    return {
      groupId:             g.groupId,
      label:               uiHierarchy.uiTab || humanizeGroupLabel(g.groupId),
      displayOrder:        gi + 1,
      pollIntervalSeconds: parseInt(process.env.LIVE_POLL_INTERVAL_SECONDS || '60', 10),
      subGroups,
      parameters,
      // Sidebar hierarchy — used by NodeViewParameters to render the
      // left navigation tree that mirrors the real device web UI.
      uiPage:   uiHierarchy.uiPage,
      uiParent: uiHierarchy.uiParent,
      uiTab:    uiHierarchy.uiTab,
    };
  });

  // ── 4. Validate globally ───────────────────────────────────────────────────
  // Duplicate group IDs
  const groupIds = groups.map((g) => g.groupId);
  const dupGroups = groupIds.filter((id, i) => groupIds.indexOf(id) !== i);
  if (dupGroups.length) validationErrors.push(`Duplicate group IDs: ${dupGroups.join(', ')}`);

  // Duplicate parameter IDs within each group
  for (const g of groups) {
    const pids = g.parameters.map((p) => p.parameterId);
    const dups = pids.filter((id, i) => pids.indexOf(id) !== i);
    if (dups.length) validationErrors.push(`[${g.groupId}] duplicate parameter IDs after dedup: ${dups.join(', ')}`);
  }

  if (strict && validationErrors.length > 0) {
    throw new Error(`Wireframe validation failed:\n${validationErrors.join('\n')}`);
  }

  return {
    wireframe: { groups },
    parameterCount: totalParams,
    groupCount:     groups.length,
    validationErrors,
  };
}

module.exports = { buildWireframe, deriveWidget, validateParameter, deduplicateIds, WIREFRAME_SCHEMA_VERSION };
