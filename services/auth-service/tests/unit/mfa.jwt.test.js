'use strict';

const jwtService = require('../../src/services/jwt.service');

describe('jwtService — MFA challenge tokens', () => {
  const userId   = 'user-abc';
  const username = 'alice';
  const role     = 'operator';

  test('generateMfaChallengeToken returns a non-empty string', () => {
    const token = jwtService.generateMfaChallengeToken(userId, username, role);
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(20);
  });

  test('verifyMfaChallengeToken decodes a valid token with correct claims', () => {
    const token = jwtService.generateMfaChallengeToken(userId, username, role);
    const payload = jwtService.verifyMfaChallengeToken(token);

    expect(payload).not.toBeNull();
    expect(payload.sub).toBe(userId);
    expect(payload.username).toBe(username);
    expect(payload.role).toBe(role);
    expect(payload.mfa).toBe(true);
  });

  test('verifyMfaChallengeToken returns null for a tampered token', () => {
    const token = jwtService.generateMfaChallengeToken(userId, username, role);
    const tampered = token.slice(0, -5) + 'XXXXX';
    const result = jwtService.verifyMfaChallengeToken(tampered);
    expect(result).toBeNull();
  });

  test('verifyMfaChallengeToken returns null for an expired token', async () => {
    // Sign a token with 1-second TTL
    const jwt = require('jsonwebtoken');
    const shortToken = jwt.sign(
      { sub: userId, username, role, mfa: true },
      'mfa-challenge-dev-secret-change-in-prod',
      { expiresIn: 1, issuer: 'ubr-nms-mfa' }
    );
    // Wait for it to expire
    await new Promise((r) => setTimeout(r, 1100));
    const result = jwtService.verifyMfaChallengeToken(shortToken);
    expect(result).toBeNull();
  });

  test('verifyMfaChallengeToken returns null when mfa flag is missing', () => {
    const jwt = require('jsonwebtoken');
    const tokenWithoutFlag = jwt.sign(
      { sub: userId, username, role }, // no mfa: true
      'mfa-challenge-dev-secret-change-in-prod',
      { expiresIn: 300, issuer: 'ubr-nms-mfa' }
    );
    const result = jwtService.verifyMfaChallengeToken(tokenWithoutFlag);
    expect(result).toBeNull();
  });

  test('verifyMfaChallengeToken returns null for a regular RS256 access token', () => {
    // generateAccessToken requires RS256 keys — use a random string to simulate
    const jwt = require('jsonwebtoken');
    const fakeAccessToken = jwt.sign(
      { sub: userId, role },
      'some-other-secret',
      { expiresIn: 900 }
    );
    const result = jwtService.verifyMfaChallengeToken(fakeAccessToken);
    expect(result).toBeNull();
  });
});
