'use strict';

/**
 * Calculated fields for Custom UI screens (e.g. uptime = sysUpTime ticks → "1d 11h 15m 56s").
 *
 * A tiny, SAFE expression language — no eval, no property access, no assignment:
 *   numbers, {inputName}, + - * / %, parentheses, comparisons (< > <= >= == !=),
 *   functions round(x[,n]) floor ceil abs min max if(cond,a,b)
 * Inputs are named values read from the device (each input = one OID) and parsed as numbers.
 * The frontend ships an identical port (frontend/src/v2/deviceui/calcExpr.ts) for the design-time preview;
 * keep the two in step (tests/unit/calcExpr.test.js pins the behaviour).
 */

const FUNCS = {
  round: (x, n = 0) => { const f = 10 ** n; return Math.round(x * f) / f; },
  floor: Math.floor, ceil: Math.ceil, abs: Math.abs,
  min: Math.min, max: Math.max,
  if: (c, a, b) => (c ? a : b),
};

function tokenize(src) {
  const t = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9.]/.test(c)) { const m = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(src.slice(i)); if (!m) throw new Error(`bad number at ${i}`); t.push({ k: 'num', v: Number(m[0]) }); i += m[0].length; continue; }
    if (c === '{') { const j = src.indexOf('}', i); if (j < 0) throw new Error('unclosed {'); t.push({ k: 'var', v: src.slice(i + 1, j).trim() }); i = j + 1; continue; }
    if (/[a-z_]/i.test(c)) { const m = /^[a-z_][a-z0-9_]*/i.exec(src.slice(i)); t.push({ k: 'id', v: m[0].toLowerCase() }); i += m[0].length; continue; }
    const two = src.slice(i, i + 2);
    if (['<=', '>=', '==', '!='].includes(two)) { t.push({ k: 'op', v: two }); i += 2; continue; }
    if ('+-*/%<>(),'.includes(c)) { t.push({ k: 'op', v: c }); i++; continue; }
    throw new Error(`unexpected "${c}"`);
  }
  return t;
}

/** Parse to an AST; throws on any syntax problem. */
function parse(src) {
  const toks = tokenize(String(src || ''));
  let p = 0;
  const peek = () => toks[p];
  const eat = (v) => { const t = toks[p]; if (!t || t.v !== v) throw new Error(`expected "${v}"`); p++; };
  const cmp = () => {
    let l = add();
    while (peek() && peek().k === 'op' && ['<', '>', '<=', '>=', '==', '!='].includes(peek().v)) { const o = toks[p++].v; l = { t: 'bin', o, l, r: add() }; }
    return l;
  };
  const add = () => {
    let l = mul();
    while (peek() && peek().k === 'op' && ['+', '-'].includes(peek().v)) { const o = toks[p++].v; l = { t: 'bin', o, l, r: mul() }; }
    return l;
  };
  const mul = () => {
    let l = un();
    while (peek() && peek().k === 'op' && ['*', '/', '%'].includes(peek().v)) { const o = toks[p++].v; l = { t: 'bin', o, l, r: un() }; }
    return l;
  };
  const un = () => { if (peek() && peek().k === 'op' && peek().v === '-') { p++; return { t: 'neg', x: un() }; } return prim(); };
  const prim = () => {
    const t = toks[p++];
    if (!t) throw new Error('unexpected end');
    if (t.k === 'num') return { t: 'num', v: t.v };
    if (t.k === 'var') return { t: 'var', v: t.v };
    if (t.k === 'id') {
      if (!Object.prototype.hasOwnProperty.call(FUNCS, t.v)) throw new Error(`unknown function ${t.v}`);
      eat('(');
      const args = [];
      if (!(peek() && peek().v === ')')) { args.push(cmp()); while (peek() && peek().v === ',') { p++; args.push(cmp()); } }
      eat(')');
      return { t: 'call', f: t.v, args };
    }
    if (t.v === '(') { const e = cmp(); eat(')'); return e; }
    throw new Error(`unexpected "${t.v}"`);
  };
  const ast = cmp();
  if (p < toks.length) throw new Error(`unexpected "${toks[p].v}"`);
  return ast;
}

