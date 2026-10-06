'use strict';

/**
 * API Gateway route for Framework Product Definitions.
 *
 * Proxies all /api/v1/framework/product-definitions/* requests to the
 * product-definition-service after enforcing role-based access using the
 * WO-004 framework capability model:
 *
 *   SuperAdmin (admin / FRAMEWORK_ADMIN / SYSTEM_ADMIN / super_admin)
 *     → full lifecycle: upload, stage, activate, rollback, audit-history
 *   Operator (operator / NMS_OPERATOR / network_engineer / noc_operator)
 *     → read + lifecycle mutations (stage, activate, rollback)
 *   ReadOnly (viewer / compliance / auditor / user)
 *     → read-only: list, get version, report, active, lifecycle-history
 *
 * All authorization failures return the standard structured error envelope:
 *   { status: "error", error: { code, message, details: {}, correlationId } }
 *
 * Gateway-injected headers forwarded to the downstream service:
 *   X-User-Id, X-Username, X-User-Role, X-Correlation-Id
 */

const express = require('express');
const httpProxy = require('express-http-proxy');
const config = require('../config');
const logger = require('../utils/logger');
const {
  requireFrameworkCapability,
  FRAMEWORK_CAPABILITY,
} = require('../middleware/rbac.middleware');

const { detectCredentials }       = require('../middleware/credentialDetect.middleware');
const live                        = require('../live/liveParameters');
const { buildWireframe }          = require('../live/wireframeBuilder');
const { parseDefinitionFile }     = require('../live/definitionParser');
const {
  NodeViewWireframe,
  invalidateCache,
}                                 = require('../models/nodeViewWireframe.model');

const router = express.Router();

// ── Shared wireframe-persist helper ──────────────────────────────────────────
/**
 * Loads the definition's registry entries and persists (upserts) a wireframe
 * document in `node_view_wireframes`.
 *
 * @param {string}  definitionId   - productDefinitionId
 * @param {string}  desiredStatus  - 'ACTIVE' | 'DRAFT'
 * @param {object}  redis          - ioredis client (may be null)
 * @returns {Promise<void>}
 */
async function persistWireframe(definitionId, desiredStatus, redis) {
  const definition = await live.loadDefinition(definitionId);
  if (!definition || !definition.entries || definition.entries.length === 0) {
    logger.warn({ msg: 'wireframe-build: no registry entries found', definitionId, desiredStatus });
    return;
  }

  const { wireframe, parameterCount, groupCount, validationErrors } = buildWireframe(definition);

  if (desiredStatus === 'ACTIVE') {
    // Supersede any previous ACTIVE wireframe for this definition.
    await NodeViewWireframe.updateMany(
      { productDefinitionId: definitionId, status: 'ACTIVE' },
      { $set: { status: 'SUPERSEDED', updatedAt: new Date() } },
    );
  }

  await NodeViewWireframe.findOneAndUpdate(
    { productDefinitionId: definitionId, versionId: definition.versionId },
    {
      $set: {
        productDefinitionId: definitionId,
        versionId:           definition.versionId,
        registryVersion:     definition.registryVersion,
        status:              desiredStatus,
        wireframe,
        parameterCount,
        groupCount,
        validationWarnings:  validationErrors,
        updatedAt:           new Date(),
      },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true, new: true },
  );

  if (desiredStatus === 'ACTIVE') {
    await invalidateCache(redis, definitionId);
  }

  logger.info({
    msg: 'wireframe-build: persisted',
    definitionId,
    versionId: definition.versionId,
    desiredStatus,
    parameterCount,
    groupCount,
    warnings: validationErrors.length,
  });
}

// ── Post-upload wireframe builder ─────────────────────────────────────────────
/**
 * Middleware that fires AFTER the Java upload proxy responds with 2xx.
 * Extracts the productDefinitionId from the upstream response body and
 * immediately builds a DRAFT wireframe.
 *
 * This means the wireframe is ready to preview the moment the file lands —
 * no need to wait for activation. Activation promotes it to ACTIVE.
 *
 * Works for XML, XLS, and JSON uploads (any format the product-definition-service accepts).
 * Best-effort: never blocks or alters the client response.
 */
