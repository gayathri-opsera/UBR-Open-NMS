package com.ubrnms.productdef.controller;

import com.ubrnms.productdef.lifecycle.ProductDefinitionLifecycleException;
import com.ubrnms.productdef.model.ProductDefinitionLifecycleEvent;
import com.ubrnms.productdef.model.ProductDefinitionVersion;
import com.ubrnms.productdef.model.ValidationReport;
import com.ubrnms.productdef.model.VersionDiffResult;
import com.ubrnms.productdef.service.ProductDefinitionAuditService;
import com.ubrnms.productdef.service.ProductDefinitionLifecycleService;
import com.ubrnms.productdef.service.ProductDefinitionService;
import com.ubrnms.productdef.service.PublishGateViolation;
import com.ubrnms.productdef.service.VersionDiffService;
import java.util.ConcurrentModificationException;
import org.springframework.data.domain.Page;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

import java.util.List;
import java.util.Map;
import java.util.NoSuchElementException;

/**
 * REST controller for Framework Product Definitions.
 *
 * <p>All endpoints are prefixed {@code /api/v1/framework/product-definitions}.
 * Authentication and RBAC are enforced upstream by the API gateway — this
 * controller trusts the gateway-injected headers ({@code X-User-Id},
 * {@code X-Username}, {@code X-User-Role}).
 */
@Slf4j
@RestController
@RequestMapping("/api/v1/framework/product-definitions")
@RequiredArgsConstructor
public class ProductDefinitionController {

    private final ProductDefinitionService          service;
    private final ProductDefinitionLifecycleService lifecycleService;
    private final ProductDefinitionAuditService     auditService;
    private final VersionDiffService                versionDiffService;

    // ── POST /upload ──────────────────────────────────────────────────────────

    /**
     * Upload a new product definition (XML, XLS, or JSON).
     *
     * @return 201 Created with the persisted version record, or 400/409/422 on error.
     */
    @PostMapping(value = "/upload", consumes = "multipart/form-data")
    public ResponseEntity<?> upload(
            @RequestParam("file")                  MultipartFile file,
            @RequestParam(value = "description", required = false) String description,
            @RequestHeader(value = "X-Correlation-Id", defaultValue = "")   String correlationId,
            @RequestHeader(value = "X-User-Id",    defaultValue = "unknown") String userId,
            @RequestHeader(value = "X-Username",   defaultValue = "unknown") String username,
            @RequestHeader(value = "X-User-Role",  defaultValue = "viewer")  String role) {

        if (file == null || file.isEmpty()) {
            return ResponseEntity.badRequest()
                    .body(errorBody("FILE_REQUIRED", "No file was attached to the request"));
        }

        try {
            byte[] bytes = file.getBytes();
            String contentType = file.getContentType();
            ProductDefinitionVersion version = service.upload(
                    bytes, contentType, description, userId, username, role, correlationId);

            return ResponseEntity.status(HttpStatus.CREATED).body(version);

        } catch (IllegalArgumentException e) {
            log.warn("[{}] Bad upload request: {}", correlationId, e.getMessage());
            return ResponseEntity.status(HttpStatus.UNPROCESSABLE_ENTITY)
                    .body(errorBody("UPLOAD_REJECTED", e.getMessage()));
        } catch (Exception e) {
            log.error("[{}] Unexpected upload error", correlationId, e);
            return ResponseEntity.internalServerError()
                    .body(errorBody("INTERNAL_ERROR", "An unexpected error occurred during upload"));
        }
    }

    // ── GET /history ──────────────────────────────────────────────────────────
    // Returns every uploaded version across all definitions, newest first.
    // Restricted to Admin/SuperAdmin at the gateway; used by the All-Uploads admin view.

    @GetMapping("/history")
    public ResponseEntity<?> listAllVersionHistory() {
        try {
            List<ProductDefinitionVersion> all = service.listAllVersions();
            return ResponseEntity.ok(all);
        } catch (Exception e) {
            log.error("Error retrieving global version history", e);
            return ResponseEntity.internalServerError()
                    .body(errorBody("INTERNAL_ERROR", "Failed to retrieve upload history"));
        }
    }

    // ── GET /{definitionId}/versions ──────────────────────────────────────────

    @GetMapping("/{definitionId}/versions")
    public ResponseEntity<?> listVersions(@PathVariable String definitionId) {
        try {
            List<ProductDefinitionVersion> versions = service.listVersions(definitionId);
            return ResponseEntity.ok(versions);
        } catch (Exception e) {
            log.error("Error listing versions for definitionId={}", definitionId, e);
            return ResponseEntity.internalServerError()
                    .body(errorBody("INTERNAL_ERROR", "Failed to retrieve versions"));
        }
    }