/** Names of the {inputs} an expression uses. */
function referencedInputs(src) {
  const out = new Set();
  const walk = (n) => { if (!n) return; if (n.t === 'var') out.add(n.v); (n.args || []).forEach(walk); walk(n.l); walk(n.r); walk(n.x); };
  walk(parse(src));
  return [...out];
}

function run(n, vars) {
  switch (n.t) {
    case 'num': return n.v;
    case 'var': { if (!(n.v in vars) || !Number.isFinite(vars[n.v])) throw new Error(`no value for {${n.v}}`); return vars[n.v]; }
    case 'neg': return -run(n.x, vars);
    case 'call': return FUNCS[n.f](...n.args.map((a) => run(a, vars)));
    case 'bin': {
      const a = run(n.l, vars), b = run(n.r, vars);
      switch (n.o) {
        case '+': return a + b; case '-': return a - b; case '*': return a * b;
        case '/': if (b === 0) throw new Error('division by zero'); return a / b;
        case '%': if (b === 0) throw new Error('division by zero'); return a % b;
        case '<': return a < b ? 1 : 0; case '>': return a > b ? 1 : 0;
        case '<=': return a <= b ? 1 : 0; case '>=': return a >= b ? 1 : 0;
        case '==': return a === b ? 1 : 0; case '!=': return a !== b ? 1 : 0;
        default: throw new Error('bad operator');
      }
    }
    default: throw new Error('bad node');
  }
}

/** Evaluate `src` with numeric `vars` ({ name: number }). Throws with a readable message when it cannot. */
function evaluate(src, vars = {}) {
  const v = run(parse(src), vars);
  if (!Number.isFinite(v)) throw new Error('result is not a number');
  return v;
}

function duration(totalSeconds, short) {
  let s = Math.max(0, Math.floor(totalSeconds));
  const d = Math.floor(s / 86400); s -= d * 86400;
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60); s -= m * 60;
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (d || h) parts.push(`${h}h`);
  if (d || h || m || short) parts.push(`${m}m`);
  if (!short) parts.push(`${s}s`);
  return parts.join(' ');
}

/** Number → display text. formats: none | duration (seconds in) | duration-short | bytes | percent | mbps (bits/s in) */
function formatNumber(n, format = 'none', decimals) {
  const fix = (x, d) => (d == null || d === '' ? String(Math.round(x * 1e6) / 1e6) : Number(x).toFixed(Number(d)));
  switch (format) {
    case 'duration': return duration(n, false);
    case 'duration-short': return duration(n, true);
    case 'bytes': {
      const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; let x = n;
      while (Math.abs(x) >= 1024 && i < u.length - 1) { x /= 1024; i++; }
      return `${fix(x, decimals ?? (i ? 2 : 0))} ${u[i]}`;
    }
    case 'percent': return `${fix(n, decimals ?? 1)}%`;
    case 'mbps': return `${fix(n / 1e6, decimals ?? 2)} Mbps`;
    default: return fix(n, decimals);
  }
}

/**
 * Compute a calculated field. `spec` = { expr, format?, decimals?, inputs: [{ name, oid }] };
 * `raw` = { [inputName]: raw string read from the device }.
 * @returns {{ ok: true, value: number, text: string } | { ok: false, error: string }}
 */
function computeField(spec, raw = {}) {
  try {
    const vars = {};
    for (const [k, v] of Object.entries(raw)) { const n = Number(String(v).trim()); if (String(v).trim() !== '' && Number.isFinite(n)) vars[k] = n; }
    const value = evaluate(spec.expr, vars);
    return { ok: true, value, text: formatNumber(value, spec.format, spec.decimals) };
  } catch (e) { return { ok: false, error: e.message }; }
}

/** Markers this device family answers with when it has no value ("not applicable"): the web UI shows "-" for them. */
const DEFAULT_EMPTY = ['-NA-', 'NA', '-', '-1'];
const isEmptyRaw = (v, extra) => v == null || String(v).trim() === '' || (extra || DEFAULT_EMPTY).includes(String(v).trim());

