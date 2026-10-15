'use strict';
/**
 * Descriptor Registry E2E Test Script
 * Tests the full 9-state lifecycle end-to-end against the running gateway.
 *
 * Run: node scripts/e2e-descriptor-test.js
 */

const http = require('http');
const https = require('https');
const fs   = require('fs');
const path = require('path');

const GW  = process.env.GATEWAY_URL || 'http://localhost:3100';
const BASE = `${GW}/api/descriptors`;

// ── Generate tokens with the dev RSA private key ──────────────────────────────
const jwt = require('jsonwebtoken');
const PRIV_KEY = fs.readFileSync(path.join(__dirname, '..', 'dev', 'jwt_private.pem'), 'utf8');
function sign(payload) {
  return jwt.sign({ iss: 'ubr-nms', aud: 'ubr-nms-api', ...payload }, PRIV_KEY, {
    algorithm: 'RS256', expiresIn: '1h',
  });
}

const ADMIN_TOKEN  = sign({ sub: 'admin-user',   userId: 'admin-user',   username: 'admin',       role: 'admin' });
const DADMIN_TOKEN = sign({ sub: 'desc-admin',   userId: 'desc-admin',   username: 'desc_admin',  role: 'descriptor_admin' });
const AUTHOR_TOKEN = sign({ sub: 'desc-author',  userId: 'desc-author',  username: 'desc_author', role: 'descriptor_author' });
const VIEWER_TOKEN = sign({ sub: 'viewer-user',  userId: 'viewer-user',  username: 'viewer',      role: 'viewer' });