    // ── GET /{definitionId}/versions/{versionId} ──────────────────────────────

    @GetMapping("/{definitionId}/versions/{versionId}")
    public ResponseEntity<?> getVersion(@PathVariable String definitionId,
                                         @PathVariable String versionId) {
        try {
            ProductDefinitionVersion version = service.getVersion(definitionId, versionId);
            return ResponseEntity.ok(version);
        } catch (NoSuchElementException e) {
            return ResponseEntity.status(HttpStatus.NOT_FOUND)
                    .body(errorBody("NOT_FOUND", e.getMessage()));
        } catch (Exception e) {
            log.error("Error retrieving version definitionId={} versionId={}", definitionId, versionId, e);
            return ResponseEntity.internalServerError()
                    .body(errorBody("INTERNAL_ERROR", "Failed to retrieve version"));
        }
    }

    // ── GET /{definitionId}/versions/{versionId}/report ───────────────────────

    @GetMapping("/{definitionId}/versions/{fromVersionId}/diff/{toVersionId}")
    public ResponseEntity<?> diffVersions(
            @PathVariable String definitionId,
            @PathVariable String fromVersionId,
            @PathVariable String toVersionId) {
        try {
            VersionDiffResult result = versionDiffService.diff(definitionId, fromVersionId, toVersionId);
            return ResponseEntity.ok(result);
        } catch (NoSuchElementException e) {
            return ResponseEntity.status(HttpStatus.NOT_FOUND)
                    .body(errorBody("NOT_FOUND", e.getMessage()));
        } catch (Exception e) {
            log.error("Error diffing versions definitionId={} from={} to={}",
                    definitionId, fromVersionId, toVersionId, e);
            return ResponseEntity.internalServerError()
                    .body(errorBody("INTERNAL_ERROR", "Failed to compute version diff"));
        }
    }

    @GetMapping("/{definitionId}/versions/{versionId}/report")
    public ResponseEntity<?> getValidationReport(@PathVariable String definitionId,
                                                  @PathVariable String versionId) {
        try {
            ValidationReport report = service.getReport(definitionId, versionId);
            return ResponseEntity.ok(report);
        } catch (NoSuchElementException e) {
            return ResponseEntity.status(HttpStatus.NOT_FOUND)
                    .body(errorBody("NOT_FOUND", e.getMessage()));
        } catch (Exception e) {
            log.error("Error retrieving report definitionId={} versionId={}", definitionId, versionId, e);
            return ResponseEntity.internalServerError()
                    .body(errorBody("INTERNAL_ERROR", "Failed to retrieve validation report"));
        }
    }

    // ── GET / (list definitions) ──────────────────────────────────────────────

    @GetMapping
    public ResponseEntity<?> listDefinitions() {
        try {
            return ResponseEntity.ok(lifecycleService.listDefinitions());
        } catch (Exception e) {
            log.error("Error listing definitions", e);
            return ResponseEntity.internalServerError()
                    .body(errorBody("INTERNAL_ERROR", "Failed to list definitions"));
        }
    }

    // ── PUT /{definitionId}/versions/{versionId}/stage ───────────────────────