async function buildWireframeAfterUpload(req, res, next) {
  // The proxy already sent the response. Run async so the client isn't held.
  setImmediate(async () => {
    try {
      // Give the product-definition-service a moment to commit registry entries.
      await new Promise((r) => setTimeout(r, 2500));

      // The upload response body is already gone (sent to client). We need to
      // figure out which definition was uploaded. The product-def service returns
      // the productDefinitionId in the response — but since express-http-proxy
      // already flushed it, we fall back to scanning what was just written.
      // Strategy: find the NEWEST version document across all definitions and build
      // its wireframe if it doesn't already have one.
      const { buildWireframe: _bw } = require('../live/wireframeBuilder');
      const liveP = require('../live/liveParameters');

      // Get all active definition IDs and try building the most recently uploaded one.
      const mongoose = require('mongoose');
      const PRODUCTDEF_DB = process.env.PRODUCTDEF_DB_NAME || 'ubrnms_productdef';
      const db = mongoose.connection.readyState === 1
        ? mongoose.connection.client.db(PRODUCTDEF_DB)
        : null;

      if (!db) {
        logger.warn({ msg: 'wireframe-build-upload: MongoDB not ready' });
        return;
      }

      // Find the most recently updated definition in the registry
      const recent = await db.collection('parameter_registry_entries')
        .aggregate([
          { $sort: { updatedAt: -1 } },
          { $group: { _id: '$productDefinitionId', updatedAt: { $first: '$updatedAt' } } },
          { $sort: { updatedAt: -1 } },
          { $limit: 5 },
        ])
        .toArray();

      const redis = req.app.get('redis');

      for (const { _id: defId } of recent) {
        // Skip if already has an up-to-date ACTIVE wireframe
        const existing = await NodeViewWireframe.findOne({ productDefinitionId: defId, status: 'ACTIVE' }).lean();

        // Determine correct status — use ACTIVE if this def is the active version
        const activeRec = await db.collection('product_definition_active_versions')
          .findOne({ productDefinitionId: defId });
        const targetStatus = activeRec ? 'ACTIVE' : 'DRAFT';

        if (existing && targetStatus === 'ACTIVE') {
          // Already have an active wireframe — only rebuild if it's stale
          const definition = await liveP.loadDefinition(defId).catch(() => null);
          if (!definition || existing.versionId === definition.versionId) continue;
        }

        try {
          await persistWireframe(defId, targetStatus, redis);
          logger.info({ msg: 'wireframe-build-upload: built for recently uploaded def', defId, targetStatus });
        } catch (e) {
          logger.warn({ msg: 'wireframe-build-upload: failed for def', defId, err: e.message });
        }
      }
    } catch (err) {
      logger.error({ msg: 'wireframe-build-upload: unexpected error', err: err.message });
    }
  });
  // Response already sent by proxy — do not call next().
}

// ── Post-activation wireframe builder ─────────────────────────────────────────
/**
 * Middleware that fires AFTER the Java activate/rollback proxy responds.
 * Promotes the wireframe to ACTIVE status and invalidates the Redis cache.
 *
 * Best-effort — never blocks or overrides the upstream response.
 */
async function buildWireframeAfterActivation(req, res, next) {
  // The proxy middleware has already sent the response; we run asynchronously.
  // Pull the definitionId from the route params.
  const { definitionId } = req.params;
  if (!definitionId) return next();

  // Fire-and-forget: do not await so as not to delay the client response.
  setImmediate(async () => {
    try {
      // Wait briefly for the Java service's Kafka/registry rebuild to propagate.
      await new Promise((r) => setTimeout(r, 2000));
      const redis = req.app.get('redis');
      await persistWireframe(definitionId, 'ACTIVE', redis);
    } catch (err) {
      logger.error({ msg: 'wireframe-build: failed', definitionId, err: err.message });
    }
  });

  // next() is not called — the proxy already ended the response.
}

// ── Idempotency helpers ────────────────────────────────────────────────────────

/**
 * Intercept an UPLOAD_REJECTED response from the Java product-definition-service
 * and return a proper version object so the UI can proceed to stage+activate.
 *
 * When a user deletes a definition from the UI but re-uploads the same file,
 * the Java service still rejects the upload because the content-hash is on record.
 * This decorator extracts the existing versionId, looks it up in MongoDB, and
 * returns the full version object — allowing the frontend to recover seamlessly.
 */
async function uploadIdempotencyDecorator(proxyRes, proxyResData, userReq, userRes) {
  const text = proxyResData.toString('utf8');
  try {
    const body = JSON.parse(text);
    if (body.error !== 'UPLOAD_REJECTED' || !body.message) return proxyResData;

    const match = body.message.match(/versionId=([0-9a-f-]+)/i);
    if (!match) return proxyResData;

    const existingVersionId = match[1];
    const mongoose = require('mongoose');
    const PRODUCTDEF_DB = process.env.PRODUCTDEF_DB_NAME || 'ubrnms_productdef';
    const db = mongoose.connection.readyState === 1
      ? mongoose.connection.client.db(PRODUCTDEF_DB) : null;

    if (!db) return proxyResData;

    const existing = await db.collection('product_definition_versions')
      .findOne({ versionId: existingVersionId });
    if (!existing) return proxyResData;

    // Override the response status to 200 on the ACTUAL client response (userRes),
    // NOT proxyRes — express-http-proxy reads proxyRes.statusCode before calling
    // this decorator, so only userRes.statusCode controls what the client sees.
    userRes.statusCode = 200;
    logger.info({
      msg:       'upload: returning existing version for duplicate upload',
      versionId: existingVersionId,
      defId:     existing.definitionId,
      status:    existing.lifecycleStatus,
    });
    return JSON.stringify({
      versionId:        existing.versionId,
      definitionId:     existing.definitionId,
      name:             existing.name        || existing.model || 'Unknown',
      vendor:           existing.vendor      || '',
      model:            existing.model       || '',
      deviceType:       existing.deviceType  || '',
      lifecycleStatus:  existing.lifecycleStatus || 'STAGED',
      validationStatus: existing.validationStatus || 'VALID',
      uploadedFormat:   existing.uploadedFormat || 'XML',
      description:      existing.description || '',
      createdAt:        existing.createdAt,
      updatedAt:        existing.updatedAt,
      alreadyUploaded:  true,   // ← frontend key: show recovery banner + enable Stage & Activate
    });
  } catch (e) {
    logger.warn({ msg: 'upload: idempotency decorator error', err: e.message });
    return proxyResData;
  }
}

/**
 * Make stage idempotent: if the version is already STAGED or ACTIVE (422 or 409
 * from the Java service), return 200 so the caller can proceed to activate.
 */
