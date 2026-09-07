'use strict';

jest.mock('../../src/models/user.model');
jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), maskPii: jest.fn(x => x),
}));

const passwordPolicyService = require('../../src/services/password_policy.service');
const { User } = require('../../src/models/user.model');

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ── evaluatePasswordAge ────────────────────────────────────────────────────────

describe('evaluatePasswordAge', () => {
  const { evaluatePasswordAge, PASSWORD_MAX_AGE_DAYS, PASSWORD_WARNING_DAYS } = passwordPolicyService;

  test('fresh password is not expired and not in warning', () => {
    const freshDate = new Date(Date.now() - 10 * MS_PER_DAY);
    const result = evaluatePasswordAge(freshDate);
    expect(result.expired).toBe(false);
    expect(result.warning).toBe(false);
    expect(result.daysRemaining).toBeGreaterThan(0);
  });

  test('password exactly at max age is expired', () => {
    const expiredDate = new Date(Date.now() - PASSWORD_MAX_AGE_DAYS * MS_PER_DAY - 1000);
    const result = evaluatePasswordAge(expiredDate);
    expect(result.expired).toBe(true);
    expect(result.warning).toBe(false);
  });

  test('password in warning window is not expired but warns', () => {
    // 3 days before expiry falls within default 7-day warning window
    const warningDate = new Date(Date.now() - (PASSWORD_MAX_AGE_DAYS - 3) * MS_PER_DAY);
    const result = evaluatePasswordAge(warningDate);
    expect(result.expired).toBe(false);
    expect(result.warning).toBe(true);
    expect(result.daysRemaining).toBeLessThanOrEqual(PASSWORD_WARNING_DAYS);
  });

  test('null passwordChangedAt treated as expired (safe default for legacy users)', () => {
    const result = evaluatePasswordAge(null);
    expect(result.expired).toBe(true);
  });

  test('expiresAt is calculated correctly from change date', () => {
    const changeDate = new Date(Date.now() - 10 * MS_PER_DAY);
    const result = evaluatePasswordAge(changeDate);
    const expectedExpiry = new Date(changeDate.getTime() + PASSWORD_MAX_AGE_DAYS * MS_PER_DAY);
    expect(result.expiresAt.getTime()).toBeCloseTo(expectedExpiry.getTime(), -3);
  });
});

// ── isExemptFromLocalPolicy ────────────────────────────────────────────────────

describe('isExemptFromLocalPolicy', () => {
  const { isExemptFromLocalPolicy } = passwordPolicyService;

  test('LDAP user with no local password is exempt', () => {
    expect(isExemptFromLocalPolicy({ isLdapUser: true, passwordHash: null })).toBe(true);
  });

  test('user with no passwordHash (SSO-provisioned) is exempt', () => {
    expect(isExemptFromLocalPolicy({ isLdapUser: false, passwordHash: null })).toBe(true);
  });

  test('local user with passwordHash is not exempt', () => {
    expect(isExemptFromLocalPolicy({ isLdapUser: false, passwordHash: '$2b$12$...' })).toBe(false);
  });

  test('LDAP user WITH local fallback password is not exempt', () => {
    expect(isExemptFromLocalPolicy({ isLdapUser: true, passwordHash: '$2b$12$...' })).toBe(false);
  });

  test('null user returns false', () => {
    expect(isExemptFromLocalPolicy(null)).toBe(false);
  });
});

// ── checkPasswordPolicy ────────────────────────────────────────────────────────

