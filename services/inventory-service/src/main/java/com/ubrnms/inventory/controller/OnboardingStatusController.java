package com.ubrnms.inventory.controller;

import com.ubrnms.inventory.model.Device;
import com.ubrnms.inventory.model.OnboardingStatusDTO;
import com.ubrnms.inventory.service.InventoryService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.format.annotation.DateTimeFormat;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Exposes a paginated, filterable onboarding status feed for NOC operators (WO-038).
 *
 * <p>GET /api/v1/inventory/onboarding-status — returns an operator-ready aggregated view of
 * onboarding progress across UBR call-home and generic discovery paradigms.
 *
 * <p>Sensitive authentication material (certificates, HMAC signatures, nonces, credential refs)
 * is explicitly excluded from all responses and logs.
 */
@Slf4j
@RestController
@RequestMapping("/api/v1/inventory/onboarding-status")
@RequiredArgsConstructor
public class OnboardingStatusController {

    private final InventoryService inventoryService;

    /**
     * Returns a paginated, filterable onboarding status feed.
     *
     * <p>Query parameters:
     * <ul>
     *   <li>{@code page} — zero-based page index (default 0)</li>
     *   <li>{@code limit} — page size, max 200 (default 50)</li>
     *   <li>{@code state} — filter by consolidated onboardingState</li>
     *   <li>{@code paradigm} — filter by discoveryParadigm</li>
     *   <li>{@code deviceType} — filter by deviceType</li>
     *   <li>{@code reasonCategory} — filter by onboardingFailureReason</li>
     *   <li>{@code serialNumber} — exact match on serialNumber</li>
     *   <li>{@code macAddress} — exact match on macAddress</li>
     *   <li>{@code sysObjectID} — exact match on sysObjectID</li>
     *   <li>{@code from} — lower bound on updatedAt (ISO-8601)</li>
     *   <li>{@code to} — upper bound on updatedAt (ISO-8601)</li>
     * </ul>
     */
    @GetMapping
    public ResponseEntity<?> listOnboardingStatus(
            @RequestParam(defaultValue = "0")   int page,
            @RequestParam(defaultValue = "50")  int limit,
            @RequestParam(required = false)     String state,
            @RequestParam(required = false)     String paradigm,
            @RequestParam(required = false)     String deviceType,
            @RequestParam(required = false)     String reasonCategory,
            @RequestParam(required = false)     String serialNumber,
            @RequestParam(required = false)     String macAddress,
            @RequestParam(required = false)     String sysObjectID,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) Instant from,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) Instant to) {

        // Validate pagination bounds to prevent unbounded reads.
        if (limit < 1 || limit > 200) {
            return ResponseEntity.badRequest().body(Map.of(
                "error", Map.of("code", "VALIDATION_FAILED",
                    "message", "limit must be between 1 and 200; received: " + limit)
            ));
        }
        if (page < 0) {
            return ResponseEntity.badRequest().body(Map.of(
                "error", Map.of("code", "VALIDATION_FAILED",
                    "message", "page must be >= 0; received: " + page)
            ));
        }

        try {
            InventoryService.OnboardingStatusResult result = inventoryService.queryOnboardingStatus(
                state, paradigm, deviceType, reasonCategory, serialNumber, macAddress, sysObjectID,
                from, to, page, limit);

            Map<String, Object> response = new LinkedHashMap<>();
            response.put("items", result.items());
            response.put("page", page);
            response.put("limit", limit);
            response.put("total", result.total());
            response.put("capabilityStatus", result.capabilityStatus());

            return ResponseEntity.ok(response);

        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest().body(Map.of(
                "error", Map.of("code", "VALIDATION_FAILED", "message", e.getMessage())
            ));
        } catch (Exception e) {
            log.error("Onboarding status query failed", e);
            return ResponseEntity.status(503).body(Map.of(
                "error", Map.of("code", "SERVICE_UNAVAILABLE",
                    "message", "Onboarding status aggregation failed — retry with correlation ID")
            ));
        }
    }

    /**
     * Returns the onboarding status for a single device by its inventory ID.
     * Returns 404 when no device is found.
     */
    @GetMapping("/{id}")
    public ResponseEntity<?> getOnboardingStatusById(@PathVariable String id) {
        return inventoryService.findById(id)
            .map(device -> ResponseEntity.ok(inventoryService.toOnboardingStatusDTO(device)))
            .orElse(ResponseEntity.notFound().build());
    }
}