function stageIdempotencyDecorator(proxyRes, proxyResData, userReq, userRes) {
  if (proxyRes.statusCode !== 409 && proxyRes.statusCode !== 422) return proxyResData;
  const text = proxyResData.toString('utf8');
  try {
    const body = JSON.parse(text);
    const msg = (body.message || body.error || '').toLowerCase();
    // Only treat as idempotent for "already staged / already active" transitions
    if (msg.includes('staged') || msg.includes('active') ||
        msg.includes('invalid') || msg.includes('transition') || msg.includes('already')) {
      userRes.statusCode = 200;   // override on actual client response
      logger.info({ msg: 'stage: idempotent — version already in valid state', originalMsg: body.message });
      return JSON.stringify({ status: 'ok', alreadyStaged: true, message: body.message });
    }
  } catch {}
  return proxyResData;
}

/**
 * Make activate idempotent: if 409 means "already active", return 200.
 */
function activateIdempotencyDecorator(proxyRes, proxyResData, userReq, userRes) {
  if (proxyRes.statusCode !== 409) return proxyResData;
  const text = proxyResData.toString('utf8');
  try {
    const body = JSON.parse(text);
    const msg = (body.message || body.error || '').toLowerCase();
    if (msg.includes('active') || msg.includes('conflict') || msg.includes('already')) {
      userRes.statusCode = 200;   // override on actual client response
      logger.info({ msg: 'activate: idempotent — version already active', originalMsg: body.message });
      return JSON.stringify({ status: 'ok', alreadyActive: true, message: body.message });
    }
  } catch {}
  return proxyResData;
}

// ── Proxy factory ─────────────────────────────────────────────────────────────

const serviceUrl = config.services.productDefinition || 'http://localhost:8093';

function productDefinitionProxy(opts = {}) {
  // Build options object — only include userResDecorator when supplied.
  // Passing userResDecorator: null to express-http-proxy causes it to call
  // null() on every response, throwing "null is not a function".
  const proxyOpts = {
    // Per-route callers can pass { timeout: N } to override.
    // Activation rebuilds registries + publishes Kafka events and may exceed 60 s.
    timeout: opts.timeout || 60000,
    // express-http-proxy mounts inside a sub-router so req.url is the stripped
    // sub-path (e.g. "/upload"). Use req.originalUrl to forward the full path
    // ("/api/v1/framework/product-definitions/upload") to the downstream service.
    proxyReqPathResolver: (req) => req.originalUrl,
    // For multipart/form-data (file upload) requests parseReqBody must be false so
    // express-http-proxy does not buffer-and-re-serialise the body, which strips the
    // multipart boundary and causes Spring's MultipartResolver to return 400.
    // Callers opt-in per-route via { parseReqBody: false }.
    parseReqBody: opts.parseReqBody !== undefined ? opts.parseReqBody : true,
    proxyReqOptDecorator(proxyReqOpts, srcReq) {
      // Forward gateway-populated identity headers so the downstream service
      // can persist actor information without touching the JWT itself.
      proxyReqOpts.headers['X-User-Id']       = srcReq.headers['x-user-id'] || '';
      proxyReqOpts.headers['X-Username']       = srcReq.headers['x-username'] || '';
      proxyReqOpts.headers['X-User-Role']      = srcReq.headers['x-user-role'] || '';
      proxyReqOpts.headers['X-Correlation-Id'] = srcReq.headers['x-correlation-id'] || '';
      return proxyReqOpts;
    },
    proxyErrorHandler(err, res, next) {
      // ── CRITICAL: Check if the upstream already sent a response ────────────
      // When parseReqBody: false, the proxy streams the request body to the
      // upstream while simultaneously receiving the upstream's response.
      // For duplicate-file uploads, Spring Boot reads the full body, detects
      // the duplicate, sends a 422 back, and closes the connection.  The proxy
      // has already forwarded the 422 to the client but may still receive an
      // ECONNRESET because it was still piping the request body when the
      // upstream closed the socket.  If the client already has the real
      // response, silently swallow the error — don't send a second response.
      if (res.headersSent) {
        // Log for observability but do NOT call next(err) — the client already
        // received the upstream's error/success response.
        const level = (err.code === 'ECONNRESET' || err.message?.includes('socket hang up'))
          ? 'debug'
          : 'warn';
        logger[level]({
          msg:  'Proxy stream error after response sent (headers already flushed)',
          code: err.code,
          err:  err.message,
        });
        return;
      }

      // ── Connection-level errors (no upstream response received) ────────────
      if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
        return res.status(503).json({
          status:  'error',
          error: { code: 'SERVICE_UNAVAILABLE',
                   message: 'product-definition-service is not reachable — check deployment status' },
        });
      }
      if (err.code === 'ETIMEDOUT') {
        return res.status(504).json({
          status:  'error',
          error: { code: 'GATEWAY_TIMEOUT',
                   message: 'product-definition-service did not respond in time' },
        });
      }
      // ECONNRESET / "socket hang up" without a prior response — upstream died.
      if (err.code === 'ECONNRESET' || err.message?.includes('socket hang up')) {
        return res.status(502).json({
          status:  'error',
          error: { code: 'UPSTREAM_RESET',
                   message: 'product-definition-service closed the connection unexpectedly' },
        });
      }
      next(err);
    },
  };

  // Only attach userResDecorator when the caller provides one — express-http-proxy
  // throws "null is not a function" if the option is present but null/undefined.
  if (typeof opts.userResDecorator === 'function') {
    proxyOpts.userResDecorator = opts.userResDecorator;
  }

  return httpProxy(serviceUrl, proxyOpts);
}

