'use strict';

require('dotenv').config();

module.exports = {
  port: parseInt(process.env.AUTH_PORT || '3001', 10),
  nodeEnv: process.env.NODE_ENV || 'development',

  mongo: {
    uri: process.env.MONGO_URI || 'mongodb://localhost:27017/ubr_nms',
    options: { serverSelectionTimeoutMS: 5000 },
  },

  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD || undefined,
    tls: process.env.REDIS_TLS === 'true' ? {} : undefined,
    keyPrefix: 'ubr:auth:',
  },

  ldap: {
    url: process.env.LDAP_URL || 'ldaps://localhost:636',
    baseDn: process.env.LDAP_BASE_DN || 'dc=example,dc=com',
    bindDn: process.env.LDAP_BIND_DN || 'cn=admin,dc=example,dc=com',
    bindPassword: process.env.LDAP_BIND_PASSWORD || '',
    searchFilter: process.env.LDAP_SEARCH_FILTER || '(uid={{username}})',
    tlsOptions: {
      rejectUnauthorized: process.env.LDAP_TLS_REJECT_UNAUTHORIZED !== 'false',
    },
    circuitBreaker: {
      timeout: 3000,
      errorThresholdPercentage: 50,
      resetTimeout: 60000,
    },
  },

  jwt: {
    privateKey: process.env.JWT_PRIVATE_KEY
      ? Buffer.from(process.env.JWT_PRIVATE_KEY, 'base64').toString('utf8')
      : null,
    publicKey: process.env.JWT_PUBLIC_KEY
      ? Buffer.from(process.env.JWT_PUBLIC_KEY, 'base64').toString('utf8')
      : null,
    accessTokenTtl: '15m',
    accessTokenTtlSeconds: 15 * 60,
    refreshTokenTtlSeconds: 24 * 60 * 60,
    algorithm: 'RS256',
    issuer: 'ubr-nms',
    audience: 'ubr-nms-api',
  },

  session: {
    maxConcurrent: parseInt(process.env.MAX_CONCURRENT_SESSIONS || '10', 10),
    idleTimeoutSeconds: parseInt(process.env.SESSION_IDLE_TIMEOUT_SECONDS || '1800', 10),
    cleanupIntervalSeconds: 60,
  },

  password: {
    minLength: 12,
    bcryptRounds: 12,
    maxFailedAttempts: parseInt(process.env.MAX_FAILED_ATTEMPTS || '100', 10),
    lockoutDurationSeconds: parseInt(process.env.LOCKOUT_DURATION_SECONDS || String(30 * 60), 10),
    historyDepth: 12,
  },

  cors: {
    origin: process.env.CORS_ORIGIN || 'http://localhost:3000',
    credentials: true,
  },

  mfa: {
    // Symmetric secret for signing short-lived MFA challenge tokens.
    // Must be set via env var in production (min 32 random chars).
    challengeSecret: process.env.MFA_CHALLENGE_SECRET || 'mfa-challenge-dev-secret-change-in-prod',
    challengeTtlSeconds: 5 * 60, // 5 minutes
    appName: 'UBR-NMS',
  },
};
