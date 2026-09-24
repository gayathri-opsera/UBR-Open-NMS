'use strict';

/**
 * AES-256-GCM symmetric encryption utilities for credential vault operations.
 *
 * Each encrypt() call produces a self-contained envelope:
 *   { iv, authTag, ciphertext }  (all Base64-encoded)
 *
 * The encryption key is read from the CREDENTIAL_ENCRYPTION_KEY env var.
 * In development, a deterministic 256-bit fallback is used so tests run without
 * the env var — production deployments MUST set CREDENTIAL_ENCRYPTION_KEY to a
 * cryptographically-random 32-byte Base64-encoded value.
 *
 * Security boundary: this module is called only by the credential reference
 * service. Caller is responsible for never logging plaintext or encrypted output.
 */

const crypto = require('crypto');

const ALGORITHM    = 'aes-256-gcm';
const IV_BYTES     = 16; // 128-bit random IV per operation
const AUTH_TAG_LEN = 16; // 128-bit authentication tag

/**
 * Resolve the encryption key from the environment.
 * Validates that it is exactly 32 bytes when decoded from Base64.
 * Falls back to a fixed test key ONLY in development/test environments.
 *
 * @returns {Buffer} 32-byte encryption key
 */
function resolveKey() {
  const raw = process.env.CREDENTIAL_ENCRYPTION_KEY;
  if (raw) {
    const key = Buffer.from(raw, 'base64');
    if (key.length !== 32) {
      throw new Error(
        'CREDENTIAL_ENCRYPTION_KEY must decode to exactly 32 bytes (256 bits). ' +
        `Got ${key.length} bytes. Regenerate using: node -e "require('crypto').randomBytes(32).toString('base64')" `,
      );
    }
    return key;
  }

  // Development/test fallback — deterministic, never suitable for production
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'CREDENTIAL_ENCRYPTION_KEY must be set in production. ' +
      'No fallback key is permitted outside of test/development.',
    );
  }
  return Buffer.alloc(32, 0x42); // 32 bytes of 0x42 for non-production use
}

/**
 * Encrypt a plaintext string with AES-256-GCM.
 *
 * @param {string} plaintext  - The secret value to encrypt (never logged)
 * @returns {{ iv: string, authTag: string, ciphertext: string }} - Base64 envelope
 * @throws {Error} if encryption fails or the key is misconfigured
 */
function encrypt(plaintext) {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new Error('encrypt() requires a non-empty plaintext string');
  }

  const key    = resolveKey();
  const iv     = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LEN });

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);

  return {
    iv:         iv.toString('base64'),
    authTag:    cipher.getAuthTag().toString('base64'),
    ciphertext: encrypted.toString('base64'),
  };
}

/**
 * Decrypt an AES-256-GCM envelope produced by encrypt().
 *
 * @param {{ iv: string, authTag: string, ciphertext: string }} envelope - Base64 envelope
 * @returns {string} Decrypted plaintext
 * @throws {Error} if decryption fails (wrong key, tampered ciphertext, bad IV)
 */
function decrypt(envelope) {
  if (!envelope || !envelope.iv || !envelope.authTag || !envelope.ciphertext) {
    throw new Error('decrypt() requires a valid { iv, authTag, ciphertext } envelope');
  }

  const key      = resolveKey();
  const iv       = Buffer.from(envelope.iv, 'base64');
  const authTag  = Buffer.from(envelope.authTag, 'base64');
  const cipher   = Buffer.from(envelope.ciphertext, 'base64');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LEN });
  decipher.setAuthTag(authTag);

  try {
    return Buffer.concat([decipher.update(cipher), decipher.final()]).toString('utf8');
  } catch (err) {
    // Intentionally vague — do not expose cryptographic details
    throw new Error('Decryption failed: the credential envelope may be corrupted or the key may have changed');
  }
}

module.exports = { encrypt, decrypt };