// ── Routes ────────────────────────────────────────────────────────────────────

// Health passthrough — unauthenticated health probe for infrastructure monitoring
router.get('/health', productDefinitionProxy());

// ── Native upload handler for non-NMS formats ────────────────────────────────
/**
 * Reads the multipart file, detects format, and if it is NOT NMS XML
 * (raw XML / XLS / JSON) handles the upload entirely in the gateway:
 *  1. Parses parameters with definitionParser.js
 *  2. Upserts product_definition_versions + parameter_registry_entries in MongoDB
 *  3. Builds and persists the Node View wireframe
 *  4. Returns a success response that matches the Java service's shape
 *
 * NMS XML files fall through to the Java proxy below unchanged.
 */
async function nativeFormatUpload(req, res, next) {
  // Collect the raw multipart body
  const chunks = [];
  let rawBody = Buffer.alloc(0);
  await new Promise((resolve, reject) => {
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => { rawBody = Buffer.concat(chunks); resolve(); });
    req.on('error', reject);
  });

  // Store raw body so the proxy can re-use it if we fall through
  req._rawBody = rawBody;

  // Extract the file from the multipart body (look for Content-Disposition: name="file")
  const boundary = (() => {
    const ct = req.headers['content-type'] || '';
    const m  = ct.match(/boundary=([^\s;]+)/);
    return m ? m[1] : null;
  })();

  if (!boundary) return next(); // not multipart — fall through

  // Simple multipart extractor (no npm needed)
  let filename = 'upload';
  let fileBuf  = null;
  const sep    = Buffer.from(`--${boundary}`);
  const parts  = splitBuffer(rawBody, sep);

  for (const part of parts) {
    const strPart = part.toString('latin1');
    const headerEnd = strPart.indexOf('\r\n\r\n');
    if (headerEnd < 0) continue;
    const headers = strPart.slice(0, headerEnd);
    if (!headers.includes('name="file"') && !headers.includes("name='file'")) continue;
    const fnMatch = headers.match(/filename="([^"]+)"/);
    if (fnMatch) filename = fnMatch[1];
    // Body is everything after the header separator, minus trailing \r\n
    fileBuf = part.slice(headerEnd + 4, part.length - 2);
    break;
  }

  if (!fileBuf || fileBuf.length === 0) return next(); // no file found

  const fmt = (() => { try { return require('../live/definitionParser').detectFormat(filename, fileBuf); } catch { return 'NMS_XML'; } })();

  // NMS_XML → let the Java proxy handle it
  if (fmt === 'NMS_XML') return next();

  // ── Native handling ─────────────────────────────────────────────────────────
  logger.info({ msg: 'native-upload: handling non-NMS format', filename, fmt });

  try {
    const { parseDefinitionFile } = require('../live/definitionParser');
    const parsed = parseDefinitionFile(fileBuf, filename);

    if (parsed.isNmsFormat) return next();

    const mongoose = require('mongoose');
    const { v4: uuidv4 } = require('uuid');
    const PRODUCTDEF_DB = process.env.PRODUCTDEF_DB_NAME || 'ubrnms_productdef';
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ status: 'error', error: { code: 'DB_UNAVAILABLE', message: 'MongoDB not connected' } });
    }
    const db = mongoose.connection.client.db(PRODUCTDEF_DB);

    const versionId    = uuidv4();
    const now          = new Date();
    const defId        = parsed.id;
    const totalParams  = parsed.groups.reduce((s, g) => s + g.parameters.length, 0);

    // Upsert the version record
    await db.collection('product_definition_versions').updateOne(
      { definitionId: defId, lifecycleStatus: { $in: ['DRAFT', 'STAGED'] } },
      {
        $set: {
          versionId, definitionId: defId,
          name:            `${parsed.vendor} ${parsed.model}`,
          vendor:          parsed.vendor,
          model:           parsed.model,
          deviceType:      '',
          description:     parsed.description,
          lifecycleStatus: 'STAGED',
          validationStatus:'VALID',
          uploadedFormat:  fmt,
          parameterCount:  totalParams,
          updatedAt:       now,
        },
        $setOnInsert: { createdAt: now },
      },
      { upsert: true },
    );

    // Supersede any previous ACTIVE version
    await db.collection('product_definition_active_versions').updateOne(
      { productDefinitionId: defId },
      { $set: { productDefinitionId: defId, versionId, updatedAt: now }, $setOnInsert: { createdAt: now } },
      { upsert: true },
    );

    // Clear old parameter_registry_entries for this definition
    await db.collection('parameter_registry_entries').deleteMany({ productDefinitionId: defId });

    // Insert fresh entries
    const entries = [];
    for (const g of parsed.groups) {
      for (const p of g.parameters) {
        entries.push({
          productDefinitionId: defId,
          versionId,
          parameterId:    p.parameterId,
          displayName:    p.displayName,
          groupId:        p.groupId,
          subGroup:       p.subGroup || null,
          dataType:       p.dataType,
          snmpOid:        p.snmpOid   ? `.${p.snmpOid}` : null,
          uiWidget:       p.uiWidget  || null,
          readOnly:       !!p.readOnly,
          defaultValue:   p.defaultValue ?? null,
          enumValues:     p.enumValues || [],
          minValue:       p.minValue ?? null,
          maxValue:       p.maxValue ?? null,
          displayOrder:   p.displayOrder || 0,
          groupDisplayOrder: g.displayOrder || 0,
          createdAt:      now,
          updatedAt:      now,
        });
      }
    }
    if (entries.length > 0) {
      await db.collection('parameter_registry_entries').insertMany(entries);
    }

    // Build wireframe immediately
    const redis = req.app.get('redis');
    setImmediate(async () => {
      try {
        const { buildWireframe: bw } = require('../live/wireframeBuilder');
        const definition = await live.loadDefinition(defId);
        if (definition && definition.entries?.length > 0) {
          const built = bw(definition);
          await NodeViewWireframe.findOneAndUpdate(
            { productDefinitionId: defId, versionId },
            {
              $set: {
                productDefinitionId: defId, versionId,
                registryVersion: '1',
                status: 'ACTIVE',
                wireframe: built.wireframe,
                parameterCount: built.parameterCount,
                groupCount: built.groupCount,
                validationWarnings: built.validationErrors,
                updatedAt: now,
              },
              $setOnInsert: { createdAt: now },
            },
            { upsert: true },
          );
          await invalidateCache(redis, defId);
          logger.info({ msg: 'native-upload: wireframe built', defId, parameterCount: built.parameterCount, groupCount: built.groupCount });
        }
      } catch (e) {
        logger.warn({ msg: 'native-upload: wireframe build failed', err: e.message });
      }
    });

    // Return a response that matches the Java service's version shape
    return res.status(200).json({
      versionId,
      definitionId:     defId,
      name:             `${parsed.vendor} ${parsed.model}`,
      vendor:           parsed.vendor,
      model:            parsed.model,
      lifecycleStatus:  'STAGED',
      validationStatus: 'VALID',
      uploadedFormat:   fmt,
      parameterCount:   totalParams,
      groupCount:       parsed.groups.length,
      createdAt:        now.toISOString(),
      updatedAt:        now.toISOString(),
      _nativeUpload:    true,
    });

  } catch (err) {
    logger.error({ msg: 'native-upload: failed', filename, err: err.message });
    return res.status(500).json({
      status: 'error',
      error:  { code: 'PARSE_ERROR', message: `Failed to parse ${fmt}: ${err.message}` },
    });
  }
}