    /**
     * Moves a VALID DRAFT version to STAGED.
     *
     * <p>Only VALID definitions may be staged — invalid or unknown versions are rejected
     * with 422.
     */
    @PutMapping("/{definitionId}/versions/{versionId}/stage")
    public ResponseEntity<?> stageVersion(
            @PathVariable String definitionId,
            @PathVariable String versionId,
            @RequestParam(value = "idempotencyKey",  required = false)  String idempotencyKey,
            @RequestHeader(value = "X-Expected-Version", required = false) Long expectedVersion,
            @RequestHeader(value = "X-Correlation-Id", defaultValue = "") String correlationId,
            @RequestHeader(value = "X-User-Id",    defaultValue = "unknown") String userId,
            @RequestHeader(value = "X-Username",   defaultValue = "unknown") String username,
            @RequestHeader(value = "X-User-Role",  defaultValue = "viewer")  String role) {
        try {
            ProductDefinitionVersion staged = lifecycleService.stageVersion(
                    definitionId, versionId, expectedVersion, idempotencyKey, userId, username, correlationId);
            return ResponseEntity.ok(staged);
        } catch (NoSuchElementException e) {
            return ResponseEntity.status(HttpStatus.NOT_FOUND)
                    .body(errorBody("VERSION_NOT_FOUND", e.getMessage()));
        } catch (ConcurrentModificationException e) {
            // WO-022: Optimistic lock conflict
            log.warn("[{}] Stage version conflict: {}", correlationId, e.getMessage());
            return ResponseEntity.status(HttpStatus.CONFLICT)
                    .body(errorBody("VERSION_CONFLICT", e.getMessage()));
        } catch (ProductDefinitionLifecycleException e) {
            log.warn("[{}] Stage rejected — {}: {}", correlationId, e.getErrorCode(), e.getMessage());
            return ResponseEntity.status(HttpStatus.CONFLICT)
                    .body(errorBody(e.getErrorCode(), e.getMessage()));
        } catch (IllegalArgumentException e) {
            log.warn("[{}] Stage rejected: {}", correlationId, e.getMessage());
            return ResponseEntity.status(HttpStatus.UNPROCESSABLE_ENTITY)
                    .body(errorBody("VALIDATION_REQUIRED", e.getMessage()));
        } catch (Exception e) {
            log.error("[{}] Unexpected error staging version {}", correlationId, versionId, e);
            return ResponseEntity.internalServerError()
                    .body(errorBody("INTERNAL_ERROR", "Failed to stage version " + versionId));
        }
    }

    // ── PUT /{definitionId}/versions/{versionId}/activate ────────────────────

    /**
     * Activates a STAGED version, rebuilding fingerprint and parameter registries atomically.
     *
     * <p>Returns HTTP 409 when activation conflicts are detected.  The previous active
     * registry version is preserved and returned in the error body for operator reference.
     */
    @PutMapping("/{definitionId}/versions/{versionId}/activate")
    public ResponseEntity<?> activateVersion(
            @PathVariable String definitionId,
            @PathVariable String versionId,
            @RequestParam(value = "idempotencyKey", required = false) String idempotencyKey,
            @RequestHeader(value = "X-Correlation-Id", defaultValue = "") String correlationId,
            @RequestHeader(value = "X-User-Id",    defaultValue = "unknown") String userId,
            @RequestHeader(value = "X-Username",   defaultValue = "unknown") String username,
            @RequestHeader(value = "X-User-Role",  defaultValue = "viewer")  String role) {
        try {
            Map<String, Object> result = lifecycleService.activateVersion(
                    definitionId, versionId, idempotencyKey, userId, username, correlationId);
            return ResponseEntity.ok(result);
        } catch (NoSuchElementException e) {
            return ResponseEntity.status(HttpStatus.NOT_FOUND)
                    .body(errorBody("VERSION_NOT_FOUND", e.getMessage()));
        } catch (PublishGateViolation gv) {
            // WO-021: structured error identifies which gate failed
            log.warn("[{}] Publish gate blocked activation: gate={} message={}",
                    correlationId, gv.getGateName(), gv.getMessage());
            return ResponseEntity.status(HttpStatus.UNPROCESSABLE_ENTITY)
                    .body(Map.of(
                        "status", "error",
                        "error", Map.of(
                            "code",      gv.getGateName(),
                            "message",   gv.getMessage(),
                            "failedGate", gv.getGateName()
                        )
                    ));
        } catch (IllegalArgumentException e) {
            log.warn("[{}] Activation rejected: {}", correlationId, e.getMessage());
            return ResponseEntity.status(HttpStatus.UNPROCESSABLE_ENTITY)
                    .body(errorBody("ACTIVATION_BLOCKED", e.getMessage()));
        } catch (IllegalStateException e) {
            log.warn("[{}] Activation conflict: {}", correlationId, e.getMessage());
            return ResponseEntity.status(HttpStatus.CONFLICT)
                    .body(errorBody("CONFLICTING_FINGERPRINT", e.getMessage()));
        } catch (Exception e) {
            log.error("[{}] Unexpected error activating version {}", correlationId, versionId, e);
            return ResponseEntity.internalServerError()
                    .body(errorBody("INTERNAL_ERROR", "Failed to activate version " + versionId));
        }
    }

    // ── PUT /{definitionId}/rollback ──────────────────────────────────────────

