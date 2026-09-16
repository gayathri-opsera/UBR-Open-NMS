package com.ubrnms.productdef.controller;

import com.ubrnms.productdef.model.ProductDefinitionVersion;
import com.ubrnms.productdef.model.ValidationReport;
import com.ubrnms.productdef.service.ProductDefinitionService;
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

    private final ProductDefinitionService service;

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
