'use strict';

// ── Mocks ─────────────────────────────────────────────────────────────────────
jest.mock('../../src/models/tenant-sso.model');
jest.mock('../../src/models/user.model');
jest.mock('../../src/services/jwt.service');
jest.mock('../../src/services/session.service');
jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(),
}));
jest.mock('../../src/config', () => ({
  jwt: { accessTokenTtlSeconds: 900 },
}));

// Mock passport strategies (avoid loading native extensions in unit tests)
// virtual: true is required when the package is not installed locally
jest.mock('passport-openidconnect', () => ({
  Strategy: jest.fn(),
}), { virtual: true });
jest.mock('@node-saml/passport-saml', () => ({
  SAML: jest.fn().mockImplementation(() => ({
    generateServiceProviderMetadata: jest.fn(() => '<EntityDescriptor/>'),
    getAuthorizeUrl: jest.fn((opts, cb) => cb(null, 'https://idp.example.com/sso?SAMLRequest=xxx')),
    validatePostResponse: jest.fn((params, cb) => cb(null, { nameID: 'user@example.com', email: 'user@example.com' })),
  })),
}), { virtual: true });

const ssoService = require('../../src/services/sso.service');
const { TenantSSO } = require('../../src/models/tenant-sso.model');
const { User } = require('../../src/models/user.model');
const jwtService = require('../../src/services/jwt.service');
const sessionService = require('../../src/services/session.service');

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeTenantConfig(overrides = {}) {
  return {
    tenantId: 'tenant-a',
    providerType: 'oidc',
    enabled: true,
    localFallbackEnabled: true,
    displayName: 'Test Tenant',
    oidc: {
      discoveryUrl: 'https://idp.example.com/.well-known/openid-configuration',
      clientId: 'client-abc',
      clientSecretRef: 'IDP_CLIENT_SECRET',
      callbackUrl: 'https://nms.example.com/sso/callback/oidc',
      scopes: ['openid', 'email', 'profile'],
    },
    saml: {
      entryPoint: 'https://idp.example.com/sso/saml',
      issuer: 'urn:ubr-nms',
      cert: 'MOCK_CERT',
      callbackUrl: 'https://nms.example.com/sso/callback/saml',
    },
    claimMapping: { email: 'email', username: 'preferred_username', role: 'role' },
    defaultRole: 'user',
    toJSON() { return this; },
    ...overrides,
  };
}

function makeRedis(stored = null) {
  return {
    setex: jest.fn(async () => 'OK'),
    get: jest.fn(async () => stored),
    del: jest.fn(async () => 1),
  };
}

// ── getTenantConfig ───────────────────────────────────────────────────────────

describe('ssoService.getTenantConfig', () => {
  beforeEach(() => jest.clearAllMocks());

  test('returns null for unknown tenant', async () => {
    TenantSSO.findOne.mockResolvedValue(null);
    const result = await ssoService.getTenantConfig('unknown');
    expect(result).toBeNull();
  });

  test('returns config for known tenant', async () => {
    const cfg = makeTenantConfig();
    TenantSSO.findOne.mockResolvedValue(cfg);
    const result = await ssoService.getTenantConfig('tenant-a');
    expect(result.tenantId).toBe('tenant-a');
  });
});

// ── initiateOIDC ──────────────────────────────────────────────────────────────

describe('ssoService.initiateOIDC', () => {
  beforeEach(() => jest.clearAllMocks());

  test('returns an authorization URL and stores state in Redis', async () => {
    const cfg = makeTenantConfig();
    const redis = makeRedis();

    const result = await ssoService.initiateOIDC(cfg, redis);

    expect(result.authorizationUrl).toContain('response_type=code');
    expect(result.authorizationUrl).toContain('client_id=client-abc');
    expect(result.authorizationUrl).toContain('state=');
    expect(redis.setex).toHaveBeenCalledTimes(1);
    // State key should be set with TTL
    const [stateKey, ttl] = redis.setex.mock.calls[0];
    expect(stateKey).toMatch(/^ubr:auth:sso:oidc:state:/);
    expect(ttl).toBeGreaterThan(0);
  });

  test('throws SSO_CONFIG_INCOMPLETE when discoveryUrl is missing', async () => {
    const cfg = makeTenantConfig({ oidc: { clientId: 'client-abc' } });
    await expect(ssoService.initiateOIDC(cfg, makeRedis())).rejects.toMatchObject({
      code: 'SSO_CONFIG_INCOMPLETE',
    });
  });
});

// ── handleOIDCCallback ────────────────────────────────────────────────────────