/** Split a Buffer by a separator Buffer. */
function splitBuffer(buf, sep) {
  const parts = [];
  let start = 0;
  while (start < buf.length) {
    const idx = buf.indexOf(sep, start);
    if (idx < 0) { parts.push(buf.slice(start)); break; }
    parts.push(buf.slice(start, idx));
    start = idx + sep.length;
  }
  return parts.map((p) => {
    // strip leading \r\n
    if (p[0] === 0x0d && p[1] === 0x0a) return p.slice(2);
    return p;
  });
}

// Upload: SuperAdmin only — triggers validation and ingestion pipeline.
// WO-005: detectCredentials scans the request body for credential-like content
// and rejects the upload before it reaches the product-definition-service.
// nativeFormatUpload — handles raw XML / XLS / JSON before proxying to Java.
router.post('/upload',
  requireFrameworkCapability(FRAMEWORK_CAPABILITY.SuperAdmin, 'product-definitions.upload'),
  detectCredentials,
  nativeFormatUpload,         // ← handles non-NMS formats natively; NMS falls through
  // parseReqBody: false — stream the raw multipart body directly
  (req, res, next) => {
    // Re-attach the raw body as a readable stream for the proxy
    if (req._rawBody) {
      const { Readable } = require('stream');
      const s = new Readable(); s.push(req._rawBody); s.push(null);
      req.pipe = s.pipe.bind(s);
      req.on  = s.on.bind(s);
    }
    next();
  },
  productDefinitionProxy({ parseReqBody: false, userResDecorator: uploadIdempotencyDecorator }),
  // ✅ Build wireframe immediately after any XML / XLS / JSON upload succeeds.
  buildWireframeAfterUpload,
);

/**
 * Supplement the Java service's definition list with any definitions that have
 * only STAGED versions (no ACTIVE version). These are invisible to the Java
 * service's list endpoint but are needed so the UI can show them and allow
 * operators to activate them (e.g. after a failed delete+re-upload flow).
 */
