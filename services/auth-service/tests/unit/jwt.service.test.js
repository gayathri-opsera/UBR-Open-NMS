'use strict';

jest.mock('../../src/config', () => ({
  jwt: {
    privateKey: null,
    publicKey: null,
    accessTokenTtl: '15m',
    accessTokenTtlSeconds: 900,
    refreshTokenTtlSeconds: 86400,
    algorithm: 'RS256',
    issuer: 'ubr-nms',
    audience: 'ubr-nms-api',
  },
}));

const jwtService = require('../../src/services/jwt.service');

describe('generateRefreshToken', () => {
  test('generates a 64-char hex string', () => {
    const token = jwtService.generateRefreshToken();
    expect(typeof token).toBe('string');
    expect(token.length).toBe(64);
    expect(/^[0-9a-f]+$/.test(token)).toBe(true);
  });

  test('generates unique tokens', () => {
    const tokens = new Set([...Array(100)].map(() => jwtService.generateRefreshToken()));
    expect(tokens.size).toBe(100);
  });
});

describe('generateAccessToken / verifyAccessToken — RS256', () => {
  let privateKey, publicKey;

  beforeAll(() => {
    // Generate an RSA key pair for tests.
    const { generateKeyPairSync } = require('crypto');
    const kp = generateKeyPairSync('rsa', { modulusLength: 2048 });
    privateKey = kp.privateKey.export({ type: 'pkcs8', format: 'pem' });
    publicKey = kp.publicKey.export({ type: 'spki', format: 'pem' });

    const cfg = require('../../src/config');
    cfg.jwt.privateKey = privateKey;
    cfg.jwt.publicKey = publicKey;
  });

  test('generates a JWT and decodes correct claims', () => {
    const token = jwtService.generateAccessToken('user123', 'admin');
    expect(typeof token).toBe('string');

    const decoded = jwtService.verifyAccessToken(token);
    expect(decoded.sub).toBe('user123');
    expect(decoded.role).toBe('admin');
    expect(decoded.iss).toBe('ubr-nms');
    expect(decoded.aud).toBe('ubr-nms-api');
  });

  test('throws on tampered token', () => {
    const token = jwtService.generateAccessToken('user123', 'operator');
    const parts = token.split('.');
    parts[1] = Buffer.from(JSON.stringify({ sub: 'attacker', role: 'admin' })).toString('base64url');
    const tampered = parts.join('.');
    expect(() => jwtService.verifyAccessToken(tampered)).toThrow();
  });

  test('throws when private key is missing', () => {
    const cfg = require('../../src/config');
    const orig = cfg.jwt.privateKey;
    cfg.jwt.privateKey = null;
    expect(() => jwtService.generateAccessToken('u', 'user')).toThrow('JWT_PRIVATE_KEY not configured');
    cfg.jwt.privateKey = orig;
  });
});