/** raw device value → the value a source works with: empty markers dropped, optional `strip` pattern removed */
function cleanInput(input, v) {
  if (isEmptyRaw(v, input.emptyValues)) return null;
  let t = String(v).trim();
  if (input.strip) { try { t = t.replace(new RegExp(String(input.strip).slice(0, 120), 'g'), '').replace(/\s{2,}/g, ' ').trim(); } catch { /* bad pattern: leave as is */ } }
  return t === '' ? null : t;
}

/**
 * A header / label data source — one of:
 *   { kind: 'text',     text }
 *   { kind: 'template', template, fallback?, inputs }   — device values dropped into text. {name} = the (mapped) value;
 *                       [[expr]] / [[expr|format|decimals]] = a calculation over the raw numeric values, e.g.
 *                       '{ch} ( [[5950 + 5*{ch}]] MHz )'. `fallback` is the template used when the main one cannot be
 *                       computed (a missing / non-numeric value), e.g. '{ch}' for a channel that is "auto".
 *   { kind: 'calc',     expr, format, decimals, inputs }    — numeric expression (see computeField)
 * inputs: [{ name, oid, map?, strip?, emptyValues? }]; `map` turns a raw value into display text ({ ap: 'BTS' });
 * `strip` removes a pattern first (a time zone name…). Empty markers (-1, -NA-, NA, -) count as "no value".
 * `raw` = { [inputName]: raw string from the device, or null/undefined when the device returned nothing }.
 * @returns {{ ok: true, text: string } | { ok: false, error: string }}  never invents a value: a missing input is a failure
 */
function computeSource(source, raw = {}) {
  try {
    if (!source) return { ok: false, error: 'no source' };
    if (source.kind === 'text') return { ok: true, text: String(source.text ?? '') };
    const clean = {};      // name → cleaned raw text
    const mapped = {};     // name → display text
    const nums = {};       // name → number (for expressions)
    for (const i of source.inputs || []) {
      const v = cleanInput(i, raw[i.name]);
      if (v == null) continue;
      clean[i.name] = v;
      mapped[i.name] = i.map && Object.prototype.hasOwnProperty.call(i.map, v) ? String(i.map[v]) : v;
      const n = Number(v); if (Number.isFinite(n)) nums[i.name] = n;
    }
    if (source.kind === 'template') {
      const render = (tpl) => {
        let missing = null;
        // <<name=value|then text|else text>> — pick a text by the (cleaned) value of an input; a missing input takes the else branch
        let out = String(tpl ?? '').replace(/<<\s*([^=|>]+?)\s*=\s*([^|>]*?)\s*\|([^|>]*)\|([^>]*)>>/g, (_m, n, v, a, b) => (clean[String(n).trim()] === String(v).trim() ? a : b));
        out = out.replace(/\[\[([^\]]+)\]\]/g, (_m, body) => {
          const [expr, fmt, dec] = String(body).split('|').map((x) => x.trim());
          try { return formatNumber(evaluate(expr, nums), fmt || 'none', dec === undefined || dec === '' ? undefined : Number(dec)); }
          catch (e) { missing = missing || e.message; return ''; }
        });
        out = out.replace(/\{([^}]+)\}/g, (_m, n) => {
          const name = String(n).trim();
          if (!(name in mapped)) { missing = missing || `no value for {${name}}`; return ''; }
          return mapped[name];
        });
        return missing ? { ok: false, error: missing } : { ok: true, text: out };
      };
      const r = render(source.template);
      return !r.ok && source.fallback != null ? render(source.fallback) : r;
    }
    if (source.kind === 'calc') {
      const r = computeField(source, clean);
      return r.ok ? { ok: true, text: r.text } : r;
    }
    return { ok: false, error: `unknown source kind ${source.kind}` };
  } catch (e) { return { ok: false, error: e.message }; }
}

module.exports = { parse, evaluate, referencedInputs, formatNumber, duration, computeField, computeSource, isEmptyRaw, DEFAULT_EMPTY };
