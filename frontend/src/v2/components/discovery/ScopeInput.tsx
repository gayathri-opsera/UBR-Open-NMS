/**
 * ScopeInput — tag-chip input for SNMP discovery scope.
 *
 * Features:
 *  • Tag/chip UI — each scope entry is a removable pill; press Enter or
 *    comma to commit the current text as a new tag.
 *  • Wildcard octets — 10.10.10.*, 192.168.*.* are accepted.
 *  • XLS / XLSX / CSV upload — parses the file, extracts recognised IP /
 *    CIDR / range / wildcard patterns, and bulk-adds them as chips.
 *
 * Security: each token is validated strictly before it is accepted.
 */
import { useState, useCallback, useRef, useId } from 'react';

// ── Validation ─────────────────────────────────────────────────────────────────

function isOctet(s: string): boolean {
  if (s === '*') return true;                       // wildcard octet
  const range = /^(\d{1,3})-(\d{1,3})$/.exec(s);  // octet range 100-120
  if (range) return +range[1] <= 255 && +range[2] <= 255 && +range[1] <= +range[2];
  const n = parseInt(s, 10);
  return s !== '' && !isNaN(n) && n >= 0 && n <= 255 && String(n) === s;
}

function isValidIPv4OrWildcard(ip: string): boolean {
  const parts = ip.split('.');
  if (parts.length === 4) return parts.every(isOctet);
  // short wildcard form: 10.*  /  10.0.*
  return parts.length >= 1 && parts.length < 4 && parts[parts.length - 1] === '*' && parts.every(isOctet);
}

/** Plain (non-wildcard, non-range) dotted quad. */
function isPlainIPv4(ip: string): boolean {
  return /^\d+(\.\d+){3}$/.test(ip) && isValidIPv4OrWildcard(ip);
}

function ipToNumber(ip: string): number {
  return ip.split('.').reduce((acc, o) => (acc << 8) + parseInt(o, 10), 0) >>> 0;
}

/** Validate a single scope token. Returns null if valid, error string if not. */
function validateToken(token: string): string | null {
  const t = token.trim();
  if (!t) return null;

  // CIDR: 192.168.0.0/24
  if (t.includes('/') && !t.includes('*')) {
    const [host, prefix] = t.split('/');
    const p = parseInt(prefix, 10);
    if (!isValidIPv4OrWildcard(host) || isNaN(p) || p < 0 || p > 32)
      return `"${t}" — invalid CIDR (e.g. 192.168.1.0/24)`;
    return null;
  }

  // Full IP range: 10.0.0.1-10.0.0.50 (both ends plain IPv4)
  const full = /^(\d+(?:\.\d+){3})\s*-\s*(\d+(?:\.\d+){3})$/.exec(t);
  if (full) {
    if (!isPlainIPv4(full[1]) || !isPlainIPv4(full[2]))
      return `"${t}" — invalid range (e.g. 10.0.0.1-10.0.0.50)`;
    if (ipToNumber(full[1]) > ipToNumber(full[2]))
      return `"${t}" — start IP must be ≤ end IP`;
    return null;
  }

  // Wildcard / octet range: 10.10.10.*, 192.168.*.*, 10.0.*, 10.0.150.100-120
  if (t.includes('*') || (t.includes('-') && /^[\d.*-]+$/.test(t))) {
    if (isValidIPv4OrWildcard(t)) return null;
    return `"${t}" — invalid wildcard (e.g. 10.10.10.*, 192.168.*.*, 10.0.150.100-120)`;
  }

  // Plain IPv4
  if (/^\d/.test(t)) {
    if (!isValidIPv4OrWildcard(t)) return `"${t}" — invalid IPv4 address`;
    return null;
  }

  // Hostname
  if (/^[a-zA-Z0-9]([a-zA-Z0-9\-.]*[a-zA-Z0-9])?$/.test(t)) return null;

  return `"${t}" — not a recognised IP, CIDR, range, wildcard, or hostname`;
}

/** Extract all plausible scope tokens from a raw string (from XLS cells or paste). */
function extractTokens(raw: string): string[] {
  return raw
    .split(/[\n,;\t\r]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && validateToken(s) === null);
}

// ── Styles ────────────────────────────────────────────────────────────────────

const chipStyle = (isInvalid: boolean): React.CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  padding: '3px 8px 3px 10px',
  borderRadius: 999,
  fontSize: 12,
  fontWeight: 500,
  fontFamily: 'var(--vf-font-mono)',
  background: isInvalid ? 'rgba(239,68,68,0.10)' : 'var(--vf-accent-subtle)',
  color: isInvalid ? 'var(--vf-danger)' : 'var(--vf-accent)',
  border: `1px solid ${isInvalid ? 'rgba(239,68,68,0.3)' : 'rgba(99,102,241,0.25)'}`,
  maxWidth: 220,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  flexShrink: 0,
});

