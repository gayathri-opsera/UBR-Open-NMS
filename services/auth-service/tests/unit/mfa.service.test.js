'use strict';

// ── Mock speakeasy and qrcode BEFORE requiring mfa.service ────────────────────
const mockSpeakeasy = {
  generateSecret: jest.fn(() => ({
    base32: 'MOCKED_SECRET_BASE32',
    otpauth_url: 'otpauth://totp/UBR-NMS:testuser?secret=MOCKED_SECRET_BASE32&issuer=UBR-NMS',
  })),
  totp: {
    verify: jest.fn(() => true),
    generate: jest.fn(() => '123456'),
  },
};

jest.mock('speakeasy', () => mockSpeakeasy);
jest.mock('qrcode', () => ({ toDataURL: jest.fn(async () => 'data:image/png;base64,MOCK_QR') }));
jest.mock('../../src/models/user.model');
jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(),
}));

const mfaService = require('../../src/services/mfa.service');
const { User } = require('../../src/models/user.model');

function makeUser(overrides = {}) {
  return {
    _id: 'user-123',
    username: 'testuser',
    mfaEnabled: false,
    mfaPendingSecret: null,
    mfaSecret: null,
    mfaEnabledAt: null,
    ...overrides,
  };
}

// ── setupMfa ──────────────────────────────────────────────────────────────────
describe('mfaService.setupMfa', () => {
  beforeEach(() => jest.clearAllMocks());

  test('generates a secret, QR code, and stores mfaPendingSecret', async () => {
    User.findByIdAndUpdate.mockResolvedValue({});

    const result = await mfaService.setupMfa('user-123', 'testuser');

    expect(result.qrCodeDataUrl).toBe('data:image/png;base64,MOCK_QR');
    expect(result.secret).toBe('MOCKED_SECRET_BASE32');
    expect(result.otpAuthUrl).toContain('otpauth://totp/');
    expect(result.otpAuthUrl).toContain('UBR-NMS');
    expect(mockSpeakeasy.generateSecret).toHaveBeenCalledWith(
      expect.objectContaining({ length: 20, issuer: 'UBR-NMS' })
    );
    expect(User.findByIdAndUpdate).toHaveBeenCalledWith(
      'user-123',
      expect.objectContaining({ mfaPendingSecret: 'MOCKED_SECRET_BASE32' })
    );
  });
});

// ── enableMfa ─────────────────────────────────────────────────────────────────
describe('mfaService.enableMfa', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSpeakeasy.totp.verify.mockReturnValue(true);
  });

  test('activates MFA when OTP is valid', async () => {
    User.findById.mockReturnValue({
      select: jest.fn().mockResolvedValue(
        makeUser({ mfaPendingSecret: 'MOCKED_SECRET_BASE32' })
      ),
    });
    User.findByIdAndUpdate.mockResolvedValue({});

    const result = await mfaService.enableMfa('user-123', '123456');

    expect(result).toBe(true);
    expect(mockSpeakeasy.totp.verify).toHaveBeenCalledWith({ secret: 'MOCKED_SECRET_BASE32', encoding: 'base32', token: '123456', window: 1 });
    expect(User.findByIdAndUpdate).toHaveBeenCalledWith(
      'user-123',
      expect.objectContaining({
        mfaEnabled: true,
        mfaSecret: 'MOCKED_SECRET_BASE32',
        mfaPendingSecret: null,
      })
    );
  });

  test('throws INVALID_OTP when authenticator.verify returns false', async () => {
    mockSpeakeasy.totp.verify.mockReturnValue(false);
    User.findById.mockReturnValue({
      select: jest.fn().mockResolvedValue(
        makeUser({ mfaPendingSecret: 'MOCKED_SECRET_BASE32' })
      ),
    });

    await expect(mfaService.enableMfa('user-123', '000000')).rejects.toMatchObject({
      code: 'INVALID_OTP',
      status: 401,
    });
  });

  test('throws MFA_NOT_INITIATED when no pending secret', async () => {
    User.findById.mockReturnValue({
      select: jest.fn().mockResolvedValue(makeUser({ mfaPendingSecret: null })),
    });

    await expect(mfaService.enableMfa('user-123', '123456')).rejects.toMatchObject({
      code: 'MFA_NOT_INITIATED',
      status: 400,
    });
  });

  test('throws MFA_ALREADY_ENABLED when MFA is already active', async () => {
    User.findById.mockReturnValue({
      select: jest.fn().mockResolvedValue(
        makeUser({ mfaEnabled: true, mfaPendingSecret: 'MOCKED_SECRET_BASE32' })
      ),
    });

    await expect(mfaService.enableMfa('user-123', '123456')).rejects.toMatchObject({
      code: 'MFA_ALREADY_ENABLED',
      status: 409,
    });
  });

  test('throws USER_NOT_FOUND for unknown user', async () => {
    User.findById.mockReturnValue({ select: jest.fn().mockResolvedValue(null) });

    await expect(mfaService.enableMfa('ghost', '123456')).rejects.toMatchObject({
      code: 'USER_NOT_FOUND',
      status: 404,
    });
  });
});

