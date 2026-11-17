/* Design-time port of services/api-gateway/src/live/calcExpr.js — keep in step (the gateway evaluates for real). */
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

type Fn = (...a: number[]) => number;
const FUNCS: Record<string, Fn> = {
  round: (x, n = 0) => { const f = 10 ** n; return Math.round(x * f) / f; },
  floor: Math.floor, ceil: Math.ceil, abs: Math.abs,
  min: Math.min, max: Math.max,
  if: (c, a, b) => (c ? a : b),
};

interface Tok { k: 'num' | 'var' | 'id' | 'op'; v: string | number }
function tokenize(src: string): Tok[] {
  const t: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9.]/.test(c)) { const m = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(src.slice(i)); if (!m) throw new Error(`bad number at ${i}`); t.push({ k: 'num', v: Number(m[0]) }); i += m[0].length; continue; }
    if (c === '{') { const j = src.indexOf('}', i); if (j < 0) throw new Error('unclosed {'); t.push({ k: 'var', v: src.slice(i + 1, j).trim() }); i = j + 1; continue; }
    if (/[a-z_]/i.test(c)) { const m = /^[a-z_][a-z0-9_]*/i.exec(src.slice(i)); t.push({ k: 'id', v: (m as RegExpExecArray)[0].toLowerCase() }); i += (m as RegExpExecArray)[0].length; continue; }
    const two = src.slice(i, i + 2);
    if (['<=', '>=', '==', '!='].includes(two)) { t.push({ k: 'op', v: two }); i += 2; continue; }
    if ('+-*/%<>(),'.includes(c)) { t.push({ k: 'op', v: c }); i++; continue; }
    throw new Error(`unexpected "${c}"`);
  }
  return t;
}

/** Parse to an AST; throws on any syntax problem. */
export type Ast = { t: 'num'; v: number } | { t: 'var'; v: string } | { t: 'neg'; x: Ast } | { t: 'call'; f: string; args: Ast[] } | { t: 'bin'; o: string; l: Ast; r: Ast };
export function parse(src: string): Ast {
  const toks = tokenize(String(src || ''));
  let p = 0;
  const peek = () => toks[p];
  const eat = (v: string) => { const t = toks[p]; if (!t || t.v !== v) throw new Error(`expected "${v}"`); p++; };
  const cmp = (): Ast => {
    let l = add();
    while (peek() && peek().k === 'op' && ['<', '>', '<=', '>=', '==', '!='].includes(peek().v as string)) { const o = toks[p++].v as string; l = { t: 'bin', o, l, r: add() }; }
    return l;
  };
  const add = (): Ast => {
    let l = mul();
    while (peek() && peek().k === 'op' && ['+', '-'].includes(peek().v as string)) { const o = toks[p++].v as string; l = { t: 'bin', o, l, r: mul() }; }
    return l;
  };
  const mul = (): Ast => {
    let l = un();
    while (peek() && peek().k === 'op' && ['*', '/', '%'].includes(peek().v as string)) { const o = toks[p++].v as string; l = { t: 'bin', o, l, r: un() }; }
    return l;
  };
  const un = (): Ast => { if (peek() && peek().k === 'op' && peek().v === '-') { p++; return { t: 'neg', x: un() }; } return prim(); };
  const prim = (): Ast => {
    const t = toks[p++];
    if (!t) throw new Error('unexpected end');
    if (t.k === 'num') return { t: 'num', v: t.v as number };
    if (t.k === 'var') return { t: 'var', v: t.v as string };
    if (t.k === 'id') {
      if (!Object.prototype.hasOwnProperty.call(FUNCS, t.v as string)) throw new Error(`unknown function ${t.v}`);
      eat('(');
      const args: Ast[] = [];
      if (!(peek() && peek().v === ')')) { args.push(cmp()); while (peek() && peek().v === ',') { p++; args.push(cmp()); } }
      eat(')');
      return { t: 'call', f: t.v as string, args };
    }
    if (t.v === '(') { const e = cmp(); eat(')'); return e; }
    throw new Error(`unexpected "${t.v}"`);
  };
  const ast = cmp();
  if (p < toks.length) throw new Error(`unexpected "${toks[p].v}"`);
  return ast;
}

/** Names of the {inputs} an expression uses. */
export function referencedInputs(src: string): string[] {
  const out = new Set<string>();
  const walk = (n?: Ast): void => { if (!n) return; if (n.t === 'var') out.add(n.v); if (n.t === 'call') n.args.forEach(walk); if (n.t === 'bin') { walk(n.l); walk(n.r); } if (n.t === 'neg') walk(n.x); };
  walk(parse(src));
  return [...out];
}

