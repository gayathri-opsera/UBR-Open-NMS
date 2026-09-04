package com.ubrnms.inventory.controller;

import com.ubrnms.inventory.service.CapabilityRegistryService;
import com.ubrnms.inventory.service.CapabilityRegistryService.BulkEvaluationResult;
import com.ubrnms.inventory.service.CapabilityRegistryService.DeviceCapabilityResponse;
import com.ubrnms.inventory.service.InventoryService;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

/**
 * REST controller for capability profile management and device capability evaluation (WO-003).
 *
 * <p>API contracts:
 * <ul>
 *   <li>GET  /api/v1/capabilities/profiles — all profiles</li>
 *   <li>GET  /api/v1/capabilities/devices/{deviceId} — per-device capability</li>
 *   <li>POST /api/v1/capabilities/evaluate — bulk eligibility check</li>
 * </ul>
 */
@RestController
@RequestMapping("/api/v1/capabilities")
@RequiredArgsConstructor
public class CapabilityController {

    private final CapabilityRegistryService registryService;

    @GetMapping("/profiles")
    public ResponseEntity<?> listProfiles() {
        return ResponseEntity.ok(registryService.listAllProfiles());
    }

    @GetMapping("/profiles/{profileId}")
    public ResponseEntity<?> getProfile(@PathVariable String profileId) {
        return registryService.findProfile(profileId)
                .map(ResponseEntity::ok)
                .orElse(ResponseEntity.notFound().build());
    }

    @GetMapping("/devices/{deviceId}")
    public ResponseEntity<?> getDeviceCapability(@PathVariable String deviceId) {
        try {
            DeviceCapabilityResponse resp = registryService.evaluateDevice(deviceId);
            return ResponseEntity.ok(resp);
        } catch (InventoryService.ResourceNotFoundException e) {
            return ResponseEntity.notFound().build();
        }
    }

    @PostMapping("/evaluate")
    public ResponseEntity<?> evaluateBulk(@RequestBody Map<String, Object> body) {
        @SuppressWarnings("unchecked")
        List<String> deviceIds = (List<String>) body.get("deviceIds");
        String operation = (String) body.get("operation");

        if (deviceIds == null || deviceIds.isEmpty()) {
            return ResponseEntity.badRequest().body(Map.of(
                    "error", "deviceIds must not be empty"));
        }
        if (operation == null || operation.isBlank()) {
            return ResponseEntity.badRequest().body(Map.of(
                    "error", "operation must not be empty"));
        }

        BulkEvaluationResult result = registryService.evaluateBulk(deviceIds, operation);
        return ResponseEntity.ok(result);
    }
}