// ── verifyOtp ─────────────────────────────────────────────────────────────────
describe('mfaService.verifyOtp', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSpeakeasy.totp.verify.mockReturnValue(true);
  });

  test('returns true for a valid OTP', async () => {
    User.findById.mockReturnValue({
      select: jest.fn().mockResolvedValue(
        makeUser({ mfaEnabled: true, mfaSecret: 'MOCKED_SECRET_BASE32' })
      ),
    });

    const result = await mfaService.verifyOtp('user-123', '123456');
    expect(result).toBe(true);
    expect(mockSpeakeasy.totp.verify).toHaveBeenCalledWith({ secret: 'MOCKED_SECRET_BASE32', encoding: 'base32', token: '123456', window: 1 });
  });

  test('throws INVALID_OTP when authenticator.verify returns false', async () => {
    mockSpeakeasy.totp.verify.mockReturnValue(false);
    User.findById.mockReturnValue({
      select: jest.fn().mockResolvedValue(
        makeUser({ mfaEnabled: true, mfaSecret: 'MOCKED_SECRET_BASE32' })
      ),
    });

    await expect(mfaService.verifyOtp('user-123', '000000')).rejects.toMatchObject({
      code: 'INVALID_OTP',
      status: 401,
    });
  });

  test('throws MFA_NOT_ENABLED when mfaEnabled is false', async () => {
    User.findById.mockReturnValue({
      select: jest.fn().mockResolvedValue(makeUser({ mfaEnabled: false })),
    });

    await expect(mfaService.verifyOtp('user-123', '123456')).rejects.toMatchObject({
      code: 'MFA_NOT_ENABLED',
      status: 400,
    });
  });

  test('throws USER_NOT_FOUND for unknown user', async () => {
    User.findById.mockReturnValue({ select: jest.fn().mockResolvedValue(null) });

    await expect(mfaService.verifyOtp('ghost', '123456')).rejects.toMatchObject({
      code: 'USER_NOT_FOUND',
      status: 404,
    });
  });
});

// ── disableMfa ────────────────────────────────────────────────────────────────
describe('mfaService.disableMfa', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSpeakeasy.totp.verify.mockReturnValue(true);
  });

  test('disables MFA when OTP is valid', async () => {
    User.findById.mockReturnValue({
      select: jest.fn().mockResolvedValue(
        makeUser({ mfaEnabled: true, mfaSecret: 'MOCKED_SECRET_BASE32' })
      ),
    });
    User.findByIdAndUpdate.mockResolvedValue({});

    const result = await mfaService.disableMfa('user-123', '123456', false);
    expect(result).toBe(true);
    expect(User.findByIdAndUpdate).toHaveBeenCalledWith(
      'user-123',
      expect.objectContaining({ mfaEnabled: false, mfaSecret: null })
    );
  });

  test('admin override disables MFA without OTP verification', async () => {
    User.findById.mockReturnValue({
      select: jest.fn().mockResolvedValue(
        makeUser({ mfaEnabled: true, mfaSecret: 'MOCKED_SECRET_BASE32' })
      ),
    });
    User.findByIdAndUpdate.mockResolvedValue({});

    const result = await mfaService.disableMfa('user-123', null, true);
    expect(result).toBe(true);
    // authenticator.verify must NOT be called in admin override path
    expect(mockSpeakeasy.totp.verify).not.toHaveBeenCalled();
  });

  test('throws INVALID_OTP when OTP is wrong and no admin override', async () => {
    mockSpeakeasy.totp.verify.mockReturnValue(false);
    User.findById.mockReturnValue({
      select: jest.fn().mockResolvedValue(
        makeUser({ mfaEnabled: true, mfaSecret: 'MOCKED_SECRET_BASE32' })
      ),
    });

    await expect(mfaService.disableMfa('user-123', '000000', false)).rejects.toMatchObject({
      code: 'INVALID_OTP',
      status: 401,
    });
  });

  test('throws MFA_NOT_ENABLED when MFA is already off', async () => {
    User.findById.mockReturnValue({
      select: jest.fn().mockResolvedValue(makeUser({ mfaEnabled: false })),
    });

    await expect(mfaService.disableMfa('user-123', '123456', false)).rejects.toMatchObject({
      code: 'MFA_NOT_ENABLED',
      status: 400,
    });
  });
});

// ── getMfaStatus ──────────────────────────────────────────────────────────────
describe('mfaService.getMfaStatus', () => {
  beforeEach(() => jest.clearAllMocks());

  test('returns mfaEnabled=false and mfaEnabledAt=null when MFA is off', async () => {
    User.findById.mockReturnValue({
      select: jest.fn().mockResolvedValue({ mfaEnabled: false, mfaEnabledAt: null }),
    });

    const result = await mfaService.getMfaStatus('user-123');
    expect(result).toEqual({ mfaEnabled: false, mfaEnabledAt: null });
  });

  test('returns mfaEnabled=true and mfaEnabledAt date when MFA is on', async () => {
    const date = new Date('2026-01-15');
    User.findById.mockReturnValue({
      select: jest.fn().mockResolvedValue({ mfaEnabled: true, mfaEnabledAt: date }),
    });

    const result = await mfaService.getMfaStatus('user-123');
    expect(result).toEqual({ mfaEnabled: true, mfaEnabledAt: date });
  });

  test('throws USER_NOT_FOUND for unknown user', async () => {
    User.findById.mockReturnValue({ select: jest.fn().mockResolvedValue(null) });

    await expect(mfaService.getMfaStatus('ghost')).rejects.toMatchObject({
      code: 'USER_NOT_FOUND',
      status: 404,
    });
  });
});