function run(n: Ast, vars: Record<string, number>): number {
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
export function evaluate(src: string, vars: Record<string, number> = {}): number {
  const v = run(parse(src), vars);
  if (!Number.isFinite(v)) throw new Error('result is not a number');
  return v;
}

export function duration(totalSeconds: number, short?: boolean): string {
  let s = Math.max(0, Math.floor(totalSeconds));
  const d = Math.floor(s / 86400); s -= d * 86400;
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60); s -= m * 60;
  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (d || h) parts.push(`${h}h`);
  if (d || h || m || short) parts.push(`${m}m`);
  if (!short) parts.push(`${s}s`);
  return parts.join(' ');
}

/** Number → display text. formats: none | duration (seconds in) | duration-short | bytes | percent | mbps (bits/s in) */
export function formatNumber(n: number, format = 'none', decimals?: number | string | null): string {
  const fix = (x: number, d?: number | string | null) => (d == null || d === '' ? String(Math.round(x * 1e6) / 1e6) : Number(x).toFixed(Number(d)));
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
export type CalcSpec = { expr: string; format?: string; decimals?: number | null; inputs?: { name: string; oid: string; sample?: string }[] };
export function computeField(spec: CalcSpec, raw: Record<string, unknown> = {}): { ok: true; value: number; text: string } | { ok: false; error: string } {
  try {
    const vars: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw)) { const n = Number(String(v).trim()); if (String(v).trim() !== '' && Number.isFinite(n)) vars[k] = n; }
    const value = evaluate(spec.expr, vars);
    return { ok: true, value, text: formatNumber(value, spec.format, spec.decimals) };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}


/** Markers this device family answers with when it has no value — keep in step with calcExpr.js (DEFAULT_EMPTY). */
export const DEFAULT_EMPTY = ['-NA-', 'NA', '-', '-1'];
export const isEmptyRaw = (v: unknown, extra?: string[]) => v == null || String(v).trim() === '' || (extra ?? DEFAULT_EMPTY).includes(String(v).trim());

/** Where a header / field value comes from — see services/api-gateway/src/live/calcExpr.js (computeSource); keep in step. */
export type SourceSpec = {
  kind: 'text' | 'template' | 'calc'; text?: string; template?: string | null; fallback?: string | null; expr?: string; format?: string; decimals?: number | null;
  inputs?: { name: string; oid?: string; sample?: string; map?: Record<string, string>; strip?: string; emptyValues?: string[] }[];
};
export function computeSource(source: SourceSpec | undefined, raw: Record<string, unknown> = {}): { ok: true; text: string } | { ok: false; error: string } {
  try {
    if (!source) return { ok: false, error: 'no source' };
    if (source.kind === 'text') return { ok: true, text: String(source.text ?? '') };
    const clean: Record<string, string> = {};
    const mapped: Record<string, string> = {};
    const nums: Record<string, number> = {};
    for (const i of source.inputs || []) {
      const v = raw[i.name];
      if (isEmptyRaw(v, i.emptyValues)) continue;
      let t = String(v).trim();
      if (i.strip) { try { t = t.replace(new RegExp(String(i.strip).slice(0, 120), 'g'), '').replace(/\s{2,}/g, ' ').trim(); } catch { /* bad pattern: leave as is */ } }
      if (t === '') continue;
      clean[i.name] = t;
      mapped[i.name] = i.map && Object.prototype.hasOwnProperty.call(i.map, t) ? String(i.map[t]) : t;
      const n = Number(t); if (Number.isFinite(n)) nums[i.name] = n;
    }
    if (source.kind === 'template') {
      const render = (tpl: string | null | undefined): { ok: true; text: string } | { ok: false; error: string } => {
        let missing: string | null = null;
        // <<name=value|then text|else text>> — pick a text by the (cleaned) value of an input; a missing input takes the else branch
        let out = String(tpl ?? '').replace(/<<\s*([^=|>]+?)\s*=\s*([^|>]*?)\s*\|([^|>]*)\|([^>]*)>>/g, (_m, n: string, v: string, a: string, b: string) => (clean[String(n).trim()] === String(v).trim() ? a : b));
        out = out.replace(/\[\[([^\]]+)\]\]/g, (_m, body: string) => {
          const [expr, fmt, dec] = String(body).split('|').map((x) => x.trim());
          try { return formatNumber(evaluate(expr, nums), fmt || 'none', dec === undefined || dec === '' ? undefined : Number(dec)); }
          catch (e) { missing = missing || (e as Error).message; return ''; }
        });
        out = out.replace(/\{([^}]+)\}/g, (_m, n: string) => {
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
      const r = computeField({ expr: source.expr ?? '', format: source.format, decimals: source.decimals }, clean);
      return r.ok ? { ok: true, text: r.text } : r;
    }
    return { ok: false, error: `unknown source kind ${source.kind}` };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}
