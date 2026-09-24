'use strict';

/**
 * WO-005: Credential material detection middleware.
 *
 * Intercepts Product Definition upload requests and rejects payloads that
 * contain credential-like content (community strings, passwords, API keys,
 * tokens, bearer secrets, private keys).
 *
 * This guard fires BEFORE the payload is proxied to the product-definition-service
 * so credential material can never reach the validation pipeline, the normalized
 * metadata store, or the audit log.
 *
 * Applicable routes: POST /upload and any multipart/JSON upload for Product Definitions.
 *
 * On detection returns:
 *   HTTP 400 { status: 'error', error: { code: 'CREDENTIAL_MATERIAL_NOT_ALLOWED',
 *              message: '...', details: { field, location }, correlationId } }
 *
 * The detected field name is returned in `details`; the secret VALUE is never echoed.
 */

const { v4: uuidv4 } = require('uuid');
const { detectCredentialMaterial } = require('../utils/secretRedact');
const logger = require('../utils/logger');

/**
 * Express middleware that scans req.body for credential-like content.
 * Attach after express.json() so req.body is already parsed.
 *
 * For multipart uploads (XML, XLS files), the detection runs on the stringified
 * body fields. If the gateway proxies the raw binary stream before parsing,
 * this middleware is a no-op and the Java service validation applies instead.
 */
function detectCredentials(req, res, next) {
  const correlationId = (req.headers && req.headers['x-correlation-id']) || uuidv4();

  // Only inspect requests that carry a parsed body
  if (!req.body || typeof req.body !== 'object' || Object.keys(req.body).length === 0) {
    return next();
  }

  const hit = detectCredentialMaterial(req.body, 'request.body');

  if (!hit) return next();

  // Log the detection with location only — never log the value
  logger.warn({
    msg:          'Credential material detected in Product Definition upload',
    field:        hit.field,
    location:     hit.location,
    correlationId,
    actor:        req.user ? (req.user.userId || req.user.sub) : 'unauthenticated',
    path:         req.path,
    method:       req.method,
  });

  return res.status(400).json({
    status: 'error',
    error: {
      code:    'CREDENTIAL_MATERIAL_NOT_ALLOWED',
      message: `Product Definition content must not contain inline credential values. ` +
               `Detected credential-like field '${hit.field}'. ` +
               `Use a credentialRef identifier instead of embedding secrets in the definition.`,
      details: {
        field:    hit.field,
        location: hit.location,
      },
      correlationId,
    },
  });
}

module.exports = { detectCredentials };