    /**
     * Rolls back the current active version to the immediately previous active version.
     *
     * <p>Returns HTTP 409 when no previous active version is available.
     */
    @PutMapping("/{definitionId}/rollback")
    public ResponseEntity<?> rollbackVersion(
            @PathVariable String definitionId,
            @RequestParam(value = "reason", required = false, defaultValue = "Operator-requested rollback") String reason,
            @RequestParam(value = "idempotencyKey", required = false) String idempotencyKey,
            @RequestHeader(value = "X-Correlation-Id", defaultValue = "") String correlationId,
            @RequestHeader(value = "X-User-Id",    defaultValue = "unknown") String userId,
            @RequestHeader(value = "X-Username",   defaultValue = "unknown") String username,
            @RequestHeader(value = "X-User-Role",  defaultValue = "viewer")  String role) {
        try {
            Map<String, Object> result = lifecycleService.rollbackVersion(
                    definitionId, reason, idempotencyKey, userId, username, correlationId);
            return ResponseEntity.ok(result);
        } catch (NoSuchElementException e) {
            log.warn("[{}] Rollback not available: {}", correlationId, e.getMessage());
            return ResponseEntity.status(HttpStatus.CONFLICT)
                    .body(errorBody("ROLLBACK_NOT_AVAILABLE", e.getMessage()));
        } catch (IllegalArgumentException e) {
            log.warn("[{}] Rollback rejected: {}", correlationId, e.getMessage());
            return ResponseEntity.status(HttpStatus.CONFLICT)
                    .body(errorBody("ROLLBACK_NOT_AVAILABLE", e.getMessage()));
        } catch (Exception e) {
            log.error("[{}] Unexpected error rolling back definition {}", correlationId, definitionId, e);
            return ResponseEntity.internalServerError()
                    .body(errorBody("INTERNAL_ERROR", "Failed to roll back definition " + definitionId));
        }
    }

    // ── POST /{definitionId}/rollback (targeted rollback — WO-017) ───────────

    /**
     * Rolls back the current active version to a specific eligible historical version.
     *
     * <p>The request body must include {@code targetVersionId} (required) and
     * optional {@code reason}.  Eligible target versions must have
     * {@code validationStatus=VALID} and {@code lifecycleStatus} in {STAGED, SUPERSEDED}.
     *
     * <p>Authorization: SuperAdmin and FRAMEWORK_ADMIN roles only (enforced by API gateway).
     *
     * <p>Error codes returned in response body:
     * <ul>
     *   <li>{@code ROLLBACK_TARGET_INVALID} — target version does not exist or is ineligible</li>
     *   <li>{@code ROLLBACK_CONFLICT} — target version is already active</li>
     *   <li>{@code REGISTRY_REBUILD_FAILED} — registry rebuild failed; previous active version preserved</li>
     *   <li>{@code FORBIDDEN_ACTION} — caller role is not authorized</li>
     * </ul>
     */
    @PostMapping("/{definitionId}/rollback")
    public ResponseEntity<?> rollbackToVersion(
            @PathVariable String definitionId,
            @RequestBody  Map<String, String> body,
            @RequestHeader(value = "X-Correlation-Id", defaultValue = "") String correlationId,
            @RequestHeader(value = "X-User-Id",    defaultValue = "unknown") String userId,
            @RequestHeader(value = "X-Username",   defaultValue = "unknown") String username,
            @RequestHeader(value = "X-User-Role",  defaultValue = "viewer")  String role) {

        String targetVersionId = body != null ? body.get("targetVersionId") : null;
        String reason          = body != null ? body.getOrDefault("reason", "Administrator rollback") : "Administrator rollback";

        if (targetVersionId == null || targetVersionId.isBlank()) {
            return ResponseEntity.status(HttpStatus.BAD_REQUEST)
                    .body(errorBody("ROLLBACK_TARGET_INVALID",
                            "Request body must include 'targetVersionId' specifying the version to restore."));
        }

        // Role check — SuperAdmin and FRAMEWORK_ADMIN are permitted (gateway enforces this)
        // Surfacing FORBIDDEN_ACTION for clients that bypass the gateway
        String normalizedRole = role.toUpperCase();
        if (!"SYSTEM_ADMIN".equals(normalizedRole) && !"FRAMEWORK_ADMIN".equals(normalizedRole)) {
            log.warn("[{}] Rollback attempted by unauthorized role '{}' for definition {}",
                    correlationId, role, definitionId);
            return ResponseEntity.status(HttpStatus.FORBIDDEN)
                    .body(errorBody("FORBIDDEN_ACTION",
                            "Role '" + role + "' is not authorized to perform rollback. "
                            + "Required: SYSTEM_ADMIN or FRAMEWORK_ADMIN."));
        }

        try {
            Map<String, Object> result = lifecycleService.rollbackToVersion(
                    definitionId, targetVersionId, reason, userId, username, correlationId);
            return ResponseEntity.ok(result);
        } catch (NoSuchElementException e) {
            log.warn("[{}] Rollback target not found: {}", correlationId, e.getMessage());
            return ResponseEntity.status(HttpStatus.NOT_FOUND)
                    .body(errorBody("ROLLBACK_TARGET_INVALID", e.getMessage()));
        } catch (IllegalArgumentException e) {
            // Includes ROLLBACK_TARGET_INVALID and ROLLBACK_CONFLICT messages
            log.warn("[{}] Rollback target ineligible: {}", correlationId, e.getMessage());
            String code = e.getMessage().contains("already the active") ? "ROLLBACK_CONFLICT" : "ROLLBACK_TARGET_INVALID";
            return ResponseEntity.status(HttpStatus.CONFLICT)
                    .body(errorBody(code, e.getMessage()));
        } catch (IllegalStateException e) {
            // REGISTRY_REBUILD_FAILED
            log.error("[{}] Registry rebuild failed during rollback: {}", correlationId, e.getMessage());
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                    .body(errorBody("REGISTRY_REBUILD_FAILED", e.getMessage()));
        } catch (Exception e) {
            log.error("[{}] Unexpected error during targeted rollback of definition {}",
                    correlationId, definitionId, e);
            return ResponseEntity.internalServerError()
                    .body(errorBody("INTERNAL_ERROR", "Failed to roll back definition " + definitionId));
        }
    }