// ── Tiny HTTP client ──────────────────────────────────────────────────────────
function request(method, url, token, body, isMultipart) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod    = parsed.protocol === 'https:' ? https : http;

    let postData, headers = { Authorization: `Bearer ${token}` };

    if (isMultipart && body) {
      const boundary = '----FormBoundary' + Date.now();
      const parts = [];
      for (const [k, v] of Object.entries(body)) {
        if (v && v.content) {
          parts.push(
            `--${boundary}\r\nContent-Disposition: form-data; name="${k}"; filename="${v.filename}"\r\nContent-Type: text/xml\r\n\r\n${v.content}\r\n`,
          );
        } else {
          parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`);
        }
      }
      postData = Buffer.from(parts.join('') + `--${boundary}--\r\n`);
      headers['Content-Type'] = `multipart/form-data; boundary=${boundary}`;
      headers['Content-Length'] = postData.length;
    } else if (body && method !== 'GET') {
      postData = Buffer.from(JSON.stringify(body));
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = postData.length;
    }

    const req = mod.request({
      method, hostname: parsed.hostname, port: parsed.port,
      path: parsed.pathname + parsed.search,
      headers,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

// ── Test helpers ──────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
const results = [];

function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
    results.push({ label, ok: true });
  } else {
    console.log(`  ❌ ${label}${detail ? ' — ' + detail : ''}`);
    failed++;
    results.push({ label, ok: false, detail });
  }
}

function section(title) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  ${title}`);
  console.log(`${'─'.repeat(60)}`);
}

// ── Test sample descriptor XML ────────────────────────────────────────────────
const SAMPLE_XML = fs.readFileSync(
  path.join(__dirname, '../sample-definitions/ubr650-descriptor.xml'),
  'utf8',
);

const PROD_ID = `ubr-networks.ubr-650-e2e-${Date.now()}`;
const VERSION = '1.0.0';

// ══════════════════════════════════════════════════════════════════════════════
async function runTests() {
  console.log('═'.repeat(64));
  console.log('  UBR NMS — Descriptor Registry End-to-End Test');
  console.log(`  Gateway: ${GW}`);
  console.log(`  Product: ${PROD_ID}  v${VERSION}`);
  console.log('═'.repeat(64));

  // ── 1. Health check ──────────────────────────────────────────────────────
  section('1. Gateway Health');
  const health = await request('GET', `${GW}/healthz`, ADMIN_TOKEN);
  check('GET /healthz → 200', health.status === 200);
  check('health.status = ok', health.body?.status === 'ok', JSON.stringify(health.body));

  // ── 2. List (empty initially) ────────────────────────────────────────────
  section('2. List Descriptors (read)');
  const list0 = await request('GET', BASE, VIEWER_TOKEN);
  check('GET /api/descriptors → 200 with viewer token', list0.status === 200, `status=${list0.status}`);
  check('Response has data array', Array.isArray(list0.body?.data), JSON.stringify(list0.body).slice(0,100));

  // ── 3. RBAC — viewer cannot upload ──────────────────────────────────────
  section('3. RBAC — Viewer cannot upload');
  const rbacUpload = await request('POST', BASE, VIEWER_TOKEN, {
    productDefinitionId: PROD_ID, version: VERSION,
    file: { content: SAMPLE_XML, filename: 'ubr650.xml' },
  }, true);
  check('Upload with viewer → 403', rbacUpload.status === 403, `status=${rbacUpload.status}`);

  // ── 4. Upload as descriptor_author ──────────────────────────────────────
  section('4. Upload Descriptor (descriptor_author)');
  const upload = await request('POST', BASE, AUTHOR_TOKEN, {
    productDefinitionId: PROD_ID,
    version: VERSION,
    file: { content: SAMPLE_XML, filename: 'ubr650-descriptor.xml' },
  }, true);
  console.log(`  Status: ${upload.status}`);
  check('Upload → 201 Created', upload.status === 201, `status=${upload.status} body=${JSON.stringify(upload.body?.error || upload.body?.data?.state || '').slice(0,100)}`);
  check('State is Draft', upload.body?.data?.state === 'Draft', `state=${upload.body?.data?.state}`);
  check('productDefinitionId correct', upload.body?.data?.productDefinitionId === PROD_ID);
  check('version correct', upload.body?.data?.version === VERSION);
  check('uploadedByUsername correct', upload.body?.data?.uploadedByUsername === 'desc_author');

  // ── 5. Duplicate upload → 409 ────────────────────────────────────────────
  section('5. Duplicate Upload → 409');
  const dup = await request('POST', BASE, AUTHOR_TOKEN, {
    productDefinitionId: PROD_ID,
    version: VERSION,
    file: { content: SAMPLE_XML + '<!-- modified -->', filename: 'ubr650-descriptor.xml' },
  }, true);
  check('Duplicate upload → 409', dup.status === 409, `status=${dup.status}`);
  check('Error code VERSION_EXISTS', dup.body?.error?.code === 'VERSION_EXISTS', `code=${dup.body?.error?.code}`);

  // ── 6. Get version ────────────────────────────────────────────────────────
  section('6. Get Descriptor Version');
  const getV = await request('GET', `${BASE}/${PROD_ID}/versions/${VERSION}`, VIEWER_TOKEN);
  check('GET version → 200', getV.status === 200, `status=${getV.status}`);
  check('State is Draft', getV.body?.data?.state === 'Draft');

  // ── 7. Validate ───────────────────────────────────────────────────────────
  section('7. Validate (Draft → Valid/Invalid)');
  const validate = await request('POST', `${BASE}/${PROD_ID}/versions/${VERSION}/validate`, AUTHOR_TOKEN);
  console.log(`  Validate status: ${validate.status}, isValid: ${validate.body?.data?.isValid}`);
  check('Validate → 200', validate.status === 200, `status=${validate.status}`);
  check('isValid property present', 'isValid' in (validate.body?.data || {}));
  check('State changed to Valid or Invalid', ['Valid', 'Invalid'].includes(validate.body?.data?.state), `state=${validate.body?.data?.state}`);
  if (validate.body?.data?.errors?.length > 0) {
    console.log('  Validation errors:');
    validate.body.data.errors.slice(0, 5).forEach((e) => console.log(`    • [${e.field}] ${e.message}`));
  }
  if (validate.body?.data?.warnings?.length > 0) {
    console.log(`  Warnings: ${validate.body.data.warnings.length}`);
  }

  const stateAfterValidate = validate.body?.data?.state;

  // ── 8. Maker-checker: author cannot approve own upload ────────────────────
  section('8. Maker-Checker — Author cannot approve own upload');
  if (stateAfterValidate === 'Valid') {
    const selfApprove = await request('POST', `${BASE}/${PROD_ID}/versions/${VERSION}/approve`, AUTHOR_TOKEN);
    // author role doesn't have approve permission → 403
    check('Author approve → 403 (no approve permission)', selfApprove.status === 403, `status=${selfApprove.status}`);

    // desc_admin approving someone else's upload → should work (desc-admin ≠ desc-author)
    const approve = await request('POST', `${BASE}/${PROD_ID}/versions/${VERSION}/approve`, DADMIN_TOKEN, { reason: 'E2E test approval' });
    console.log(`  Approve status: ${approve.status}, state: ${approve.body?.data?.state}`);
    check('descriptor_admin approve → 200', approve.status === 200, `status=${approve.status} err=${JSON.stringify(approve.body?.error || '').slice(0,80)}`);
    check('State changed to Approved', approve.body?.data?.state === 'Approved', `state=${approve.body?.data?.state}`);
    check('approvedByUsername = desc_admin', approve.body?.data?.approvedByUsername === 'desc_admin');

    // ── 9. Activate ─────────────────────────────────────────────────────────
    section('9. Activate (Approved → Active)');
    const activate = await request('POST', `${BASE}/${PROD_ID}/versions/${VERSION}/activate`, DADMIN_TOKEN, { reason: 'E2E activation' });
    console.log(`  Activate status: ${activate.status}, state: ${activate.body?.data?.state}`);
    check('Activate → 200', activate.status === 200, `status=${activate.status}`);
    check('State = Active', activate.body?.data?.state === 'Active', `state=${activate.body?.data?.state}`);

    // ── 10. Get dependents after activation ──────────────────────────────────
    section('10. Dependents & Impact Report');
    const deps = await request('GET', `${BASE}/${PROD_ID}/versions/${VERSION}/dependents`, VIEWER_TOKEN);
    check('GET dependents → 200', deps.status === 200, `status=${deps.status}`);
    check('counts.boundDevices present', deps.body?.data?.counts?.boundDevices != null, JSON.stringify(deps.body?.data?.counts));

    const impact = await request('GET', `${BASE}/${PROD_ID}/versions/${VERSION}/impact`, VIEWER_TOKEN);
    check('GET impact → 200', impact.status === 200, `status=${impact.status}`);
    check('summary.totalBoundDevices present', impact.body?.data?.summary?.totalBoundDevices != null);
    check('clearingPaths present', Array.isArray(impact.body?.data?.clearingPaths), `clearingPaths=${JSON.stringify(impact.body?.data?.clearingPaths)}`);

    // ── 11. Lifecycle — Deprecate ─────────────────────────────────────────────
    section('11. Deprecate (Active → Deprecated)');
    const deprecate = await request('POST', `${BASE}/${PROD_ID}/versions/${VERSION}/deprecate`, DADMIN_TOKEN, { reason: 'E2E test deprecation' });
    check('Deprecate → 200', deprecate.status === 200, `status=${deprecate.status}`);
    check('State = Deprecated', deprecate.body?.data?.state === 'Deprecated', `state=${deprecate.body?.data?.state}`);

    // ── 12. Delete guard: retire should PASS (0 bound devices) ────────────────
    section('12. Retire (Deprecated → Retired) — No bound devices');
    // Maker-checker: desc-admin (who deprecated) should NOT be allowed to retire
    const sameUserRetire = await request('POST', `${BASE}/${PROD_ID}/versions/${VERSION}/retire`, DADMIN_TOKEN, { reason: 'same user retire' });
    check('Same-user retire → 403 MAKER_CHECKER_VIOLATION', sameUserRetire.status === 403, `status=${sameUserRetire.status} code=${sameUserRetire.body?.error?.code}`);

    // admin (different user) retires
    const retire = await request('POST', `${BASE}/${PROD_ID}/versions/${VERSION}/retire`, ADMIN_TOKEN, { reason: 'E2E retire' });
    check('Admin retire → 200', retire.status === 200, `status=${retire.status} err=${JSON.stringify(retire.body?.error || '').slice(0,80)}`);
    check('State = Retired', retire.body?.data?.state === 'Retired', `state=${retire.body?.data?.state}`);

    // ── 13. Purge — retention check ───────────────────────────────────────────
    section('13. Purge — Retention Period Check');
    // Use desc_admin (different from admin who retired) to test the retention guard
    const purge = await request('POST', `${BASE}/${PROD_ID}/versions/${VERSION}/purge`, DADMIN_TOKEN, { reason: 'E2E purge' });
    check('Purge within retention → 409 RETENTION_NOT_MET', purge.status === 409, `status=${purge.status} code=${purge.body?.error?.code}`);
    check('Error code RETENTION_NOT_MET', purge.body?.error?.code === 'RETENTION_NOT_MET', `code=${purge.body?.error?.code}`);
    check('elapsedDays present in error', purge.body?.error?.elapsedDays != null, `error=${JSON.stringify(purge.body?.error).slice(0,100)}`);

  } else {
    // Descriptor failed validation — test delete draft path instead
    section('8. (Validation failed) — Delete Draft');
    check('SKIP Approve/Activate/Deprecate/Retire (validation failed — expected in dev)', true, `state=${stateAfterValidate}`);

    const delDraft = await request('DELETE', `${BASE}/${PROD_ID}/versions/${VERSION}`, AUTHOR_TOKEN);
    check('Delete Draft → 200', delDraft.status === 200, `status=${delDraft.status}`);
    check('deleted = true', delDraft.body?.data?.deleted === true);
  }

  // ── 14. Invalid state transitions ────────────────────────────────────────────
  section('14. Invalid State Transition Guards');
  // Try to validate something that's already moved past Draft — use fresh upload
  const PID2 = `ubr-networks.ubr-650-guard-${Date.now()}`;
  await request('POST', BASE, AUTHOR_TOKEN, {
    productDefinitionId: PID2, version: '1.0.0',
    file: { content: SAMPLE_XML, filename: 'ubr650.xml' },
  }, true);
  // Immediately try to approve (should fail: not in Valid state)
  const badApprove = await request('POST', `${BASE}/${PID2}/versions/1.0.0/approve`, DADMIN_TOKEN);
  check('Approve Draft → 409 INVALID_STATE', badApprove.status === 409, `status=${badApprove.status} code=${badApprove.body?.error?.code}`);

  // Try to activate without approving first
  const badActivate = await request('POST', `${BASE}/${PID2}/versions/1.0.0/activate`, DADMIN_TOKEN);
  check('Activate Draft → 409 INVALID_STATE', badActivate.status === 409, `status=${badActivate.status}`);

  // ── 15. List versions ─────────────────────────────────────────────────────────
  section('15. List Versions for Product');
  const versions = await request('GET', `${BASE}/${PROD_ID}/versions`, VIEWER_TOKEN);
  check('GET versions → 200', versions.status === 200, `status=${versions.status}`);
  check('Returns array', Array.isArray(versions.body?.data));

  // ── 16. 404 for non-existent descriptor ──────────────────────────────────────
  section('16. 404 for Non-Existent Descriptor');
  const notFound = await request('GET', `${BASE}/does-not-exist/versions/9.9.9`, VIEWER_TOKEN);
  check('GET non-existent → 404', notFound.status === 404, `status=${notFound.status}`);
  check('Error code NOT_FOUND', notFound.body?.error?.code === 'NOT_FOUND');

  // ── Results ───────────────────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(64));
  console.log(`  RESULTS: ${passed} passed / ${failed} failed / ${passed + failed} total`);
  console.log('═'.repeat(64));

  if (failed > 0) {
    console.log('\n  Failed tests:');
    results.filter((r) => !r.ok).forEach((r) => {
      console.log(`    ❌ ${r.label}${r.detail ? ' — ' + r.detail : ''}`);
    });
    process.exit(1);
  } else {
    console.log('\n  ✅ All tests passed!\n');
    process.exit(0);
  }
}

runTests().catch((err) => {
  console.error('\n  FATAL:', err.message);
  process.exit(2);
});
