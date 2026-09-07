'use strict';

const mongoose = require('mongoose');

/**
 * TenantSSO stores the identity provider configuration for a tenant (WO-013).
 *
 * SECURITY:
 * - OIDC client secrets are stored as vault-path references, never raw values.
 * - SAML private keys are NOT stored here; they are resolved from vault paths at runtime.
 * - The `toJSON` transform redacts all secret-adjacent fields before serialisation.
 */
const tenantSSOSchema = new mongoose.Schema(
  {
    // Unique tenant identifier (matches X-Tenant-ID header or hostname mapping)
    tenantId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      index: true,
    },

    // Provider type
    providerType: {
      type: String,
      enum: ['local', 'ldap', 'oidc', 'saml'],
      required: true,
      default: 'local',
    },

    enabled: {
      type: Boolean,
      default: true,
    },

    // When false, local account authentication is rejected even if the IdP is unavailable.
    localFallbackEnabled: {
      type: Boolean,
      default: true,
    },

    displayName: {
      type: String,
      default: '',
    },

    // ── OIDC configuration ─────────────────────────────────────────────────
    oidc: {
      // Discovery URL for fetching provider metadata (e.g. /.well-known/openid-configuration)
      discoveryUrl: { type: String, default: null },
      clientId: { type: String, default: null },
      // Vault path reference — e.g. "secret/ubr-nms/oidc/tenant-a/client-secret"
      // NEVER store the raw secret here.
      clientSecretRef: { type: String, default: null, select: false },
      callbackUrl: { type: String, default: null },
      scopes: { type: [String], default: ['openid', 'profile', 'email'] },
    },

    // ── SAML configuration ─────────────────────────────────────────────────
    saml: {
      // IdP metadata URL or inline XML
      metadataUrl: { type: String, default: null },
      entryPoint: { type: String, default: null },
      issuer: { type: String, default: null },
      // Path to the SP certificate (public) — not the private key
      cert: { type: String, default: null },
      callbackUrl: { type: String, default: null },
    },

    // ── Claim mapping ──────────────────────────────────────────────────────
    // Maps IdP claim names to platform user attributes.
    claimMapping: {
      // IdP claim → platform attribute
      email:    { type: String, default: 'email' },
      username: { type: String, default: 'preferred_username' },
      role:     { type: String, default: 'role' },
    },

    // Default role to assign when IdP does not provide a role claim.
    defaultRole: {
      type: String,
      enum: ['admin', 'operator', 'user'],
      default: 'user',
    },

    lastValidatedAt: {
      type: Date,
      default: null,
    },

    createdBy: { type: String, default: 'system' },
    updatedBy: { type: String, default: null },
  },
  {
    timestamps: true,
    toJSON: {
      transform(doc, ret) {
        // Never expose secret references in API responses
        if (ret.oidc) {
          delete ret.oidc.clientSecretRef;
        }
        delete ret.__v;
        return ret;
      },
    },
  }
);

const TenantSSO = mongoose.model('TenantSSO', tenantSSOSchema);

module.exports = { TenantSSO };