    // ── GET /{definitionId}/active ────────────────────────────────────────────

    @GetMapping("/{definitionId}/active")
    public ResponseEntity<?> getActiveVersion(
            @PathVariable String definitionId) {
        try {
            ProductDefinitionVersion active = lifecycleService.getActiveVersion(definitionId);
            return ResponseEntity.ok(active);
        } catch (NoSuchElementException e) {
            return ResponseEntity.status(HttpStatus.NOT_FOUND)
                    .body(errorBody("NOT_FOUND", e.getMessage()));
        } catch (Exception e) {
            log.error("Error retrieving active version for definitionId={}", definitionId, e);
            return ResponseEntity.internalServerError()
                    .body(errorBody("INTERNAL_ERROR", "Failed to retrieve active version"));
        }
    }

    // ── GET /{definitionId}/lifecycle-history (alias for backward compat) ────

    @GetMapping("/{definitionId}/lifecycle-history")
    public ResponseEntity<?> getLifecycleHistory(@PathVariable String definitionId) {
        try {
            List<ProductDefinitionLifecycleEvent> events =
                    lifecycleService.getLifecycleHistory(definitionId);
            return ResponseEntity.ok(events);
        } catch (Exception e) {
            log.error("Error retrieving lifecycle history for definitionId={}", definitionId, e);
            return ResponseEntity.internalServerError()
                    .body(errorBody("INTERNAL_ERROR", "Failed to retrieve lifecycle history"));
        }
    }

    // ── GET /{definitionId}/audit-history (paginated) — WO-020 ───────────────

    /**
     * Returns the paginated, chronologically descending audit trail for a Product Definition.
     *
     * <p>Authorized roles: Admin, SuperAdmin only.  Lower-privilege callers receive 403 from the
     * API Gateway RBAC layer before this handler is reached.
     *
     * @param definitionId the definition to retrieve audit records for
     * @param page         0-indexed page number (default 0)
     * @param pageSize     records per page (1–100, default 20)
     */
    @GetMapping("/{definitionId}/audit-history")
    public ResponseEntity<?> getAuditHistory(
            @PathVariable String definitionId,
            @RequestParam(defaultValue = "0")  int page,
            @RequestParam(defaultValue = "20") int pageSize) {
        try {
            Page<ProductDefinitionLifecycleEvent> result =
                    auditService.getAuditHistory(definitionId, page, pageSize);
            return ResponseEntity.ok(auditService.buildPageResponse(result));
        } catch (Exception e) {
            log.error("Error retrieving audit history for definitionId={}", definitionId, e);
            return ResponseEntity.internalServerError()
                    .body(errorBody("INTERNAL_ERROR", "Failed to retrieve audit history for " + definitionId));
        }
    }

    // ── Health ────────────────────────────────────────────────────────────────

    @GetMapping("/health")
    public ResponseEntity<Map<String, String>> health() {
        return ResponseEntity.ok(Map.of("status", "UP", "service", "product-definition-service"));
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private Map<String, String> errorBody(String code, String message) {
        return Map.of("error", code, "message", message);
    }
}
