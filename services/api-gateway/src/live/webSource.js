'use strict';

/**
 * Device web-UI source — fills the fields a device's SNMP agent cannot answer.
 *
 * UBR655 firmware 1.0.0.161 (the re-rooted tree, see oidAliases.js / firmwareQuirks.js) answers SNMP for its
 * configuration with placeholders and has no SNMP row for Radio 2, while its own LuCI web UI shows the real values.
 * This module reads that UI — GETs after a login, the same pages an operator opens — and maps what it shows onto
 * the definition's parameters, so the Node View shows what the device shows.
 *
 *   config pages  wireless/radio1 (carries all three radios), network/ip, vlan, eth, dhcp: a `const values = {…}`
 *                 of UCI keys plus `param_elements` option labels, the very data those pages render from
 *   statistics    monitor/intfstats/<n> and monitor/get_linkstat/ath<n>: JSON the pages poll every 1–5 s
 *
 * Scope and safety:
 *   - Per device: the login lives on the device record (devices.webCredentials, password AES-256-GCM encrypted,
 *     see utils/aesEncrypt.js). A device without one is never contacted over HTTPS.
 *   - Fill-only: a value SNMP really answered is never overwritten; only missing / placeholder answers are filled.
 *   - Read-only: nothing is written to the device.
 *   - Rules are keyed by field LABEL, so they work for every definition format that uses the device's own labels.
 *   - The devices serve a self-signed certificate, so verification is off for these requests only.
 */

const https = require('https');
const logger = require('../utils/logger');
const { decrypt } = require('../utils/aesEncrypt');
const { runExclusive } = require('./snmpGate');

// The configuration pages (≈15 slow page reads) change rarely — the device's own UI does not even refresh them — so they are
// re-read every 2 minutes by default (WEB_CONFIG_TTL_SECONDS); statistics are read on every poll and every few seconds on screen.
const CONFIG_TTL_MS = Math.max(15, parseInt(process.env.WEB_CONFIG_TTL_SECONDS || '120', 10)) * 1000;
const SESSION_TTL_MS = 4 * 60_000;     // LuCI sessions last minutes; one login serves many reads
const REQUEST_TIMEOUT_MS = Math.max(3, parseInt(process.env.WEB_REQUEST_TIMEOUT_SECONDS || '10', 10)) * 1000;   // the radios answer web pages slowly when busy
const agent = new https.Agent({ rejectUnauthorized: false, keepAlive: false });

const RADIO_N = { radio24: 0, radio1: 1, radio2: 2 };   // group prefix → UCI interface number (wifiN / athN)

/**
 * The role the device itself shows: each radio's header label is BTS / CPE / AP. A unit with a radio in CPE (station)
 * mode is a CPE — its backhaul radio is linked to a BTS, while its 2.4 GHz management radio stays an AP — otherwise a
 * BTS. Same rule the SNMP profile in deviceAttributes.js uses, so both sources agree.
 */
function roleFromHeader(header) {
  const radios = [header && header.radio1, header && header.radio2].map((x) => String(x || '').toUpperCase());
  if (radios.includes('CPE')) return 'CPE';
  if (radios.includes('BTS')) return 'BTS';
  return '';
}

/** Role read straight from the device web UI with a login given for this call (used by discovery). */
async function fetchRole(host, creds) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt += 1) {      // a busy radio can miss the first request
    try {
      const session = await login(host, { user: creds.user, pass: creds.pass });
      const header = (parseJsonBody(await get(host, session, 'admin/get_headerparams/1')).header) || {};
      return roleFromHeader(header);
    } catch (e) { lastErr = e; await new Promise((r) => setTimeout(r, 1000)); }
  }
  logger.warn({ msg: 'web source: role read failed', host, err: lastErr && lastErr.message });
  return '';
}

/** { username, password } from the device record, or null. */
function credentialsFor(device) {
  const w = device && device.webCredentials;
  if (!w || !w.username || !w.password) return null;
  try { return { user: w.username, pass: decrypt(w.password) }; }
  catch (e) { logger.warn({ msg: 'web source: stored credential unreadable', err: e.message }); return null; }
}

// ── HTTP ──────────────────────────────────────────────────────────────────────