describe('checkPasswordPolicy', () => {
  const { checkPasswordPolicy, PASSWORD_MAX_AGE_DAYS } = passwordPolicyService;

  beforeEach(() => jest.clearAllMocks());

  function stubUser(overrides) {
    const user = {
      _id: 'user-001',
      isLdapUser: false,
      passwordHash: '$2b$12$hash',
      passwordChangedAt: null,
      passwordResetRequired: false,
      ...overrides,
    };
    User.findById.mockReturnValue({
      select: jest.fn().mockResolvedValue(user),
    });
    return user;
  }

  test('user not found throws USER_NOT_FOUND', async () => {
    User.findById.mockReturnValue({ select: jest.fn().mockResolvedValue(null) });
    await expect(checkPasswordPolicy('missing-user')).rejects.toMatchObject({ code: 'USER_NOT_FOUND' });
  });

  test('fresh password returns status ok', async () => {
    stubUser({ passwordChangedAt: new Date(Date.now() - 10 * MS_PER_DAY) });
    const result = await checkPasswordPolicy('user-001');
    expect(result.status).toBe('ok');
  });

  test('expired password returns status expired', async () => {
    stubUser({ passwordChangedAt: new Date(Date.now() - (PASSWORD_MAX_AGE_DAYS + 1) * MS_PER_DAY) });
    const result = await checkPasswordPolicy('user-001');
    expect(result.status).toBe('expired');
    expect(result.reason).toBe('PASSWORD_EXPIRED');
  });

  test('admin-reset required returns status expired with ADMIN_RESET_REQUIRED reason', async () => {
    stubUser({
      passwordChangedAt: new Date(Date.now() - 5 * MS_PER_DAY),
      passwordResetRequired: true,
    });
    const result = await checkPasswordPolicy('user-001');
    expect(result.status).toBe('expired');
    expect(result.reason).toBe('ADMIN_RESET_REQUIRED');
  });

  test('LDAP user with no local password returns ok (exempt)', async () => {
    stubUser({ isLdapUser: true, passwordHash: null });
    const result = await checkPasswordPolicy('user-001');
    expect(result.status).toBe('ok');
  });

  test('SSO-provisioned user with no passwordHash returns ok (exempt)', async () => {
    stubUser({ isLdapUser: false, passwordHash: null });
    const result = await checkPasswordPolicy('user-001');
    expect(result.status).toBe('ok');
  });

  test('legacy user with null passwordChangedAt is treated as expired', async () => {
    stubUser({ passwordChangedAt: null });
    const result = await checkPasswordPolicy('user-001');
    expect(result.status).toBe('expired');
  });
});

// ── renewPassword ─────────────────────────────────────────────────────────────

describe('renewPassword', () => {
  beforeEach(() => jest.clearAllMocks());

  const makeUser = (overrides = {}) => ({
    _id: 'user-002',
    isLdapUser: false,
    passwordHash: '$2b$12$hash',
    passwordResetRequired: false,
    verifyPassword: jest.fn().mockResolvedValue(true),
    setPassword: jest.fn().mockResolvedValue(undefined),
    save: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  });

  function stubUserFind(user) {
    User.findById.mockReturnValue({
      select: jest.fn().mockResolvedValue(user),
    });
  }

  test('successful renewal updates password and clears reset flag', async () => {
    const user = makeUser();
    stubUserFind(user);

    const result = await passwordPolicyService.renewPassword('user-002', 'NewP@ss123!', 'OldP@ss123!');
    expect(user.setPassword).toHaveBeenCalledWith('NewP@ss123!');
    expect(user.passwordResetRequired).toBe(false);
    expect(user.save).toHaveBeenCalled();
  });

  test('incorrect current password throws INVALID_CURRENT_PASSWORD', async () => {
    const user = makeUser({ verifyPassword: jest.fn().mockResolvedValue(false) });
    stubUserFind(user);

    await expect(
      passwordPolicyService.renewPassword('user-002', 'NewP@ss123!', 'WrongOld!')
    ).rejects.toMatchObject({ code: 'INVALID_CURRENT_PASSWORD' });
  });

  test('missing newPassword complexity throws PASSWORD_COMPLEXITY_VIOLATION', async () => {
    const user = makeUser();
    stubUserFind(user);

    await expect(
      passwordPolicyService.renewPassword('user-002', 'weak', 'OldP@ss123!')
    ).rejects.toMatchObject({ code: 'PASSWORD_COMPLEXITY_VIOLATION' });
  });

  test('LDAP-only user cannot use local renewal endpoint', async () => {
    const user = makeUser({ isLdapUser: true, passwordHash: null });
    stubUserFind(user);

    await expect(
      passwordPolicyService.renewPassword('user-002', 'NewP@ss123!', undefined)
    ).rejects.toMatchObject({ code: 'POLICY_EXEMPT_USER', status: 403 });
  });

  test('admin-reset user can renew without current password', async () => {
    const user = makeUser({ passwordResetRequired: true });
    stubUserFind(user);

    await passwordPolicyService.renewPassword('user-002', 'NewP@ss123!', undefined);
    expect(user.setPassword).toHaveBeenCalledWith('NewP@ss123!');
    expect(user.verifyPassword).not.toHaveBeenCalled();
  });

  test('user not found throws USER_NOT_FOUND', async () => {
    User.findById.mockReturnValue({ select: jest.fn().mockResolvedValue(null) });
    await expect(
      passwordPolicyService.renewPassword('no-user', 'NewP@ss123!', 'OldP@ss123!')
    ).rejects.toMatchObject({ code: 'USER_NOT_FOUND' });
  });
});