const removeBtn: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  padding: 0,
  color: 'currentColor',
  opacity: 0.6,
  flexShrink: 0,
  lineHeight: 1,
};

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ScopeInputProps {
  /** Current value as comma-separated string (matches existing API surface). */
  value: string;
  /** Called on every change with the raw comma-separated text and validity flag. */
  onChange: (value: string, isValid: boolean) => void;
  disabled?: boolean;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function ScopeInput({ value, onChange, disabled }: ScopeInputProps) {
  const inputId = useId();
  const fileRef = useRef<HTMLInputElement>(null);

  // Parse current value into chip list
  const chips: string[] = value
    ? value.split(',').map((s) => s.trim()).filter(Boolean)
    : [];

  const [inputText, setInputText] = useState('');
  const [inputError, setInputError] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  // ── helpers ──────────────────────────────────────────────────────────────

  function emitChange(newChips: string[]) {
    const raw = newChips.join(', ');
    const isValid = newChips.length > 0 && newChips.every((c) => validateToken(c) === null);
    onChange(raw, isValid);
  }

  function commitInput(raw: string) {
    const token = raw.trim();
    if (!token) return;
    const err = validateToken(token);
    if (err) { setInputError(err); return; }
    if (chips.includes(token)) { setInputText(''); return; }
    emitChange([...chips, token]);
    setInputText('');
    setInputError(null);
  }

  function removeChip(idx: number) {
    emitChange(chips.filter((_, i) => i !== idx));
  }

  // ── keyboard handler ─────────────────────────────────────────────────────

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      commitInput(inputText);
    } else if (e.key === 'Backspace' && inputText === '' && chips.length > 0) {
      removeChip(chips.length - 1);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputText, chips]);

  // Handle paste — split on comma/newline/semicolon and bulk-add all valid tokens
  const onPaste = useCallback((e: React.ClipboardEvent<HTMLInputElement>) => {
    const pasted = e.clipboardData.getData('text');
    if (!pasted.includes(',') && !pasted.includes('\n') && !pasted.includes(';')) return; // single value, let default paste handle it
    e.preventDefault();
    const tokens = extractTokens(pasted);
    if (tokens.length === 0) {
      setInputError('No valid IPs, CIDRs, ranges, or wildcards found in pasted text');
      return;
    }
    const merged = [...new Set([...chips, ...tokens])];
    emitChange(merged);
    setInputText('');
    setInputError(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chips]);

  // ── XLS / CSV upload ─────────────────────────────────────────────────────

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadError(null);
    setUploading(true);

    try {
      const name = file.name.toLowerCase();
      let tokens: string[] = [];

      if (name.endsWith('.csv') || name.endsWith('.txt')) {
        // Plain text / CSV — read as text
        const text = await file.text();
        tokens = extractTokens(text);
      } else {
        // XLSX / XLS — use the xlsx library (already bundled)
        const XLSX = await import('xlsx');
        const buf = await file.arrayBuffer();
        const wb = XLSX.read(buf, { type: 'array' });
        const allText: string[] = [];
        for (const sheetName of wb.SheetNames) {
          const ws = wb.Sheets[sheetName];
          const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: '' });
          for (const row of rows) {
            for (const cell of (row as unknown[])) {
              if (cell != null) allText.push(String(cell));
            }
          }
        }
        tokens = extractTokens(allText.join(','));
      }

      if (tokens.length === 0) {
        setUploadError('No valid IPs, CIDRs, ranges, or wildcards found in the file.');
      } else {
        const merged = [...new Set([...chips, ...tokens])];
        emitChange(merged);
        setUploadError(null);
      }
    } catch (err) {
      setUploadError(`Failed to parse file: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setUploading(false);
      // Reset so the same file can be re-uploaded
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  // ── render ───────────────────────────────────────────────────────────────

  const noChips = chips.length === 0;
  const hasError = inputError || uploadError;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>

      {/* Label row */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <label
          htmlFor={inputId}
          style={{ fontSize: 12, fontWeight: 600, color: 'var(--vf-text-secondary)' }}
        >
          Discovery Scope
        </label>

        {/* Upload button */}
        <button
          type="button"
          disabled={disabled || uploading}
          onClick={() => fileRef.current?.click()}
          title="Upload a list of IPs from an XLS, XLSX, or CSV file"
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 5,
            fontSize: 11, fontWeight: 600,
            padding: '3px 10px',
            borderRadius: 'var(--vf-radius-sm)',
            border: '1px solid var(--vf-border-default)',
            background: 'var(--vf-canvas)',
            color: 'var(--vf-text-secondary)',
            cursor: disabled || uploading ? 'not-allowed' : 'pointer',
            opacity: disabled || uploading ? 0.5 : 1,
            transition: 'background 0.12s, border-color 0.12s',
          }}
        >
          <svg width="12" height="12" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <rect x="2" y="2" width="10" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.4"/>
            <path d="M5 2V1M9 2V1" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
            <path d="M7 5v4M5.5 7l1.5-2 1.5 2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M5 10.5h4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
          </svg>
          {uploading ? 'Importing…' : 'Import XLS / CSV'}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".xls,.xlsx,.csv,.txt"
          style={{ display: 'none' }}
          onChange={handleFile}
        />
      </div>

      {/* Chip container + inline input */}
      <div
        role="group"
        aria-label="Discovery scope entries"
        onClick={() => document.getElementById(inputId)?.focus()}
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: 5,
          minHeight: 42,
          padding: '6px 10px',
          background: 'var(--vf-input-bg)',
          border: `1px solid ${hasError ? 'var(--vf-danger)' : 'var(--vf-border-default)'}`,
          borderRadius: 'var(--vf-radius-md)',
          cursor: 'text',
          transition: 'border-color var(--vf-transition-fast)',
        }}
      >
        {/* Existing chips */}
        {chips.map((chip, idx) => {
          const invalid = validateToken(chip) !== null;
          return (
            <span key={`${chip}-${idx}`} style={chipStyle(invalid)} title={chip}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{chip}</span>
              {!disabled && (
                <button
                  type="button"
                  aria-label={`Remove ${chip}`}
                  onClick={(e) => { e.stopPropagation(); removeChip(idx); }}
                  style={removeBtn}
                >
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                    <path d="M2 2l6 6M8 2L2 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                  </svg>
                </button>
              )}
            </span>
          );
        })}

        {/* Inline text input */}
        <input
          id={inputId}
          type="text"
          value={inputText}
          disabled={disabled}
          placeholder={noChips ? '192.168.1.0/24, 10.0.0.1, 10.10.10.*, 10.0.0.1-10.0.0.50' : 'Add entry…'}
          aria-label="Add scope entry — press Enter or comma to confirm"
          aria-describedby={`${inputId}-hint`}
          onChange={(e) => {
            setInputText(e.target.value);
            setInputError(null);
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onBlur={() => { if (inputText.trim()) commitInput(inputText); }}
          style={{
            flex: '1 1 180px',
            minWidth: 140,
            border: 'none',
            outline: 'none',
            background: 'transparent',
            color: 'var(--vf-text-primary)',
            fontSize: 'var(--vf-type-body-size)',
            fontFamily: 'var(--vf-font-sans)',
            padding: '2px 0',
          }}
        />
      </div>

      {/* Hint / error */}
      <div id={`${inputId}-hint`} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {inputError || uploadError ? (
          <p style={{ margin: 0, fontSize: 11, color: 'var(--vf-danger)', display: 'flex', gap: 4, alignItems: 'flex-start' }}>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true" style={{ flexShrink: 0, marginTop: 1 }}>
              <circle cx="6" cy="6" r="5" stroke="currentColor" strokeWidth="1.3"/>
              <path d="M6 4v2.5M6 8v.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
            </svg>
            {inputError ?? uploadError}
          </p>
        ) : (
          <p style={{ margin: 0, fontSize: 11, color: 'var(--vf-text-muted)' }}>
            Accepts CIDRs, single IPs, ranges, wildcards (<code style={{ fontFamily: 'var(--vf-font-mono)', fontSize: 10 }}>10.10.*.*</code>).
            Press <kbd style={{ fontSize: 10, padding: '1px 4px', borderRadius: 3, border: '1px solid var(--vf-border-default)', background: 'var(--vf-canvas)' }}>Enter</kbd> or{' '}
            <kbd style={{ fontSize: 10, padding: '1px 4px', borderRadius: 3, border: '1px solid var(--vf-border-default)', background: 'var(--vf-canvas)' }}>,</kbd> to add.
          </p>
        )}
        {chips.length > 0 && (
          <p style={{ margin: 0, fontSize: 11, color: 'var(--vf-text-muted)' }}>
            {chips.length} entr{chips.length === 1 ? 'y' : 'ies'} · scope covers{' '}
            <span style={{ fontFamily: 'var(--vf-font-mono)', fontSize: 10 }}>
              {chips.join(', ')}
            </span>
          </p>
        )}
      </div>
    </div>
  );
}

/** Export validate for direct use in form-level validation. */
export { validateToken as validateScopeToken };
