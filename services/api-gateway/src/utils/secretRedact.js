'use strict';

/**
 * Recursive secret redaction utilities for WO-005.
 *
 * Two concerns:
 *  1. redactObject()  — strip known sensitive keys from any nested JS object before
 *                       sending it to clients or writing it to audit logs.
 *  2. detectCredentialMaterial() — scan a Product Definition payload (string or
 *                       nested object) for credential-like content and return the
 *                       first offending field so the upload can be rejected.
 *
 * Security principle: sensitive keys are denied by an explicit block-list because
 * allowing everything and only blocking known patterns is safer than the reverse —
 * a new field name must be explicitly added to be returned to clients.
 */

const REDACTED = '[REDACTED]';

/**
 * Regex patterns matched against lowercased key names.
 * A key matching ANY pattern will be replaced with [REDACTED].
 *
 * Use specific patterns to avoid false-positives — e.g. "credentialRef" is the
 * safe public identifier, so it must NOT be caught, but raw "credential" should be.
 *
 * Extend this list when new credential types are introduced — do NOT remove
 * entries without a security review.
 */
const SENSITIVE_KEY_PATTERNS = [
  /^password$/,
  /^passwd$/,
  /^secret$/,
  /^community$/,        // SNMP community string
  /private_?key/,       // privateKey, private_key, etc.
  /api_?key/,           // apiKey, api_key
  /auth_?key/,          // authKey, auth_key
  /access_?key/,        // accessKey, access_key
  /^bearer$/,
  /^token$/,
  /^secret_?key/,       // secretKey, secret_key
  /^credentials?$/,     // credential or credentials (exact) — NOT credentialRef
  /encryptedSecret/i,   // encryptedSecret, encrypted_secret
  /^ciphertext$/,
  /key_?material/,
];

// Keep SENSITIVE_KEY_FRAGMENTS as an alias for backward-compat exports
const SENSITIVE_KEY_FRAGMENTS = [
  'password', 'passwd', 'secret', 'community', 'private_key', 'privatekey',
  'api_key', 'apikey', 'bearer', 'token', 'auth_key', 'authkey',
  'access_key', 'accesskey', 'encryptedsecret', 'encrypted_secret', 'ciphertext',
];

/**
 * Regex patterns for detecting credential-like values in plain text or string fields.
 * Used by detectCredentialMaterial() to inspect Product Definition content (XML, XLS, JSON).
 *
 * Patterns handle both:
 *  - Unquoted config format:  community = public
 *  - JSON string format:      "password": "value" or 'password' = 'value'
 */
const CREDENTIAL_VALUE_PATTERNS = [
  // Matches: password = x, "password": "x", password:x (config/XML/JSON formats)
  /["']?password["']?\s*[:=]\s*["']?\S+/i,
  /["']?passwd["']?\s*[:=]\s*["']?\S+/i,
  /["']?community["']?\s*[:=]\s*["']?\S+/i,
  /["']?api[_-]?key["']?\s*[:=]\s*["']?\S+/i,
  /["']?auth[_-]?key["']?\s*[:=]\s*["']?\S+/i,
  /["']?token["']?\s*[:=]\s*["']?\S+/i,
  /["']?secret["']?\s*[:=]\s*["']?\S+/i,
  /["']?private[_-]?key["']?\s*[:=]\s*["']?\S+/i,
  /\bBearer\s+[A-Za-z0-9._\-+/]{20,}/i,
  // Base64 blobs longer than 40 chars that look like encoded credentials
  /(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{40,}={0,2}(?![A-Za-z0-9+/=])/,
];

/**
 * Key patterns for detecting credential-like keys in JSON/object payloads.
 * Returns the matching key name so rejection messages are informative.
 */
const CREDENTIAL_KEY_PATTERNS = [
  /password/i,
  /passwd/i,
  /community/i,
  /api[_-]?key/i,
  /auth[_-]?key/i,
  /access[_-]?key/i,
  /token/i,
  /secret/i,
  /private[_-]?key/i,
  /bearer/i,
  /credential/i,
];

/**
 * Recursively redact sensitive fields from an object or array before returning
 * it in an API response or audit log.
 *
 * @param {*}      value  - Any serialisable value (object, array, string, number)
 * @param {number} depth  - Internal recursion guard; defaults to 0
 * @returns {*} A new object/array with sensitive keys replaced by [REDACTED]
 */
function redactObject(value, depth = 0) {
  // Guard: prevent runaway recursion on circular / deeply-nested structures
  if (depth > 20) return value;

  if (Array.isArray(value)) {
    return value.map((item) => redactObject(item, depth + 1));
  }

  if (value !== null && typeof value === 'object') {
    const result = {};
    for (const [k, v] of Object.entries(value)) {
      const keyLower = k.toLowerCase();
      const isSensitive = SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(keyLower));
      result[k] = isSensitive ? REDACTED : redactObject(v, depth + 1);
    }
    return result;
  }

  return value; // primitives pass through
}

/**
 * Scan a Product Definition payload for credential-like content.
 * Inspects nested objects (JSON), string fields, and XML/plaintext strings.
 *
 * Returns null if the payload is clean, or an object describing the first
 * detected violation:
 *   { field: string, location: string, code: 'CREDENTIAL_MATERIAL_NOT_ALLOWED' }
 *
 * @param {string|object} payload - Raw upload content (parsed JSON, XML string, etc.)
 * @param {string} [location]     - Human-readable path hint for error messages
 * @returns {{ field: string, location: string, code: string }|null}
 */
function detectCredentialMaterial(payload, location = 'root') {
  if (typeof payload === 'string') {
    return detectInString(payload, location);
  }

  if (Array.isArray(payload)) {
    for (let i = 0; i < payload.length; i++) {
      const hit = detectCredentialMaterial(payload[i], `${location}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }

  if (payload !== null && typeof payload === 'object') {
    for (const [k, v] of Object.entries(payload)) {
      // Check if the key itself is credential-like
      if (CREDENTIAL_KEY_PATTERNS.some((re) => re.test(k))) {
        return {
          field:    k,
          location: `${location}.${k}`,
          code:     'CREDENTIAL_MATERIAL_NOT_ALLOWED',
        };
      }
      // Recurse into the value
      const hit = detectCredentialMaterial(v, `${location}.${k}`);
      if (hit) return hit;
    }
    return null;
  }

  return null;
}

/**
 * Scan a plain string (XML body, JSON string value, XLS text cell) for
 * credential-like patterns.
 *
 * @param {string} text     - The string to scan
 * @param {string} location - Human-readable path for error messages
 * @returns {{ field: string, location: string, code: string }|null}
 */
function detectInString(text, location) {
  if (typeof text !== 'string') return null;

  for (const pattern of CREDENTIAL_VALUE_PATTERNS) {
    const match = pattern.exec(text);
    if (match) {
      // Extract only the matched field name prefix (before =/:), never the value
      const raw   = match[0] || '';
      const field = raw.split(/\s*[:=]\s*/)[0].trim() || 'detected-pattern';
      return {
        field:    field,
        location: location,
        code:     'CREDENTIAL_MATERIAL_NOT_ALLOWED',
      };
    }
  }
  return null;
}

module.exports = {
  redactObject,
  detectCredentialMaterial,
  SENSITIVE_KEY_FRAGMENTS,
  CREDENTIAL_KEY_PATTERNS,
  CREDENTIAL_VALUE_PATTERNS,
  REDACTED,
};
