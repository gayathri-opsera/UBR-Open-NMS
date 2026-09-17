'use strict';

/**
 * JWT fixture factory for gateway integration tests.
 *
 * Signs RS256 tokens with the test RSA key pair committed alongside this file.
 * The public key is injected into config before tests run — never use these
 * keys outside of test environments.
 *
 * Generated roles map deterministically to framework capabilities (WO-004):
 *   SuperAdmin: admin, super_admin, framework_admin, system_admin
 *   Operator:   operator, nms_operator, network_engineer, noc_operator
 *   ReadOnly:   viewer, compliance, auditor, user, readonly
 */

const jwt  = require('jsonwebtoken');
const path = require('path');
const fs   = require('fs');

const PRIVATE_KEY = fs.readFileSync(path.join(__dirname, 'test-private.pem'), 'utf8');
const PUBLIC_KEY  = fs.readFileSync(path.join(__dirname, 'test-public.pem'),  'utf8');

const BASE_PAYLOAD = {
  iss: 'ubr-nms',
  aud: 'ubr-nms-api',
};

/**
 * Sign a test JWT.
 *
 * @param {object} overrides  - Payload fields to merge (role, sub, exp, etc.)
 * @param {object} signOpts   - jsonwebtoken sign options (expiresIn, etc.)
 * @returns {string} Signed JWT bearer token
 */
function signToken(overrides = {}, signOpts = {}) {
  const payload = { ...BASE_PAYLOAD, sub: 'test-user', userId: 'test-user', ...overrides };
  return jwt.sign(payload, PRIVATE_KEY, {
    algorithm: 'RS256',
    expiresIn: '5m',
    ...signOpts,
  });
}

/** Pre-signed tokens for each capability tier */
const tokens = {
  superAdmin:  signToken({ role: 'admin',      username: 'admin-user'    }),
  operator:    signToken({ role: 'operator',   username: 'operator-user' }),
  readOnly:    signToken({ role: 'viewer',     username: 'viewer-user'   }),
  // Mixed-case and aliased roles
  systemAdmin: signToken({ role: 'SYSTEM_ADMIN',  username: 'sysadmin-user' }),
  nmsOperator: signToken({ role: 'nms_operator',  username: 'nms-op-user'  }),
  auditor:     signToken({ role: 'auditor',        username: 'auditor-user' }),
  // Unknown role — should be denied everywhere
  unknown:     signToken({ role: 'unknown_role',   username: 'unknown-user' }),
};

module.exports = { signToken, tokens, PUBLIC_KEY, PRIVATE_KEY };
