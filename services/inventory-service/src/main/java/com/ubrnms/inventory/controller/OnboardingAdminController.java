package com.ubrnms.inventory.controller;

import com.ubrnms.inventory.model.Device;
import com.ubrnms.inventory.model.OnboardingAssignmentPolicy;
import com.ubrnms.inventory.repository.DeviceRepository;
import com.ubrnms.inventory.service.OnboardingPolicyService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Admin endpoints for the onboarding assignment gate (WO-033).
 *
 * <p>GET/PUT /api/v1/admin/onboarding/policy — read or update the gate policy.
 * <p>POST /api/v1/admin/devices/{serial}/approve-assignment — move a
 * PENDING_ASSIGNMENT device to MANAGED, unblocking config delivery.
 *
 * <p>Role enforcement: policy mutation and device approval require X-Caller-Role: admin.
 * Non-admin requests are rejected with 403 and an audit event is published.
 */
@Slf4j
@RestController
@RequiredArgsConstructor
public class OnboardingAdminController {

    private final OnboardingPolicyService onboardingPolicyService;
    private final DeviceRepository deviceRepo;

    // ── Policy endpoints ──────────────────────────────────────────────────────

    /**
     * Returns the current onboarding assignment gate policy.
     * Accessible to any authenticated role (read-only).
     */
    @GetMapping("/api/v1/admin/onboarding/policy")
    public ResponseEntity<Map<String, Object>> getPolicy() {
        return ResponseEntity.ok(onboardingPolicyService.getPolicyResponse());
    }

    /**
     * Updates the onboarding assignment gate policy.
     * Requires {@code X-Caller-Role: admin} and {@code X-Caller-Id} headers.
     *
     * <p>Request body: {@code { "enabled": true|false, "reason": "..." }}
     */
    @PutMapping("/api/v1/admin/onboarding/policy")
    public ResponseEntity<?> updatePolicy(
            @RequestBody Map<String, Object> body,
            @RequestHeader(value = "X-Caller-Role", defaultValue = "") String callerRole,
            @RequestHeader(value = "X-Caller-Id", defaultValue = "unknown") String callerId) {
        try {
            Map<String, Object> updated = onboardingPolicyService.updatePolicy(body, callerRole, callerId);
            return ResponseEntity.ok(updated);
        } catch (OnboardingPolicyService.AccessDeniedException e) {
            return ResponseEntity.status(403).body(Map.of("error", e.getMessage()));
        } catch (OnboardingPolicyService.ValidationException e) {
            return ResponseEntity.badRequest().body(Map.of("error", e.getMessage()));
        }
    }

    // ── Device approval endpoint ──────────────────────────────────────────────

    /**
     * Approves a PENDING_ASSIGNMENT device, moving it to MANAGED state.
     * This unblocks configuration delivery for the device.
     *
     * <p>Requires {@code X-Caller-Role: admin} and {@code X-Caller-Id} headers.
     * Returns 404 when the device is not found.
     * Returns 409 when the device is not in PENDING_ASSIGNMENT state.
     * Returns 200 with the updated device state on success.
     */
    @PostMapping("/api/v1/admin/devices/{serial}/approve-assignment")
    public ResponseEntity<?> approveAssignment(
            @PathVariable String serial,
            @RequestHeader(value = "X-Caller-Role", defaultValue = "") String callerRole,
            @RequestHeader(value = "X-Caller-Id", defaultValue = "unknown") String callerId) {

        if (!"admin".equalsIgnoreCase(callerRole)) {
            return ResponseEntity.status(403).body(
                    Map.of("error", "Device assignment approval requires admin role"));
        }

        Device device = deviceRepo.findBySerialNumber(serial).orElse(null);
        if (device == null) {
            return ResponseEntity.notFound().build();
        }

        String currentState = device.getOnboardingGateState();
        if (!OnboardingAssignmentPolicy.GateState.PENDING_ASSIGNMENT.name().equals(currentState)) {
            return ResponseEntity.status(409).body(Map.of(
                "error", "Device is not in PENDING_ASSIGNMENT state",
                "currentState", currentState != null ? currentState : "UNKNOWN"
            ));
        }

        device.setOnboardingGateState(OnboardingAssignmentPolicy.GateState.MANAGED.name());
        device.setAssignmentRequired(false);
        Device saved = deviceRepo.save(device);

        log.info("Device serial=[redacted] approved for assignment by admin={}", callerId);

        Map<String, Object> response = new LinkedHashMap<>();
        response.put("serialNumber", "[redacted]");
        response.put("deviceId", saved.getId());
        response.put("onboardingGateState", saved.getOnboardingGateState());
        response.put("assignmentRequired", saved.getAssignmentRequired());
        response.put("approvedBy", callerId);

        return ResponseEntity.ok(response);
    }
}
