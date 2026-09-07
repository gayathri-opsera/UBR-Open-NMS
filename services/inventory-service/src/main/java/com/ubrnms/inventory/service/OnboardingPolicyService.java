package com.ubrnms.inventory.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.ubrnms.inventory.model.OnboardingAssignmentPolicy;
import com.ubrnms.inventory.repository.OnboardingAssignmentPolicyRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

/**
 * Service for reading and updating the onboarding assignment gate policy (WO-033).
 *
 * <p>The gate is disabled by default — valid call-home devices are automatically
 * moved to MANAGED state after successful authentication and check-in.
 *
 * <p>When the gate is enabled, devices without a hierarchy assignment are held in
 * PENDING_ASSIGNMENT state until an operator completes the assignment.
 *
 * <p>All policy changes are audit-trailed via Kafka. Only admin callers may update
 * the policy; non-admin attempts are denied with an immutable denied-audit event.
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class OnboardingPolicyService {

    private static final String POLICY_KEY = "ONBOARDING_ASSIGNMENT_GATE";

    private final OnboardingAssignmentPolicyRepository policyRepo;
    private final KafkaTemplate<String, String> kafkaTemplate;
    private final ObjectMapper objectMapper;

    @Value("${kafka.topics.audit:audit-events}")
    private String auditTopic;

    // ── Policy reads ──────────────────────────────────────────────────────────

    /**
     * Returns the current onboarding assignment gate policy.
     * Falls back to the documented default (gate disabled) when no record exists in storage.
     */
    public OnboardingAssignmentPolicy getPolicy() {
        return policyRepo.findByPolicyKey(POLICY_KEY).orElse(defaultPolicy());
    }

    /**
     * Returns true when the assignment gate is enabled.
     * Fail-closed: returns false (gate disabled / auto-managed) on storage error.
     */
    public boolean isGateEnabled() {
        try {
            return policyRepo.findByPolicyKey(POLICY_KEY)
                    .map(OnboardingAssignmentPolicy::isEnabled)
                    .orElse(false); // documented default: gate disabled
        } catch (Exception e) {
            log.error("Failed to read onboarding assignment policy; defaulting to gate disabled (fail-open for onboarding)", e);
            return false;
        }
    }

    /**
     * Returns the response map for the GET /api/v1/admin/onboarding/policy endpoint.
     */
    public Map<String, Object> getPolicyResponse() {
        OnboardingAssignmentPolicy p = getPolicy();
        return toPolicyResponse(p);
    }

    // ── Policy writes (admin only) ────────────────────────────────────────────

    /**
     * Updates the onboarding assignment gate policy.
     * Only admins may call this; non-admin callers receive a denied-audit event and an exception.
     *
     * @param request    payload: enabled (boolean, required), reason (String, optional)
     * @param callerRole the role of the requesting user — must be "admin"
     * @param callerId   the userId for audit trail
     * @return the updated policy response map
     */
    public Map<String, Object> updatePolicy(Map<String, Object> request,
                                             String callerRole, String callerId) {
        if (!"admin".equalsIgnoreCase(callerRole)) {
            publishDeniedAuditEvent(callerId, callerRole);
            throw new AccessDeniedException("Onboarding policy management requires admin role");
        }

        Object enabledObj = request.get("enabled");
        if (enabledObj == null) {
            throw new ValidationException("enabled field is required");
        }
        boolean newEnabled;
        try {
            newEnabled = Boolean.parseBoolean(enabledObj.toString());
        } catch (Exception e) {
            throw new ValidationException("enabled must be a boolean value");
        }

        String reason = request.containsKey("reason") ? (String) request.get("reason") : null;

        OnboardingAssignmentPolicy policy = policyRepo.findByPolicyKey(POLICY_KEY).orElse(defaultPolicy());
        Map<String, Object> before = toPolicyResponse(policy);

        policy.setPolicyKey(POLICY_KEY);
        policy.setEnabled(newEnabled);
        policy.setDescription(newEnabled
                ? "Assignment gate enabled — devices held in PENDING_ASSIGNMENT until hierarchy is assigned."
                : "Assignment gate disabled — valid devices are automatically set to MANAGED after onboarding.");
        policy.setUpdatedBy(callerId);
        policy.setUpdatedAt(Instant.now());
        if (reason != null && !reason.isBlank()) {
            policy.setChangeReason(reason);
        }

        OnboardingAssignmentPolicy saved = policyRepo.save(policy);
        Map<String, Object> after = toPolicyResponse(saved);

        publishChangeAuditEvent(callerId, callerRole, before, after);

        log.info("Onboarding assignment gate updated by admin={} enabled={} reason={}",
                callerId, saved.isEnabled(), reason);

        return after;
    }

    // ── private helpers ───────────────────────────────────────────────────────

    private OnboardingAssignmentPolicy defaultPolicy() {
        OnboardingAssignmentPolicy p = new OnboardingAssignmentPolicy();
        p.setPolicyKey(POLICY_KEY);
        p.setEnabled(false);
        p.setDescription("Assignment gate disabled — valid devices are automatically set to MANAGED after onboarding.");
        p.setUpdatedAt(Instant.EPOCH);
        return p;
    }

    private Map<String, Object> toPolicyResponse(OnboardingAssignmentPolicy p) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("enabled", p.isEnabled());
        m.put("defaultBehavior", p.isEnabled() ? "PENDING_ASSIGNMENT" : "AUTO_MANAGED");
        m.put("description", p.getDescription());
        m.put("updatedBy", p.getUpdatedBy());
        m.put("updatedAt", p.getUpdatedAt() != null ? p.getUpdatedAt().toString() : null);
        m.put("changeReason", p.getChangeReason());
        return m;
    }

    private void publishChangeAuditEvent(String actorId, String actorRole,
                                          Map<String, Object> before, Map<String, Object> after) {
        try {
            Map<String, Object> event = Map.of(
                "action", "onboarding.assignment.policy.changed",
                "actor", Map.of("userId", actorId, "username", actorId, "role", actorRole),
                "resource", Map.of("type", "onboarding_assignment_policy", "id", POLICY_KEY),
                "outcome", "success",
                "payload", Map.of("before", before, "after", after),
                "correlationId", UUID.randomUUID().toString(),
                "timestamp", Instant.now().toString()
            );
            kafkaTemplate.send(auditTopic, POLICY_KEY, objectMapper.writeValueAsString(event));
        } catch (Exception e) {
            log.warn("Failed to publish onboarding policy change audit event", e);
        }
    }

    private void publishDeniedAuditEvent(String actorId, String actorRole) {
        try {
            Map<String, Object> event = Map.of(
                "action", "onboarding.assignment.policy.change.denied",
                "actor", Map.of(
                    "userId", actorId != null ? actorId : "unknown",
                    "username", actorId != null ? actorId : "unknown",
                    "role", actorRole != null ? actorRole : "unknown"),
                "resource", Map.of("type", "onboarding_assignment_policy", "id", POLICY_KEY),
                "outcome", "denied",
                "correlationId", UUID.randomUUID().toString(),
                "timestamp", Instant.now().toString()
            );
            kafkaTemplate.send(auditTopic, POLICY_KEY, objectMapper.writeValueAsString(event));
        } catch (Exception e) {
            log.warn("Failed to publish onboarding policy denied audit event", e);
        }
    }

    // ── Exception types ───────────────────────────────────────────────────────

    public static class AccessDeniedException extends RuntimeException {
        public AccessDeniedException(String msg) { super(msg); }
    }

    public static class ValidationException extends RuntimeException {
        public ValidationException(String msg) { super(msg); }
    }
}
