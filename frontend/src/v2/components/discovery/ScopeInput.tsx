/**
 * ScopeInput — reusable textarea for entering SNMP discovery scope.
 *
 * Accepts CIDR blocks, single IPs, IP ranges, and comma-separated combinations.
 * Validates each entry client-side and surfaces inline errors immediately.
 *
 * Security: input is validated strictly to prevent injection of arbitrary
 * strings into the backend scope parser. Only recognised patterns are accepted.
 */
import { useState, useCallback } from 'react';
import { Input } from '../common/Input';

// ── Validation helpers ────────────────────────────────────────────────────────

/** Validates a single scope token. Returns null if valid, error string if invalid. */
function validateToken(token: string): string | null {
  const t = token.trim();
  if (t.length === 0) return null; // filtered out before entry

  // CIDR: e.g. 192.168.0.0/24
  if (t.includes('/')) {
    const [host, prefix] = t.split('/');
    const prefixNum = parseInt(prefix, 10);
    if (!isValidIPv4(host) || isNaN(prefixNum) || prefixNum < 0 || prefixNum > 32) {
      return `"${t}" is not a valid CIDR (e.g. 192.168.1.0/24)`;
    }
    return null;
  }

  // IP range: e.g. 10.0.0.1-10.0.0.50
  if (t.includes('-')) {
    const [start, end] = t.split('-');
    if (!isValidIPv4(start) || !isValidIPv4(end)) {
      return `"${t}" is not a valid IP range (e.g. 10.0.0.1-10.0.0.50)`;
    }
    if (ipToNumber(start) > ipToNumber(end)) {
      return `"${t}": start IP must be before or equal to end IP`;
    }
    return null;
  }

  // Single IPv4
  if (/^\d/.test(t)) {
    if (!isValidIPv4(t)) {
      return `"${t}" is not a valid IPv4 address`;
    }
    return null;
  }

  // Hostname/seed — allow basic hostname characters only
  if (/^[a-zA-Z0-9]([a-zA-Z0-9\-\.]*[a-zA-Z0-9])?$/.test(t)) {
    return null;
  }

  return `"${t}" is not a recognised IP, CIDR, range, or hostname`;
}

function isValidIPv4(ip: string): boolean {
  const parts = ip.split('.');
  if (parts.length !== 4) return false;
  return parts.every((p) => {
    const n = parseInt(p, 10);
    return p !== '' && !isNaN(n) && n >= 0 && n <= 255 && String(n) === p;
  });
}

function ipToNumber(ip: string): number {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0) >>> 0;
}

// ── Component ─────────────────────────────────────────────────────────────────

export interface ScopeInputProps {
  /** Current raw text value (comma-separated). */
  value: string;
  /** Called on every change with the raw text and whether it is currently valid. */
  onChange: (value: string, isValid: boolean) => void;
  /** Whether the input is disabled (e.g. while submitting). */
  disabled?: boolean;
}

/**
 * ScopeInput renders a text input for discovery scope with real-time validation.
 * Valid entries are: CIDR (192.168.0.0/24), single IP, IP range, or hostname.
 * Multiple entries are comma-separated.
 */
export function ScopeInput({ value, onChange, disabled }: ScopeInputProps) {
  const [touched, setTouched] = useState(false);

  const validate = useCallback((raw: string): string | null => {
    const tokens = raw.split(',').map((t) => t.trim()).filter((t) => t.length > 0);
    if (tokens.length === 0) return 'At least one scope entry is required';
    for (const token of tokens) {
      const err = validateToken(token);
      if (err) return err;
    }
    return null;
  }, []);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const raw = e.target.value;
      const err = validate(raw);
      onChange(raw, err === null);
    },
    [validate, onChange],
  );

  const error = touched ? validate(value) ?? undefined : undefined;

  return (
    <Input
      label="Discovery Scope"
      placeholder="192.168.1.0/24, 10.0.0.1, 10.0.0.1-10.0.0.50"
      value={value}
      onChange={handleChange}
      onBlur={() => setTouched(true)}
      error={error}
      hint="Comma-separated CIDRs, IPs, IP ranges, or hostnames"
      disabled={disabled}
      fullWidth
      aria-label="Discovery scope: enter comma-separated CIDRs, IPs, or IP ranges"
    />
  );
}

/** Export validate for direct use in form-level validation. */
export { validateToken as validateScopeToken };