function request(host, { method = 'GET', path, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = https.request({ host, port: 443, method, path, headers, agent, timeout: REQUEST_TIMEOUT_MS }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('web UI request timed out'), { code: 'WEB_TIMEOUT' })));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function login(host, creds) {
  const form = `luci_username=${encodeURIComponent(creds.user)}&luci_password=${encodeURIComponent(creds.pass)}`;
  const res = await request(host, {
    method: 'POST', path: '/cgi-bin/luci/',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(form) },
    body: form,
  });
  const cookie = ((res.headers['set-cookie'] || [])[0] || '').split(';')[0];
  const stok = /stok=([a-f0-9]+)/.exec(res.headers.location || '');
  if (!cookie || !stok) throw new Error(`web UI login refused (HTTP ${res.status})`);
  return { cookie, stok: stok[1] };
}

const get = (host, session, path) => request(host, {
  path: `/cgi-bin/luci/;stok=${session.stok}/${path}`, headers: { Cookie: session.cookie },
}).then((r) => {
  if (r.status !== 200) throw new Error(`web UI ${path}: HTTP ${r.status}`);
  return r.body;
});

/** The pages return JSON as a JSON-encoded string ("{\"wifi1\":…}"); unwrap both layers. */
function parseJsonBody(text) {
  let v = JSON.parse(text);
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { /* plain string answer */ } }
  return v;
}

// ── page parsing ──────────────────────────────────────────────────────────────

