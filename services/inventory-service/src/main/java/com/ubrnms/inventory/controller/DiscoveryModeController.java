package com.ubrnms.inventory.controller;

import com.ubrnms.inventory.model.DiscoveryModePolicy;
import com.ubrnms.inventory.service.DiscoveryModePolicyService;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.Map;

/**
 * REST controller for discovery mode governance (WO-001).
 *
 * <p>API contracts:
 * <ul>
 *   <li>GET  /api/v1/discovery/modes      — current state of both modes (any role)</li>
 *   <li>PUT  /api/v1/discovery/modes/{mode} — update mode policy (admin only)</li>
 * </ul>
 *
 * <p>Disabled mode requests from the discovery pipeline return 403 DISCOVERY_MODE_DISABLED.
 */
@RestController
@RequestMapping("/api/v1/discovery")
@RequiredArgsConstructor
public class DiscoveryModeController {

    private final DiscoveryModePolicyService policyService;

    @GetMapping("/modes")
    public ResponseEntity<Map<String, Object>> getAllModes() {
        return ResponseEntity.ok(policyService.getAllModes());
    }

    @GetMapping("/modes/{mode}")
    public ResponseEntity<?> getMode(@PathVariable String mode) {
        try {
            DiscoveryModePolicy policy = policyService.getMode(mode.toUpperCase());
            return ResponseEntity.ok(policy);
        } catch (DiscoveryModePolicyService.ModeNotFoundException e) {
            return ResponseEntity.notFound().build();
        }
    }

    @PutMapping("/modes/{mode}")
    public ResponseEntity<?> updateMode(
            @PathVariable String mode,
            @RequestBody Map<String, Object> request,
            @RequestHeader(value = "X-User-Role", defaultValue = "") String callerRole,
            @RequestHeader(value = "X-User-Id", defaultValue = "unknown") String callerId) {

        try {
            DiscoveryModePolicy updated = policyService.updateMode(
                    mode.toUpperCase(), request, callerRole, callerId);
            return ResponseEntity.ok(updated);
        } catch (DiscoveryModePolicyService.AccessDeniedException e) {
            return ResponseEntity.status(403).body(Map.of(
                    "error", "FORBIDDEN",
                    "message", e.getMessage()
            ));
        } catch (DiscoveryModePolicyService.ValidationException e) {
            return ResponseEntity.badRequest().body(Map.of(
                    "error", "VALIDATION_ERROR",
                    "message", e.getMessage()
            ));
        } catch (DiscoveryModePolicyService.ModeNotFoundException e) {
            return ResponseEntity.notFound().build();
        }
    }

    /**
     * Gate check endpoint: returns 200 if the mode is enabled, 403 if disabled.
     * Used by discovery pipeline components before starting any discovery attempt.
     */
    @GetMapping("/modes/{mode}/gate")
    public ResponseEntity<?> checkGate(@PathVariable String mode) {
        try {
            boolean enabled = policyService.isModeEnabled(mode.toUpperCase());
            if (enabled) {
                return ResponseEntity.ok(Map.of("allowed", true, "mode", mode.toUpperCase()));
            }
            return ResponseEntity.status(403).body(Map.of(
                    "error", "DISCOVERY_MODE_DISABLED",
                    "mode", mode.toUpperCase(),
                    "message", "Discovery mode '" + mode.toUpperCase() + "' is currently disabled"
            ));
        } catch (DiscoveryModePolicyService.ModeNotFoundException e) {
            return ResponseEntity.notFound().build();
        }
    }
}
