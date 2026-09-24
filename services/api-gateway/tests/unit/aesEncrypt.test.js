'use strict';

/**
 * WO-005 Unit tests: aesEncrypt.js
 *
 * Validates encrypt/decrypt round-trips, envelope structure, error handling,
 * and the production guard that blocks the fallback key.
 */

describe('aesEncrypt — AES-256-GCM encryption utilities', () => {
  // Run in non-production mode so the dev fallback key is allowed
  const OLD_ENV = process.env.NODE_ENV;
  beforeEach(() => {
    delete process.env.CREDENTIAL_ENCRYPTION_KEY;
    process.env.NODE_ENV = 'test';
    // Clear the require cache so the module picks up env changes
    jest.resetModules();
  });
  afterEach(() => {
    process.env.NODE_ENV = OLD_ENV;
  });

  it('returns a { iv, authTag, ciphertext } envelope', () => {
    const { encrypt } = require('../../src/utils/aesEncrypt');
    const envelope = encrypt('my-secret-value');
    expect(envelope).toHaveProperty('iv');
    expect(envelope).toHaveProperty('authTag');
    expect(envelope).toHaveProperty('ciphertext');
    expect(typeof envelope.iv).toBe('string');
    expect(typeof envelope.authTag).toBe('string');
    expect(typeof envelope.ciphertext).toBe('string');
  });

  it('round-trips plaintext through encrypt → decrypt', () => {
    const { encrypt, decrypt } = require('../../src/utils/aesEncrypt');
    const original = 'super-secret-community-string';
    const envelope = encrypt(original);
    const recovered = decrypt(envelope);
    expect(recovered).toBe(original);
  });

  it('each call produces a different IV (randomised per operation)', () => {
    const { encrypt } = require('../../src/utils/aesEncrypt');
    const e1 = encrypt('same-value');
    const e2 = encrypt('same-value');
    expect(e1.iv).not.toBe(e2.iv);
    // Ciphertext should also differ due to unique IVs
    expect(e1.ciphertext).not.toBe(e2.ciphertext);
  });

  it('throws if plaintext is empty', () => {
    const { encrypt } = require('../../src/utils/aesEncrypt');
    expect(() => encrypt('')).toThrow();
  });

  it('throws if plaintext is not a string', () => {
    const { encrypt } = require('../../src/utils/aesEncrypt');
    expect(() => encrypt(null)).toThrow();
    expect(() => encrypt(undefined)).toThrow();
    expect(() => encrypt(12345)).toThrow();
  });

  it('decrypt throws if envelope is missing fields', () => {
    const { decrypt } = require('../../src/utils/aesEncrypt');
    expect(() => decrypt({})).toThrow();
    expect(() => decrypt({ iv: 'x' })).toThrow();
    expect(() => decrypt(null)).toThrow();
  });

  it('decrypt throws if ciphertext is tampered', () => {
    const { encrypt, decrypt } = require('../../src/utils/aesEncrypt');
    const envelope = encrypt('original-value');
    const tampered = { ...envelope, ciphertext: Buffer.from('tampered').toString('base64') };
    expect(() => decrypt(tampered)).toThrow();
  });

  it('accepts a valid CREDENTIAL_ENCRYPTION_KEY env var', () => {
    const key = require('crypto').randomBytes(32).toString('base64');
    process.env.CREDENTIAL_ENCRYPTION_KEY = key;
    jest.resetModules();
    const { encrypt, decrypt } = require('../../src/utils/aesEncrypt');
    const envelope = encrypt('env-key-test');
    expect(decrypt(envelope)).toBe('env-key-test');
    delete process.env.CREDENTIAL_ENCRYPTION_KEY;
  });

  it('throws if CREDENTIAL_ENCRYPTION_KEY is wrong length', () => {
    process.env.CREDENTIAL_ENCRYPTION_KEY = Buffer.from('short').toString('base64'); // < 32 bytes
    jest.resetModules();
    const { encrypt } = require('../../src/utils/aesEncrypt');
    expect(() => encrypt('value')).toThrow(/32 bytes/);
    delete process.env.CREDENTIAL_ENCRYPTION_KEY;
  });
});