/** `const values = { "uci.key": "value", … }` → plain object. */
function parseValues(html) {
  const m = /const values\s*=\s*\{([\s\S]*?)\n\s*\};?/.exec(html);
  const out = {};
  if (!m) return out;
  const re = /"([^"]+)"\s*:\s*\n?\s*"((?:[^"\\]|\\.)*)"/g;
  let p;
  while ((p = re.exec(m[1]))) out[p[1]] = p[2].replace(/&quot;/g, '"');
  return out;
}

/** `const param_elements = { "uci.key": { 0: "Label", … }, … }` → { key: { raw: label } }. */
function parseElements(html) {
  const m = /const param_elements\s*=\s*\{([\s\S]*?)\n\s*\};/.exec(html);
  const out = {};
  if (!m) return out;
  const body = m[1].replace(/\/\/[^\n]*/g, '');
  const re = /"([^"]+)"\s*:\s*\{([^}]*)\}/g;
  let p;
  while ((p = re.exec(body))) {
    const map = {};
    const pair = /(?:"([^"]+)"|(\w+))\s*:\s*"([^"]*)"/g;
    let q;
    while ((q = pair.exec(p[2]))) map[q[1] ?? q[2]] = q[3];
    out[p[1]] = map;
  }
  return out;
}

// ── formatting the way the device UI does ─────────────────────────────────────

const BANDWIDTH = { HT20: '20 MHz', 'HT40+': '40 MHz', HT40: '40 MHz', HT80: '80 MHz', HT160: '160 MHz' };
const FORCE_BW = { 0: 'Auto', 20: '20 MHz', 40: '40 MHz', 80: '80 MHz' };
const VLAN_MODE = { 0: 'Transparent', 1: 'Access', 2: 'Trunk', 3: 'Q-in-Q' };
const TRUNK_OPT = { 1: 'List', 2: 'All' };
const prefixToMask = (n) => {
  const bits = parseInt(n, 10);
  if (!(bits >= 0 && bits <= 32)) return '';
  const m = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return [24, 16, 8, 0].map((s) => (m >>> s) & 255).join('.');
};
/** The UI shows VLAN EtherTypes byte-swapped relative to the stored value (0x0081 → 0x8100). */
const etherType = (v) => {
  const h = String(v || '').replace(/^0x/i, '').padStart(4, '0');
  return h.length === 4 ? `0x${h.slice(2)}${h.slice(0, 2)}` : String(v || '');
};
const channelLabel = (n, ch) => {
  if (!ch) return '';
  if (String(ch).toLowerCase() === 'auto') return 'Auto';
  const c = parseInt(ch, 10);
  if (!(c > 0)) return String(ch);
  const mhz = n === 0 ? (c === 14 ? 2484 : 2407 + 5 * c) : 5000 + 5 * c;
  return `${c} ( ${mhz} MHz )`;
};
/** Throughput as the device page shows it: bits/s → Mbps, 0 below 10 kbps. */
const mbps = (v) => { const n = Number(v); return n > 10_000 ? (n / 1_000_000).toFixed(2) : '0'; };
const percent = (v) => String(v == null ? '' : v).replace(/\s*%$/, '');
const uptime = (secs) => {
  const s = parseInt(secs, 10);
  if (!(s >= 0)) return '';
  const p = (x) => String(x).padStart(2, '0');
  return `${p(Math.floor(s / 86400))}:${p(Math.floor((s % 86400) / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
};
/** `var mcs_data_rates = "0 ( 8 Mbps ),1 ( 17 Mbps ),…"` of a DDRS page → { single, dual, triple, quad } label maps. */
function mcsSets(html) {
  const m = /var mcs_data_rates\s*=\s*"([^"]*)"/.exec(html || '');
  const sets = { single: {}, dual: {}, triple: {}, quad: {} };
  if (!m) return sets;
  const arr = m[1].split(',');
  const rates = arr.map((x) => { const r = /\([^)]*\)/.exec(x); return r ? r[0] : ''; });
  for (let i = 0; i < arr.length - 1; i += 1) {
    if (i > 35) sets.quad[i] = `MCS${i - 36} ${rates[i]}`;
    else if (i > 23) sets.triple[i] = `MCS${i - 24} ${rates[i]}`;
    else if (i > 11) sets.dual[i] = `MCS${i - 12} ${rates[i]}`;
    else sets.single[i] = `MCS${arr[i].trim()}`;
  }
  return sets;
}
/** A select shows the option for its value, or its first option when the value is not among them (browser default). */
const pick = (map, value) => (map[value] !== undefined ? map[value] : Object.values(map)[0]);
const SPATIAL = { 1: 'Single', 2: 'Dual', 3: 'Auto', 4: 'Triple', 5: 'Quad' };
const norm = (label) => String(label || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// ── field rules (by label) ────────────────────────────────────────────────────

/** intfstats key per Wireless Stats label (normalised). */
const STATS_KEY = {
  totaltxpackets: 'tx_pkts', totalrxpackets: 'rx_pkts', txbroadcastpackets: 'tx_bcast_pkts', rxbroadcastpackets: 'rx_bcast_pkts',
  txmulticastpackets: 'tx_mcast_pkts', rxmulticastpackets: 'rx_mcast_pkts', txunicastpackets: 'tx_ucast_pkts', rxunicastpackets: 'rx_ucast_pkts',
  crcerrors: 'mpdu_err', frameerrors: 'phy_err', rtxpercent: 'avg_rtx', txpps: 'tx_pps', rxpps: 'rx_pps',
  managementtxpackets: 'tx_mgmt_pkts', managementrxpackets: 'rx_mgmt_pkts', beaconstransmitted: 'tx_beacon', beaconsreceived: 'bcn_rcv',
  authenticationrequestsreceived: 'aut_recv', authenticationrequestssent: 'aut_xmit', authenticationconfirms: 'aut_confirm',
  authenticationrejects: 'aut_reject', deauthenticationrequestssent: 'deaut_xmit', deauthenticationrequestsreceived: 'deaut_recv',
  authenticationresultlast: 'auth_reason', associationrequestsreceived: 'assoc_recv', associationrequestssent: 'assoc_xmit',
  associationrejects: 'assoc_reject', associationconfirms: 'assoc_confirm', disassociationrequestsreceived: 'disassoc_recv',
  disassociationrequestssent: 'disassoc_xmit', associationresultlast: 'assoc_reason',
};
const STATS_FORMAT = {
  txthroughput: (s) => mbps(s.tx_tput), rxthroughput: (s) => mbps(s.rx_tput),
  channelutilisationcombined: (s) => percent(s.g_chanutil), channelutilisation: (s) => percent(s.g_chanutil),
  obssutilisation: (s) => percent(s.g_ch_util_obss),
};
const LINK_KEY = {
  macaddress: (st) => st.mac, ipaddress: (st) => st.ip, uptime: (st) => uptime(st.assoc_time), customername: (st) => st.r_custname,
  localsnra1: (st) => st.l_snra1, localsnra2: (st) => st.l_snra2, remotesnra1: (st) => st.r_snra1, remotesnra2: (st) => st.r_snra2,
};

const one = (display, raw = display) => [{ index: '', raw: String(raw ?? ''), display: String(display ?? ''), web: true }];

/**
 * Value a parameter shows on the device, or undefined when this source has none for it.
 * @param {{ groupId: string, displayName?: string, label?: string }} entry
 * @param {{ config?: object, stats?: object, links?: object }} src  parsed snapshot
 */
function valueFor(entry, src) {
  const label = norm(entry.displayName || entry.label);
  const gid = String(entry.groupId);
  const [prefix, section] = gid.split('.');
  const cfg = src.config || {};
  const v = cfg.values || {};
  const el = cfg.elements || {};
  const n = RADIO_N[prefix];

  // ── statistics (live JSON) ─────────────────────────────────────────────────
  if (section === 'wireless_stats' && n != null) {
    const s = src.stats && src.stats[n];
    if (!s) return undefined;
    if (STATS_FORMAT[label]) return one(STATS_FORMAT[label](s));
    if (STATS_KEY[label] && s[STATS_KEY[label]] !== undefined) return one(percent(s[STATS_KEY[label]]));
    return undefined;
  }
  if (section === 'link_stats' && n != null) {
    const ls = src.links && src.links[n];
    if (ls === undefined || !LINK_KEY[label]) return undefined;
    if (ls === null) return one('No client associated');
    return Object.entries(ls).map(([id, st]) => ({ index: id, raw: String(LINK_KEY[label](st) ?? ''), display: String(LINK_KEY[label](st) ?? ''), web: true }));
  }
  if (label === 'systemname') return cfg.sysname ? one(cfg.sysname) : undefined;
  if (!Object.keys(v).length) return undefined;

  // ── radio properties ───────────────────────────────────────────────────────
  if (section === 'properties' && n != null) {
    const wifi = `wireless.wifi${n}`;
    const iface = `wireless.@wifi-iface[${n}]`;
    switch (label) {
      case 'radiostatus': return v[`${iface}.disabled`] === undefined ? undefined : one(v[`${iface}.disabled`] === '0' ? 'Enable' : 'Disable', v[`${iface}.disabled`]);
      case 'linktype': { const r = v[`${wifi}.linktype`]; return r === undefined ? undefined : one((el[`${wifi}.linktype`] || {})[r] || r, r); }
      case 'radiomode': { const r = v[`${iface}.mode`]; return r === undefined ? undefined : one((el[`${iface}.mode`] || {})[r] || r, r); }
      case 'ssid': return v[`${iface}.ssid`] === undefined ? undefined : one(v[`${iface}.ssid`]);
      case 'bandwidth': {
        // The page has two controls labelled "Bandwidth": the channel width (htmode) is shown for an AP/BTS radio,
        // "Force Bandwidth" (Auto / 20 / 40 / 80 MHz) for a STA/CPE radio. Show what the page shows.
        if (v[`${iface}.mode`] === 'sta') {
          const f = v[`advwireless.ath${n}.force_bw`];
          return f === undefined ? undefined : one(FORCE_BW[f] || `${f} MHz`, f);
        }
        const r = v[`${wifi}.htmode`];
        return r === undefined ? undefined : one(BANDWIDTH[r] || r, r);
      }
      case 'country': {
        const r = v[`${wifi}.country`];
        if (r === undefined) return undefined;
        return one((cfg.countries || {})[r] || (el[`${wifi}.country`] || {})[r] || r, r);
      }
      case 'configuredchannel': { const r = v[`advwireless.ath${n}.channel`]; return r === undefined ? undefined : one(channelLabel(n, r), r); }
      case 'activechannel': { const a = (cfg.activeChannel || {})[n]; return a == null ? undefined : one(a); }
      case 'encryption': { const r = v[`${iface}.encryption`]; return r === undefined ? undefined : one((el[`${iface}.encryption`] || {})[r] || r, r); }
      case 'key': return v[`${iface}.key`] === undefined ? undefined : one(v[`${iface}.key`]);
      case 'maximumsus': return v[`${iface}.maxsta`] === undefined ? undefined : one(v[`${iface}.maxsta`]);
      case 'ofdma': return v[`${wifi}.ofdma`] === undefined ? undefined : one(v[`${wifi}.ofdma`] === '1' ? 'Enable' : 'Disable', v[`${wifi}.ofdma`]);
      case 'dlulratio': {
        if (n === 0 || v['ath1qos.qoscfg.dlulratio'] === undefined) return undefined;
        const r = v['ath1qos.qoscfg.dlulratio'];
        return one((el['ath1qos.qoscfg.dlulratio'] || {})[r] || r, r);
      }
      default: return undefined;
    }
  }

  // ── DDRS / ATPC / DFS / DCS (their own pages) ──────────────────────────────
  if ((prefix === 'radio1' || prefix === 'radio2') && ['ddrs', 'atpc', 'dfs', 'dcs'].includes(section)) {
    const t = `txparam.ath${n}`;
    const stream = v[`${t}.spatialstream`];
    const sets = (cfg.mcs || {})[n] || mcsSets('');
    const modSet = stream === '1' ? sets.single
      : stream === '4' ? (Object.keys(sets.triple).length ? sets.triple : sets.dual)
      : stream === '5' ? (Object.keys(sets.quad).length ? sets.quad : sets.dual) : sets.dual;
    const en = (x) => (x === undefined ? undefined : one(x === '1' ? 'Enable' : 'Disable', x));
    switch (label) {
      case 'ddrsstatus': return en(v[`${t}.ddrsstatus`]);
      case 'spatialstream': case 'spatialstreamddrsstatusisenabled': case 'spatialstreamddrsstatusisdisabled':
        return stream === undefined ? undefined : one(SPATIAL[stream] || stream, stream);
      case 'modulationindex': return v[`${t}.ddrsrate`] === undefined ? undefined : one(pick(modSet, v[`${t}.ddrsrate`]), v[`${t}.ddrsrate`]);
      case 'minmodulationindex': case 'minmodulationindexspatialstreamissingledual':
        return v[`${t}.ddrsminrate`] === undefined ? undefined : one(pick(modSet, v[`${t}.ddrsminrate`]), v[`${t}.ddrsminrate`]);
      case 'maxmodulationindex': case 'maxmodulationindexspatialstreamissingledual':
        return v[`${t}.ddrsmaxrate`] === undefined ? undefined : one(pick(modSet, v[`${t}.ddrsmaxrate`]), v[`${t}.ddrsmaxrate`]);
      case 'maxdataratesinglestream': return v[`${t}.maxsinglemcs`] === undefined ? undefined : one(pick(sets.single, v[`${t}.maxsinglemcs`]), v[`${t}.maxsinglemcs`]);
      case 'maxdataratedualstream': return v[`${t}.maxdualmcs`] === undefined ? undefined : one(pick(sets.dual, v[`${t}.maxdualmcs`]), v[`${t}.maxdualmcs`]);
      case 'atpcstatus': return en(v[`${t}.atpcstatus`]);
      case 'transmitpower': return v[`${t}.atpcpower`] === undefined ? undefined : one(v[`${t}.atpcpower`]);
      case 'connectorizedantennagain': return v[`${t}.antennagain`] === undefined ? undefined : one(v[`${t}.antennagain`]);
      case 'maximumeirp': return v[`${t}.maxeirp`] === undefined ? undefined : one(v[`${t}.maxeirp`]);
      case 'dfsstatus': return en(v[`wireless.wifi${n}.staDFSEn`]);
      case 'dcsstatus': return en(v[`advwireless.ath${n}.dcsstatus`]);
      case 'rtxthreshold': return v[`advwireless.ath${n}.dcsthrld`] === undefined ? undefined : one(v[`advwireless.ath${n}.dcsthrld`]);
      case 'backgroundscan': return en(v[`advwireless.ath${n}.bgscan`]);
      default: return undefined;
    }
  }

  // ── network ────────────────────────────────────────────────────────────────
  if (/^network[-.]ip(config|_5ghz)/.test(gid)) {
    const dhcp = v['network.lan.proto'] === 'dhcp';
    switch (label) {
      case 'addresstype': return v['network.lan.proto'] === undefined ? undefined : one(dhcp ? 'Dynamic - IPv4' : 'Static', v['network.lan.proto']);
      case 'ipaddress': { const r = dhcp ? v.ipv4dynip : v['network.lan.ipaddr']; return r === undefined ? undefined : one(r); }
      case 'subnetmask': { const r = dhcp ? prefixToMask(v.ipv4dynmask) : v['network.lan.netmask']; return r === undefined ? undefined : one(r); }
      case 'gateway': { const r = dhcp ? v.ipv4dyngway : v['network.lan.gateway']; return r === undefined ? undefined : one(r); }
      case 'ipv6address': return v['network.lan.ip6addr'] === undefined ? undefined : one(v['network.lan.ip6addr']);
      case 'ipv6gateway': return v['network.lan.ip6gw'] === undefined ? undefined : one(v['network.lan.ip6gw']);
      default: return undefined;
    }
  }
  if (section === 'vlan' && (prefix === 'radio1' || prefix === 'radio2')) {
    const a = `vlan.ath${n}`;
    const raw = {
      mgmtvlanid: v['vlan.ath1.mgmtvlan'], mode: v[`${a}.mode`], trunkoption: v[`${a}.trunkoption`], trunkvlanid: v[`${a}.trunkvlan`],
      cvlanpriority: v[`${a}.cvlanprio`], cvlanid: v[`${a}.cvlanid`], cvlanethertype: v[`${a}.cvlanethertype`],
      svlanpriority: v[`${a}.svlanprio`], svlanid: v[`${a}.svlan`], svlanethertype: v[`${a}.svlanethertype`],
    }[label];
    if (raw === undefined) return undefined;
    if (label === 'mode') return one(VLAN_MODE[raw] || raw, raw);
    if (label === 'trunkoption') return one(TRUNK_OPT[raw] || raw, raw);
    if (label.endsWith('ethertype')) return one(etherType(raw), raw);
    return one(raw);
  }
  if (section === 'ethernet' && /^eth\d$/.test(prefix)) {
    if (label === 'speedduplex') { const r = v[`ethernet.${prefix}.speed`]; return r === undefined ? undefined : one(r === '0' ? 'Auto Negotiation' : r, r); }
    if (label === 'mtu') return v['network.lan.mtu'] === undefined ? undefined : one(v['network.lan.mtu']);
    return undefined;
  }
  if (/^network[-.]dhcp$/.test(gid)) {
    switch (label) {
      case 'dhcpserver': return v['dhcp.lan.ignore'] === undefined ? undefined : one(v['dhcp.lan.ignore'] === '1' ? 'Disable' : 'Enable', v['dhcp.lan.ignore']);
      case 'startipaddress': return v['dhcp.lan.start'] === undefined ? undefined : one(v['dhcp.lan.start']);
      case 'endipaddress': return v['dhcp.lan.limit'] === undefined ? undefined : one(v['dhcp.lan.limit']);
      case 'leasetime': return v['dhcp.lan.leasetime'] === undefined ? undefined : one(v['dhcp.lan.leasetime']);
      default: return undefined;
    }
  }
  return undefined;
}

/** True when SNMP already gave this parameter a real value. */
const hasRealValue = (list) => Array.isArray(list) && list.some((i) => !i.placeholder);

/** Fill the parameters SNMP could not answer (missing or placeholder) with what the device web UI shows. */
function overlay(entries, mapped, src) {
  let filled = 0;
  for (const e of entries) {
    const key = `${e.groupId}::${e.parameterId}`;
    if (hasRealValue(mapped.get(key))) continue;
    const got = valueFor(e, src);
    if (got && got.length) { mapped.set(key, got); filled += 1; }
  }
  return filled;
}

// ── fetching ──────────────────────────────────────────────────────────────────

const cache = new Map(); // host → { at, config }

async function fetchConfig(host, session) {
  const wireless = await get(host, session, 'admin/wireless/radio1');
  const values = parseValues(wireless);
  const elements = parseElements(wireless);
  for (const page of ['network/ip', 'network/vlan', 'network/eth', 'network/dhcp']) {
    try { Object.assign(values, parseValues(await get(host, session, `admin/${page}`))); }
    catch (e) { logger.warn({ msg: 'web source: page unavailable', host, page, err: e.message }); }
  }
  // DDRS/ATPC (one page per radio: its MCS rate table differs), DFS and DCS pages
  const mcs = {};
  for (const [n, page] of [[1, 'radio1/ddrs1'], [2, 'radio2/ddrs2']]) {
    try { const h = await get(host, session, `admin/wireless/${page}`); Object.assign(values, parseValues(h)); mcs[n] = mcsSets(h); }
    catch (e) { logger.warn({ msg: 'web source: page unavailable', host, page, err: e.message }); }
  }
  for (const page of ['radio1/dfs1', 'radio1/dcs1']) {
    try { Object.assign(values, parseValues(await get(host, session, `admin/wireless/${page}`))); }
    catch (e) { logger.warn({ msg: 'web source: page unavailable', host, page, err: e.message }); }
  }
  const countries = {};
  try {
    for (const pair of parseJsonBody(await get(host, session, 'admin/wireless/coun_list/')).split(',')) {
      const [k, name] = pair.trim().split(':');
      if (k && name) countries[k] = name;
    }
  } catch { /* labels fall back to param_elements */ }
  let sysname = null; let role = '';
  try {
    const header = parseJsonBody(await get(host, session, 'admin/get_headerparams/1')).header || {};
    sysname = header.sysname || null; role = roleFromHeader(header);
  } catch { /* optional */ }

  const activeChannel = {};
  for (const n of [0, 1, 2]) {
    const status = values[`curr.intfstatus.ath${n}`];
    const links = values[`wifi${n}_links`];
    const mode = values[`wireless.@wifi-iface[${n}].mode`];
    if (!status || (links === '0' && mode === 'sta')) continue;
    try {
      const freq = Math.round(parseFloat(values[`curr.freq.ath${n}`]) * 1000);
      const ch = parseJsonBody(await get(host, session, `admin/getchan/${n}/${values[`wireless.wifi${n}.country`]}/HT20/${freq}`));
      if (ch != null && String(ch).trim()) activeChannel[n] = `${String(ch).trim()} ( ${freq} MHz )`;
    } catch { /* leave unset */ }
  }
  return { values, elements, countries, sysname, activeChannel, mcs, role };
}

async function fetchStats(host, session, radios) {
  const stats = {};
  const links = {};
  for (const n of radios) {
    try {
      const j = parseJsonBody(await get(host, session, `admin/monitor/intfstats/${n}`));
      stats[n] = j[`wifi${n}`] || Object.values(j)[0];
    } catch (e) { logger.warn({ msg: 'web source: intfstats failed', host, radio: n, err: e.message }); }
    try {
      const j = parseJsonBody(await get(host, session, `admin/monitor/get_linkstat/ath${n}`));
      links[n] = j && typeof j === 'object' && Object.keys(j).length ? j : null;   // "no" → no client associated
    } catch { /* leave unset */ }
  }
  return { stats, links };
}

const sessions = new Map(); // host → { session, at }

async function sessionFor(host, creds, force = false) {
  const cur = sessions.get(host);
  if (!force && cur && Date.now() - cur.at < SESSION_TTL_MS) return cur.session;
  const session = await login(host, creds);
  sessions.set(host, { session, at: Date.now() });
  return session;
}

/**
 * Parsed snapshot for a device: configuration (cached 30 s) and, for `radios`, fresh statistics.
 * One web session per device is reused, and reads on the same device run one at a time (the radios are small).
 * @returns {Promise<{ config: object, stats: object, links: object } | null>} null when the device has no web
 *          credential or cannot be reached (fields then keep their SNMP state)
 */
async function snapshot(device, host, { radios = [0, 1, 2], withConfig = true } = {}) {
  const creds = credentialsFor(device);
  if (!creds) return null;
  // Two lanes per device: the configuration pass (≈15 page reads, once per poll) must not delay the live statistics
  // reads the Monitor tab makes every few seconds. Each lane is still one request at a time.
  return runExclusive(host, withConfig ? 443 : 4431, async () => {
    const attempt = async (force) => {
      const session = await sessionFor(host, creds, force);
      let config = (cache.get(host) || {}).config;
      const fresh = cache.get(host) && Date.now() - cache.get(host).at < CONFIG_TTL_MS;
      if (withConfig && !fresh) {
        config = await fetchConfig(host, session);
        cache.set(host, { at: Date.now(), config });
      }
      const { stats, links } = radios.length ? await fetchStats(host, session, radios) : { stats: {}, links: {} };
      return { config: config || {}, stats, links };
    };
    try {
      try { return await attempt(false); }
      catch (e) { sessions.delete(host); return await attempt(true); }   // expired session → log in once more
    } catch (e) {
      logger.warn({ msg: 'web source unavailable', host, err: e.message });
      return null;
    }
  });
}

module.exports = {
  credentialsFor, roleFromHeader, fetchRole, snapshot, overlay, valueFor, parseValues, parseElements, parseJsonBody,
  prefixToMask, etherType, channelLabel, mbps, uptime, norm, mcsSets,
};