describe('ssoService.handleOIDCCallback', () => {
  beforeEach(() => jest.clearAllMocks());

  test('throws SSO_IDP_ERROR when IdP returns error', async () => {
    const cfg = makeTenantConfig();
    await expect(ssoService.handleOIDCCallback(
      { error: 'access_denied', errorDescription: 'User denied access', code: null, state: null },
      cfg, makeRedis(), {}
    )).rejects.toMatchObject({ code: 'SSO_IDP_ERROR', status: 401 });
  });

  test('throws SSO_STATE_INVALID when state is not found in Redis', async () => {
    const cfg = makeTenantConfig();
    const redis = makeRedis(null); // state not found

    await expect(ssoService.handleOIDCCallback(
      { code: 'auth-code', state: 'some-state', error: null, errorDescription: null },
      cfg, redis, {}
    )).rejects.toMatchObject({ code: 'SSO_STATE_INVALID', status: 401 });
  });

  test('throws SSO_STATE_INVALID when state tenant does not match', async () => {
    const cfg = makeTenantConfig();
    const storedState = JSON.stringify({ tenantId: 'different-tenant', nonce: 'n1', expiresAt: 9999999999 });
    const redis = makeRedis(storedState);

    await expect(ssoService.handleOIDCCallback(
      { code: 'auth-code', state: 'some-state', error: null, errorDescription: null },
      cfg, redis, {}
    )).rejects.toMatchObject({ code: 'SSO_STATE_INVALID' });
  });

  test('throws SSO_INVALID_CALLBACK when code or state is missing', async () => {
    const cfg = makeTenantConfig();
    await expect(ssoService.handleOIDCCallback(
      { code: null, state: null, error: null, errorDescription: null },
      cfg, makeRedis(), {}
    )).rejects.toMatchObject({ code: 'SSO_INVALID_CALLBACK' });
  });
});

// ── initiateSAML ──────────────────────────────────────────────────────────────

describe('ssoService.initiateSAML', () => {
  beforeEach(() => jest.clearAllMocks());

  test('returns a SAML redirect URL and stores state', async () => {
    const cfg = makeTenantConfig({ providerType: 'saml' });
    const redis = makeRedis();

    const result = await ssoService.initiateSAML(cfg, redis);

    expect(result.redirectUrl).toContain('SAMLRequest');
    expect(redis.setex).toHaveBeenCalledTimes(1);
  });

  test('throws SSO_CONFIG_INCOMPLETE when entryPoint is missing', async () => {
    const cfg = makeTenantConfig({ saml: { issuer: 'urn:ubr' } });
    await expect(ssoService.initiateSAML(cfg, makeRedis())).rejects.toMatchObject({
      code: 'SSO_CONFIG_INCOMPLETE',
    });
  });
});

// ── handleSAMLCallback ────────────────────────────────────────────────────────

describe('ssoService.handleSAMLCallback', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jwtService.generateAccessToken.mockReturnValue('mock-access-token');
    jwtService.generateRefreshToken.mockReturnValue('mock-refresh-token');
    sessionService.createSession.mockResolvedValue({});
    User.findOne.mockResolvedValue(null);
    User.create.mockResolvedValue({ _id: 'user-456', username: 'user', role: 'user', save: jest.fn() });
    User.findByIdAndUpdate.mockResolvedValue({});
  });

  test('throws SSO_INVALID_CALLBACK when SAMLResponse is missing', async () => {
    const cfg = makeTenantConfig({ providerType: 'saml' });
    await expect(ssoService.handleSAMLCallback(
      { samlResponse: null, relayState: null },
      cfg, makeRedis(), {}
    )).rejects.toMatchObject({ code: 'SSO_INVALID_CALLBACK' });
  });

  test('issues tokens on successful SAML assertion', async () => {
    const cfg = makeTenantConfig({ providerType: 'saml' });

    const result = await ssoService.handleSAMLCallback(
      { samlResponse: 'BASE64_ASSERTION', relayState: null },
      cfg, makeRedis(), { ip: '10.0.0.1', userAgent: 'test' }
    );

    expect(result.accessToken).toBe('mock-access-token');
    expect(result.refreshToken).toBe('mock-refresh-token');
  });
});

// ── getTenantSSOConfig / upsertTenantSSOConfig ────────────────────────────────

describe('ssoService.getTenantSSOConfig', () => {
  beforeEach(() => jest.clearAllMocks());

  test('returns null when no config exists', async () => {
    TenantSSO.findOne.mockResolvedValue(null);
    const result = await ssoService.getTenantSSOConfig('tenant-x');
    expect(result).toBeNull();
  });

  test('returns config via toJSON serialization', async () => {
    const cfg = makeTenantConfig();
    TenantSSO.findOne.mockResolvedValue(cfg);
    const result = await ssoService.getTenantSSOConfig('tenant-a');
    expect(result.tenantId).toBe('tenant-a');
    expect(result.providerType).toBe('oidc');
    // Verify the service calls toJSON (real Mongoose model redacts clientSecretRef via select:false)
    expect(result).toHaveProperty('oidc');
  });
});

describe('ssoService.upsertTenantSSOConfig', () => {
  beforeEach(() => jest.clearAllMocks());

  test('creates new config when none exists', async () => {
    TenantSSO.findOne.mockResolvedValue(null);
    const created = makeTenantConfig();
    TenantSSO.create.mockResolvedValue({ ...created, toJSON: () => created });

    const result = await ssoService.upsertTenantSSOConfig('tenant-a', {
      providerType: 'oidc',
      oidc: { discoveryUrl: 'https://idp/discover', clientId: 'c1', callbackUrl: 'https://nms/cb' },
    }, 'admin-user');

    expect(TenantSSO.create).toHaveBeenCalled();
    expect(result.providerType).toBe('oidc');
  });

  test('updates existing config', async () => {
    const existing = {
      ...makeTenantConfig(),
      save: jest.fn().mockResolvedValue(makeTenantConfig({ providerType: 'ldap', toJSON: () => ({ providerType: 'ldap' }) })),
    };
    TenantSSO.findOne.mockResolvedValue(existing);

    const result = await ssoService.upsertTenantSSOConfig('tenant-a', {
      providerType: 'ldap',
    }, 'admin-user');

    expect(existing.save).toHaveBeenCalled();
  });
});