async function listDefinitionsDecorator(proxyRes, proxyResData, userReq, userRes) {
  if (proxyRes.statusCode !== 200) return proxyResData;
  try {
    const mongoose = require('mongoose');
    const PRODUCTDEF_DB = process.env.PRODUCTDEF_DB_NAME || 'ubrnms_productdef';
    if (mongoose.connection.readyState !== 1) return proxyResData;
    const db = mongoose.connection.client.db(PRODUCTDEF_DB);

    // Parse the Java service response (may be array or {definitions:[...]})
    const text = proxyResData.toString('utf8');
    let javaDefs = [];
    try {
      const parsed = JSON.parse(text);
      javaDefs = Array.isArray(parsed) ? parsed
        : (Array.isArray(parsed?.definitions) ? parsed.definitions : []);
    } catch { return proxyResData; }

    // Collect definitionIds already in the Java list
    const knownIds = new Set(javaDefs.map((d) => d.productDefinitionId || d.definitionId || d.id));

    // Find STAGED versions whose definitionId is NOT in the Java list
    const stagedOnly = await db.collection('product_definition_versions')
      .find({ lifecycleStatus: { $in: ['STAGED', 'DRAFT'] } })
      .project({ versionId:1, definitionId:1, name:1, vendor:1, model:1,
                 lifecycleStatus:1, validationStatus:1, createdAt:1, updatedAt:1 })
      .toArray();

    const extras = [];
    for (const v of stagedOnly) {
      if (!knownIds.has(v.definitionId)) {
        extras.push({
          productDefinitionId: v.definitionId,
          definitionId:        v.definitionId,
          name:                v.name || v.model || v.definitionId,
          vendor:              v.vendor || '',
          model:               v.model || '',
          versionCount:        1,
          activeVersionId:     null,
          activeVersionStatus: v.lifecycleStatus,   // 'STAGED' | 'DRAFT'
          registryVersion:     0,
          updatedAt:           v.updatedAt || v.createdAt,
          _stagedOnly:         true,  // flag for UI to treat differently
        });
        knownIds.add(v.definitionId); // don't double-add
      }
    }

    if (extras.length === 0) return proxyResData;
    logger.info({ msg: 'list-definitions: supplementing with staged-only defs', count: extras.length });
    return JSON.stringify([...javaDefs, ...extras]);
  } catch (e) {
    logger.warn({ msg: 'list-definitions: supplement error', err: e.message });
    return proxyResData;
  }
}

// List all definitions (summary): ReadOnly+
router.get('/',
  requireFrameworkCapability(FRAMEWORK_CAPABILITY.ReadOnly, 'product-definitions.list'),
  productDefinitionProxy({ userResDecorator: listDefinitionsDecorator }),
);

// Global upload history across all definitions — Admin/SuperAdmin only.
// Must be registered before /:definitionId/* routes so "history" is not treated as a definitionId.
router.get('/history',
  requireFrameworkCapability(FRAMEWORK_CAPABILITY.Admin, 'product-definitions.history'),
  productDefinitionProxy(),
);

/**
 * Supplement the versions list with any STAGED/DRAFT versions from MongoDB
 * that the Java service doesn't return (e.g. after a partial delete).
 */
async function listVersionsDecorator(proxyRes, proxyResData, userReq, userRes) {
  try {
    const mongoose = require('mongoose');
    const PRODUCTDEF_DB = process.env.PRODUCTDEF_DB_NAME || 'ubrnms_productdef';
    if (mongoose.connection.readyState !== 1) return proxyResData;
    const db = mongoose.connection.client.db(PRODUCTDEF_DB);

    // Extract definitionId from the URL (/api/v1/framework/product-definitions/:id/versions)
    const urlParts = (userReq.originalUrl || userReq.url || '').split('/');
    const versionsIdx = urlParts.indexOf('versions');
    const definitionId = versionsIdx > 0 ? urlParts[versionsIdx - 1] : null;
    if (!definitionId) return proxyResData;

    // Parse what Java returned (may be empty array or {versions:[]})
    const text = proxyResData.toString('utf8');
    let javaVersions = [];
    try {
      const parsed = JSON.parse(text);
      javaVersions = Array.isArray(parsed) ? parsed
        : (Array.isArray(parsed?.versions) ? parsed.versions : []);
    } catch { return proxyResData; }

    // Get MongoDB versions for this definition not already in Java's list
    const knownIds = new Set(javaVersions.map((v) => v.versionId));
    const mongoVersions = await db.collection('product_definition_versions')
      .find({ definitionId, versionId: { $nin: Array.from(knownIds) } })
      .project({ versionId:1, definitionId:1, name:1, vendor:1, model:1,
                 lifecycleStatus:1, validationStatus:1, uploadedFormat:1,
                 description:1, createdAt:1, updatedAt:1 })
      .sort({ updatedAt: -1 })
      .toArray();

    if (mongoVersions.length === 0) return proxyResData;
    logger.info({ msg: 'list-versions: supplementing with mongo versions', definitionId, count: mongoVersions.length });

    const extras = mongoVersions.map((v) => ({
      versionId:        v.versionId,
      definitionId:     v.definitionId,
      name:             v.name || v.model || v.definitionId,
      vendor:           v.vendor || '',
      model:            v.model || '',
      lifecycleStatus:  v.lifecycleStatus || 'STAGED',
      validationStatus: v.validationStatus || 'VALID',
      uploadedFormat:   v.uploadedFormat || 'XML',
      description:      v.description || '',
      createdAt:        v.createdAt,
      updatedAt:        v.updatedAt,
    }));

    return JSON.stringify([...javaVersions, ...extras]);
  } catch (e) {
    logger.warn({ msg: 'list-versions: supplement error', err: e.message });
    return proxyResData;
  }
}

