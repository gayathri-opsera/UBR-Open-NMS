'use strict';

const authService = require('../../src/services/auth.service');
const ldapService = require('../../src/services/ldap.service');
const jwtService = require('../../src/services/jwt.service');
const sessionService = require('../../src/services/session.service');
const { User } = require('../../src/models/user.model');

jest.mock('../../src/services/ldap.service');
jest.mock('../../src/services/jwt.service');
jest.mock('../../src/services/session.service');
jest.mock('../../src/models/user.model');

describe('auth.service — login', () => {
  const mockUser = {
    _id: { toString: () => 'user-id-1' },
    role: 'operator',
    mfaEnabled: false,
    passwordHash: 'hashed',
    isLockedOut: jest.fn(() => false),
    verifyPassword: jest.fn(async () => true),
    isLdapUser: true,
    save: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    sessionService.getFailedAttempts.mockResolvedValue(0);
    sessionService.clearFailedAttempts.mockResolvedValue();
    sessionService.createSession.mockResolvedValue('session-id-1');
    sessionService.recordFailedAttempt.mockResolvedValue({ locked: false, attempts: 1 });
    jwtService.generateAccessToken.mockReturnValue('access-token');
    jwtService.generateRefreshToken.mockReturnValue('refresh-token');
    jwtService.generateMfaChallengeToken.mockReturnValue('mfa-challenge-token');
    // Default: findOne returns user (LDAP shadow), findById returns user (MFA check)
    User.findOne.mockResolvedValue(mockUser);
    User.findById.mockReturnValue({ select: jest.fn().mockResolvedValue(mockUser) });
    User.findByIdAndUpdate.mockResolvedValue({});
  });

  test('successful LDAP auth returns tokens and role', async () => {
    ldapService.authenticate.mockResolvedValue({ dn: 'uid=alice', mail: 'alice@test.com' });
    ldapService.isOpen.mockReturnValue(false);

    const result = await authService.login('alice', 'Password1!', '10.0.0.1', 'test-agent');

    expect(result).toMatchObject({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      role: 'operator',
    });
    expect(result.expiresIn).toBeGreaterThan(0);
  });

  test('LDAP circuit open — falls back to local MongoDB', async () => {
    ldapService.isOpen.mockReturnValue(true);
    const openCircuitErr = new Error('Circuit open');
    openCircuitErr.name = 'OpenCircuitError';
    ldapService.authenticate.mockRejectedValue(openCircuitErr);

    const result = await authService.login('alice', 'Password1!', '10.0.0.1', 'ua');
    expect(result.accessToken).toBe('access-token');
  });

  test('invalid LDAP credentials triggers failure recording and throws', async () => {
    ldapService.isOpen.mockReturnValue(false);
    const credErr = new Error('Invalid credentials');
    credErr.code = 'INVALID_CREDENTIALS';
    ldapService.authenticate.mockRejectedValue(credErr);

    await expect(authService.login('alice', 'wrong', '10.0.0.1', 'ua')).rejects.toMatchObject({
      code: 'INVALID_CREDENTIALS',
    });
    expect(sessionService.recordFailedAttempt).toHaveBeenCalled();
  });

  test('account locked when failed attempts at maximum', async () => {
    // config.password.maxFailedAttempts defaults to 100 (MAX_FAILED_ATTEMPTS env)
    sessionService.getFailedAttempts.mockResolvedValue(100);

    await expect(authService.login('alice', 'any', '10.0.0.1', 'ua')).rejects.toMatchObject({
      code: 'ACCOUNT_LOCKED',
    });
    expect(ldapService.authenticate).not.toHaveBeenCalled();
  });

  test('MFA enabled — returns mfaRequired + mfaToken instead of accessToken', async () => {
    ldapService.authenticate.mockResolvedValue({ dn: 'uid=alice', mail: 'alice@test.com' });
    ldapService.isOpen.mockReturnValue(false);
    // Simulate user with MFA enabled
    const mfaUser = { ...mockUser, mfaEnabled: true };
    User.findOne.mockResolvedValue(mfaUser);
    User.findById.mockReturnValue({ select: jest.fn().mockResolvedValue(mfaUser) });

    const result = await authService.login('alice', 'Password1!', '10.0.0.1', 'ua');

    expect(result.mfaRequired).toBe(true);
    expect(result.mfaToken).toBe('mfa-challenge-token');
    expect(result.mfaTokenExpiresIn).toBe(300);
    // Must NOT return full access token
    expect(result.accessToken).toBeUndefined();
    expect(result.refreshToken).toBeUndefined();
    // Session must NOT be created yet
    expect(sessionService.createSession).not.toHaveBeenCalled();
  });

  test('MFA disabled — returns accessToken directly (no MFA gate)', async () => {
    ldapService.authenticate.mockResolvedValue({ dn: 'uid=alice', mail: 'alice@test.com' });
    ldapService.isOpen.mockReturnValue(false);
    // Default mockUser has mfaEnabled: false
    const result = await authService.login('alice', 'Password1!', '10.0.0.1', 'ua');
    expect(result.accessToken).toBe('access-token');
    expect(result.mfaRequired).toBeUndefined();
  });

  test('session limit exceeded propagates correctly', async () => {
    ldapService.authenticate.mockResolvedValue({ dn: 'uid=alice', mail: 'alice@test.com' });
    ldapService.isOpen.mockReturnValue(false);
    sessionService.createSession.mockRejectedValue(
      Object.assign(new Error('Session limit'), { code: 'SESSION_LIMIT_EXCEEDED' })
    );

    await expect(authService.login('alice', 'Password1!', '10.0.0.1', 'ua')).rejects.toMatchObject({
      code: 'SESSION_LIMIT_EXCEEDED',
    });
  });
});

describe('auth.service — refresh', () => {
  beforeEach(() => jest.clearAllMocks());

  test('returns new tokens on valid refresh token', async () => {
    sessionService.validateAndRotateRefreshToken.mockResolvedValue({
      userId: 'u1',
      role: 'admin',
      sessionId: 's1',
    });
    jwtService.generateAccessToken.mockReturnValue('new-access');
    jwtService.generateRefreshToken.mockReturnValue('new-refresh');

    const result = await authService.refresh('old-token');
    expect(result.accessToken).toBe('new-access');
    expect(result.refreshToken).toBe('new-refresh');
  });

  test('throws INVALID_REFRESH_TOKEN when token not found', async () => {
    sessionService.validateAndRotateRefreshToken.mockResolvedValue(null);

    await expect(authService.refresh('bad-token')).rejects.toMatchObject({
      code: 'INVALID_REFRESH_TOKEN',
    });
  });
});

describe('auth.service — logout', () => {
  test('calls destroySession with the refresh token', async () => {
    sessionService.destroySession.mockResolvedValue();
    await authService.logout('rt', 'uid', 'uname');
    expect(sessionService.destroySession).toHaveBeenCalledWith('rt');
  });
});
