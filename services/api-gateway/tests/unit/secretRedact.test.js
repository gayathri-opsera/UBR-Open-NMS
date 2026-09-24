'use strict';

/**
 * WO-005 Unit tests: secretRedact.js
 *
 * Validates recursive redaction of sensitive object fields and detection of
 * credential-like content in Product Definition payloads (JSON, string, nested).
 */

const {
  redactObject,
  detectCredentialMaterial,
  REDACTED,
} = require('../../src/utils/secretRedact');

// ── redactObject ───────────────────────────────────────────────────────────────

describe('redactObject — recursive sensitive field removal', () => {
  it('redacts top-level password key', () => {
    const obj = { username: 'admin', password: 'my-secret' };
    const result = redactObject(obj);
    expect(result.username).toBe('admin');
    expect(result.password).toBe(REDACTED);
  });

  it('redacts top-level community key (SNMP)', () => {
    const obj = { community: 'public', ipAddress: '10.0.0.1' };
    const result = redactObject(obj);
    expect(result.community).toBe(REDACTED);
    expect(result.ipAddress).toBe('10.0.0.1');
  });

  it('redacts nested password in deep object', () => {
    // Note: key named "credentials" is itself sensitive and the whole object is redacted.
    // Use a non-sensitive container key to test nested recursion.
    const obj = { device: { connection: { username: 'r', password: 'hunter2' } } };
    const result = redactObject(obj);
    expect(result.device.connection.username).toBe('r');
    expect(result.device.connection.password).toBe(REDACTED);
  });

  it('redacts entire value of a "credentials" key (the key itself is sensitive)', () => {
    const obj = { device: { credentials: { username: 'r', password: 'hunter2' } } };
    const result = redactObject(obj);
    // "credentials" key matches /^credentials?$/ — the whole nested object is redacted
    expect(result.device.credentials).toBe(REDACTED);
  });

  it('redacts secret field', () => {
    const result = redactObject({ secret: 'abc123', name: 'x' });
    expect(result.secret).toBe(REDACTED);
    expect(result.name).toBe('x');
  });

  it('redacts token field', () => {
    const result = redactObject({ token: 'Bearer xyz', label: 'api' });
    expect(result.token).toBe(REDACTED);
    expect(result.label).toBe('api');
  });

  it('redacts encryptedSecret field', () => {
    const result = redactObject({ encryptedSecret: { iv: 'xxx', authTag: 'yyy', ciphertext: 'zzz' }, name: 'y' });
    expect(result.encryptedSecret).toBe(REDACTED);
    expect(result.name).toBe('y');
  });

  it('handles array of objects — redacts each element', () => {
    const arr = [{ password: 'a' }, { apiKey: 'b', label: 'c' }];
    const result = redactObject(arr);
    expect(result[0].password).toBe(REDACTED);
    expect(result[1].apiKey).toBe(REDACTED);
    expect(result[1].label).toBe('c');
  });

  it('passes through safe fields without modification', () => {
    const obj = { credentialRef: 'ref-001', type: 'snmp_v2c', status: 'active' };
    const result = redactObject(obj);
    expect(result).toEqual(obj);
  });

  it('handles null values without throwing', () => {
    expect(() => redactObject(null)).not.toThrow();
    expect(redactObject(null)).toBeNull();
  });

  it('handles primitives without modification', () => {
    expect(redactObject('hello')).toBe('hello');
    expect(redactObject(42)).toBe(42);
    expect(redactObject(true)).toBe(true);
  });

  it('key matching is case-insensitive (mixed-case Password)', () => {
    const result = redactObject({ Password: 'secret', USERNAME: 'admin' });
    expect(result.Password).toBe(REDACTED);
    expect(result.USERNAME).toBe('admin'); // 'username' is not in SENSITIVE_KEY_FRAGMENTS
  });

  it('redacts privateKey field variant', () => {
    const result = redactObject({ privateKey: 'BEGIN RSA PRIVATE KEY' });
    expect(result.privateKey).toBe(REDACTED);
  });

  it('does not mutate the original object', () => {
    const obj = { password: 'secret', name: 'test' };
    const original = JSON.stringify(obj);
    redactObject(obj);
    expect(JSON.stringify(obj)).toBe(original);
  });
});

// ── detectCredentialMaterial ───────────────────────────────────────────────────

describe('detectCredentialMaterial — Product Definition content scanning', () => {
  it('returns null for a clean JSON payload', () => {
    const payload = { type: 'productDefinition', name: 'BTS-v1', parameters: ['oid1', 'oid2'] };
    expect(detectCredentialMaterial(payload)).toBeNull();
  });

  it('detects credential-like key in JSON object', () => {
    const payload = { community: 'public', name: 'test' };
    const hit = detectCredentialMaterial(payload);
    expect(hit).not.toBeNull();
    expect(hit.code).toBe('CREDENTIAL_MATERIAL_NOT_ALLOWED');
    expect(hit.field).toBe('community');
  });

  it('detects nested password key', () => {
    const payload = { metadata: { snmp: { password: 'myPass' } } };
    const hit = detectCredentialMaterial(payload);
    expect(hit).not.toBeNull();
    expect(hit.field).toBe('password');
    expect(hit.location).toContain('snmp.password');
  });

  it('detects credential pattern in XML string (community=public)', () => {
    const xml = '<?xml version="1.0"?><def><snmp community="public"/></def>';
    const hit = detectCredentialMaterial(xml, 'uploadedFile');
    expect(hit).not.toBeNull();
    expect(hit.code).toBe('CREDENTIAL_MATERIAL_NOT_ALLOWED');
  });

  it('detects credential pattern in JSON string (password: secret)', () => {
    const str = '{ "password": "admin123" }';
    const hit = detectCredentialMaterial(str, 'fileContent');
    expect(hit).not.toBeNull();
    expect(hit.code).toBe('CREDENTIAL_MATERIAL_NOT_ALLOWED');
  });

  it('detects bearer token in string', () => {
    const str = 'Authorization: Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.abc.def';
    const hit = detectCredentialMaterial(str, 'header');
    expect(hit).not.toBeNull();
  });

  it('returns null for a clean XML string', () => {
    const xml = '<productDefinition xmlns="urn:nms:productdef:1.0"><name>CPE-v1</name></productDefinition>';
    expect(detectCredentialMaterial(xml, 'file')).toBeNull();
  });

  it('detects credential-like key in array element', () => {
    const arr = [{ label: 'ok' }, { token: 'secret' }];
    const hit = detectCredentialMaterial(arr);
    expect(hit).not.toBeNull();
    expect(hit.field).toBe('token');
  });

  it('handles null payload without throwing', () => {
    expect(() => detectCredentialMaterial(null)).not.toThrow();
    expect(detectCredentialMaterial(null)).toBeNull();
  });

  it('detects api_key key pattern', () => {
    const payload = { api_key: '1234' };
    const hit = detectCredentialMaterial(payload);
    expect(hit).not.toBeNull();
    expect(hit.field).toBe('api_key');
  });

  it('detects private_key key pattern', () => {
    const payload = { device: { private_key: '-----BEGIN' } };
    const hit = detectCredentialMaterial(payload);
    expect(hit).not.toBeNull();
    expect(hit.field).toBe('private_key');
  });
});