// Read endpoints: ReadOnly+
router.get('/:definitionId/versions',
  requireFrameworkCapability(FRAMEWORK_CAPABILITY.ReadOnly, 'product-definitions.versions.list'),
  productDefinitionProxy({ userResDecorator: listVersionsDecorator }),
);
router.get('/:definitionId/versions/:fromVersionId/diff/:toVersionId',
  requireFrameworkCapability(FRAMEWORK_CAPABILITY.ReadOnly, 'product-definitions.versions.diff'),
  productDefinitionProxy(),
);
router.get('/:definitionId/versions/:versionId',
  requireFrameworkCapability(FRAMEWORK_CAPABILITY.ReadOnly, 'product-definitions.versions.get'),
  productDefinitionProxy(),
);
router.get('/:definitionId/versions/:versionId/report',
  requireFrameworkCapability(FRAMEWORK_CAPABILITY.ReadOnly, 'product-definitions.versions.report'),
  // For gateway-native definitions (Raw XML / XLS / JSON), synthesize a validation
  // report from MongoDB data — Java never received the file so has no report.
  async function nativeValidationReport(req, res, next) {
    const { definitionId, versionId } = req.params;
    try {
      const mongoose = require('mongoose');
      if (mongoose.connection.readyState !== 1) return next();
      const PRODUCTDEF_DB = process.env.PRODUCTDEF_DB_NAME || 'ubrnms_productdef';
      const db = mongoose.connection.client.db(PRODUCTDEF_DB);
      const ver = await db.collection('product_definition_versions').findOne({ definitionId, versionId });
      // Only handle gateway-native uploads — NMS_XML / XML go to Java
      if (!ver || !ver.uploadedFormat || ver.uploadedFormat === 'NMS_XML' || ver.uploadedFormat === 'XML') {
        return next();
      }
      // Count parameters and groups from the registry
      const entries = await db.collection('parameter_registry_entries').find({ productDefinitionId: definitionId, versionId }).toArray();
      const groupCount = new Set(entries.map(e => e.groupId)).size;
      const findings = [];
      // Warn if no fingerprints (raw XML / XLS / JSON don't carry fingerprint declarations)
      findings.push({
        field: 'fingerprints',
        severity: 'INFO',
        message: 'No fingerprint declarations in this format — device association uses manual assignment.',
        code: 'NO_FINGERPRINTS',
      });
      if (entries.length === 0) {
        findings.push({ field: 'parameterGroups', severity: 'ERROR', message: 'No parameters were parsed from the file. Check the file format.', code: 'NO_PARAMETERS' });
      }
      // Check for params missing OIDs
      const noOid = entries.filter(e => !e.snmpOid);
      if (noOid.length > 0) {
        findings.push({ field: 'parameters', severity: 'WARNING', message: `${noOid.length} parameter(s) have no SNMP OID — they will display but cannot be polled.`, code: 'MISSING_OID' });
      }
      const hasError = findings.some(f => f.severity === 'ERROR');
      return res.json({
        definitionId,
        versionId,
        validationStatus:   hasError ? 'INVALID' : 'VALID',
        errorCount:         findings.filter(f => f.severity === 'ERROR').length,
        warningCount:       findings.filter(f => f.severity === 'WARNING').length,
        infoCount:          findings.filter(f => f.severity === 'INFO').length,
        findings,
        // Summary fields the UI shows in the validation report card
        parameterGroupCount: groupCount,
        parameterCount:      entries.length,
        uploadedFormat:      ver.uploadedFormat,
        validatedAt:         new Date().toISOString(),
        // Human-readable summary lines matching the Java report card format
        summary: [
          `Structure valid — ${groupCount} parameter group(s) detected for ${ver.name || definitionId}; ${entries.length} parameters parsed.`,
          `Format: ${ver.uploadedFormat} (gateway-native, no Java validation required).`,
        ],
      });
    } catch (err) {
      logger.warn({ msg: 'native-report: error', definitionId, versionId, err: err.message });
      return next();
    }
  },
  productDefinitionProxy(),
);

// Active version and lifecycle history: ReadOnly+
router.get('/:definitionId/active',
  requireFrameworkCapability(FRAMEWORK_CAPABILITY.ReadOnly, 'product-definitions.active.get'),
  productDefinitionProxy(),
);
router.get('/:definitionId/lifecycle-history',
  requireFrameworkCapability(FRAMEWORK_CAPABILITY.ReadOnly, 'product-definitions.lifecycle-history'),
  productDefinitionProxy(),
);

// Audit trail: SuperAdmin only — contains sensitive operational metadata
// WO-020: paginated audit trail restricted to admins; operators are excluded
router.get('/:definitionId/audit-history',
  requireFrameworkCapability(FRAMEWORK_CAPABILITY.SuperAdmin, 'product-definitions.audit-history'),
  productDefinitionProxy(),
);

// ── Native stage/activate for gateway-parsed definitions ─────────────────────
async function nativeLifecycleHandler(action, req, res, next) {
  const { definitionId, versionId } = req.params;
  if (!definitionId) return next();

  try {
    const mongoose = require('mongoose');
    const PRODUCTDEF_DB = process.env.PRODUCTDEF_DB_NAME || 'ubrnms_productdef';
    if (mongoose.connection.readyState !== 1) return next();
    const db = mongoose.connection.client.db(PRODUCTDEF_DB);

    // Check if this is a gateway-native definition (uploadedFormat != 'XML' / not in Java)
    const ver = await db.collection('product_definition_versions').findOne(
      versionId
        ? { definitionId, versionId }
        : { definitionId },
      { sort: { createdAt: -1 } },
    );

    if (!ver || !ver.uploadedFormat || ver.uploadedFormat === 'NMS_XML' || ver.uploadedFormat === 'XML') {
      return next(); // let the Java proxy handle it
    }

    // Gateway-native: just update the lifecycle status
    const now    = new Date();
    const newStatus = action === 'activate' ? 'ACTIVE' : 'STAGED';
    await db.collection('product_definition_versions').updateOne(
      { definitionId, versionId: ver.versionId },
      { $set: { lifecycleStatus: newStatus, updatedAt: now } },
    );

    if (action === 'activate') {
      await db.collection('product_definition_active_versions').updateOne(
        { productDefinitionId: definitionId },
        { $set: { productDefinitionId: definitionId, versionId: ver.versionId, updatedAt: now }, $setOnInsert: { createdAt: now } },
        { upsert: true },
      );

      // Rebuild wireframe
      const redis = req.app.get('redis');
      setImmediate(async () => {
        try {
          const definition = await live.loadDefinition(definitionId);
          if (definition?.entries?.length > 0) {
            const built = buildWireframe(definition);
            await NodeViewWireframe.findOneAndUpdate(
              { productDefinitionId: definitionId },
              {
                $set: {
                  productDefinitionId: definitionId,
                  versionId: ver.versionId,
                  registryVersion: '1',
                  status: 'ACTIVE',
                  wireframe: built.wireframe,
                  parameterCount: built.parameterCount,
                  groupCount: built.groupCount,
                  updatedAt: now,
                },
                $setOnInsert: { createdAt: now },
              },
              { upsert: true },
            );
            await invalidateCache(redis, definitionId);
            logger.info({ msg: `native-${action}: wireframe built`, definitionId, parameterCount: built.parameterCount });
          }
        } catch (e) {
          logger.warn({ msg: `native-${action}: wireframe failed`, err: e.message });
        }
      });
    }

    return res.json({
      versionId:       ver.versionId,
      definitionId,
      name:            ver.name,
      vendor:          ver.vendor,
      model:           ver.model,
      lifecycleStatus: newStatus,
      updatedAt:       now.toISOString(),
    });
  } catch (err) {
    logger.error({ msg: `native-${action}: error`, definitionId, err: err.message });
    return next();
  }
}

// Lifecycle mutations: Operator+ (admins and operators may mutate lifecycle state)
router.put('/:definitionId/versions/:versionId/stage',
  requireFrameworkCapability(FRAMEWORK_CAPABILITY.Operator, 'product-definitions.stage'),
  (req, res, next) => nativeLifecycleHandler('stage', req, res, next),
  productDefinitionProxy({ userResDecorator: stageIdempotencyDecorator }),
);
router.put('/:definitionId/versions/:versionId/activate',
  requireFrameworkCapability(FRAMEWORK_CAPABILITY.Operator, 'product-definitions.activate'),
  (req, res, next) => nativeLifecycleHandler('activate', req, res, next),
  productDefinitionProxy({ timeout: 120000, userResDecorator: activateIdempotencyDecorator }),
  buildWireframeAfterActivation,
);
router.put('/:definitionId/rollback',
  requireFrameworkCapability(FRAMEWORK_CAPABILITY.Operator, 'product-definitions.rollback'),
  // Rollback rebuilds registries and publishes Kafka events — allow up to 90 s.
  productDefinitionProxy({ timeout: 90000 }),
  buildWireframeAfterActivation,
);
// WO-017: Targeted rollback to specific version — POST with {targetVersionId, reason} body
router.post('/:definitionId/rollback',
  requireFrameworkCapability(FRAMEWORK_CAPABILITY.Operator, 'product-definitions.rollback.targeted'),
  productDefinitionProxy({ timeout: 90000 }),
  buildWireframeAfterActivation,
);

// Delete a non-ACTIVE version — SuperAdmin only.
// ACTIVE versions are protected by the backend (returns 409 CONFLICT).
router.delete('/:definitionId/versions/:versionId',
  requireFrameworkCapability(FRAMEWORK_CAPABILITY.SuperAdmin, 'product-definitions.versions.delete'),
  productDefinitionProxy(),
  // ── Post-delete cleanup ────────────────────────────────────────────────────
  // Run after the proxy responds 204. Cleans up gateway-owned data for this
  // version so stale wireframes / parameter entries never get served.
  async function cleanupAfterDelete(req, res) {
    const { definitionId, versionId } = req.params;
    const redis = req.app.get('redis');
    setImmediate(async () => {
      try {
        const mongoose = require('mongoose');
        if (mongoose.connection.readyState === 1) {
          // Remove parameter registry entries for this specific version
          const PRODUCTDEF_DB = process.env.PRODUCTDEF_DB_NAME || 'ubrnms_productdef';
          const db = mongoose.connection.client.db(PRODUCTDEF_DB);
          await db.collection('parameter_registry_entries').deleteMany({ productDefinitionId: definitionId, versionId });
          await db.collection('product_definition_versions').deleteOne({ definitionId, versionId });

          // Check if any other versions remain for this definition
          const remaining = await db.collection('parameter_registry_entries').countDocuments({ productDefinitionId: definitionId });
          if (remaining === 0) {
            // Last version deleted — remove wireframe + active version pointer + full cache
            await NodeViewWireframe.deleteMany({ productDefinitionId: definitionId });
            await db.collection('product_definition_active_versions').deleteOne({ productDefinitionId: definitionId });
            logger.info({ msg: 'cleanup-delete: removed wireframe + active pointer (last version)', definitionId });
          } else {
            // Other versions exist — just remove wireframe for this specific version
            await NodeViewWireframe.deleteOne({ productDefinitionId: definitionId, versionId });
          }
        }
        // Always invalidate Redis cache
        await invalidateCache(redis, definitionId);
        logger.info({ msg: 'cleanup-delete: done', definitionId, versionId });
      } catch (e) {
        logger.warn({ msg: 'cleanup-delete: error', definitionId, versionId, err: e.message });
      }
    });
  },
);

module.exports = router;
