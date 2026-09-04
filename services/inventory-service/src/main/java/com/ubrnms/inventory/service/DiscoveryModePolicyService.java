package com.ubrnms.inventory.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.ubrnms.inventory.model.DiscoveryModePolicy;
import com.ubrnms.inventory.repository.DiscoveryModePolicyRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.*;

/**
 * Service for persisted, audited discovery mode governance (WO-001).
 *
 * <p>Governs enablement of UBR call-home and generic discovery independently.
 * All mode changes are audit-trailed via Kafka. Non-admin attempts are rejected
 * with an immutable denied-audit event.
 *
 * <p>Disabled discovery: when a mode is disabled, any discovery request for
 * that mode returns 403 DISCOVERY_MODE_DISABLED. Both modes disabled = empty
 * state — no partial discovery attempt.
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class DiscoveryModePolicyService {

    private static final Set<String> VALID_MODES = Set.of("UBR_CALL_HOME", "GENERIC_DISCOVERY");
    private static final Set<String> VALID_ROLLOUT_LEVELS = Set.of("disabled", "beta", "production");

    private final DiscoveryModePolicyRepository policyRepo;
    private final KafkaTemplate<String, String> kafkaTemplate;
    private final ObjectMapper objectMapper;

    @Value("${kafka.topics.audit:audit-events}")
    private String auditTopic;

    // ── Policy reads ──────────────────────────────────────────────────────────

    /**
     * Returns all discovery mode policies as a structured response map.
     * Unknown modes return a default disabled-state entry.
     */
    public Map<String, Object> getAllModes() {
        Map<String, Object> result = new LinkedHashMap<>();
        for (String mode : VALID_MODES) {
            DiscoveryModePolicy policy = policyRepo.findByMode(mode).orElse(defaultPolicy(mode));
            result.put(toCamelCase(mode), toResponseMap(policy));
        }
        return result;
    }

    /**
     * Returns the policy for a specific mode.
     *
     * @throws ModeNotFoundException if the mode string is not valid
     */
    public DiscoveryModePolicy getMode(String mode) {
        validateMode(mode);
        return policyRepo.findByMode(mode).orElse(defaultPolicy(mode));
    }

    // ── Policy writes (admin only) ────────────────────────────────────────────

    /**
     * Updates the discovery mode policy for the given mode.
     * Only admins may call this method; non-admin callers will receive a 403
     * and an immutable denied-audit event is published.
     *
     * @param mode       the discovery mode to update (UBR_CALL_HOME or GENERIC_DISCOVERY)
     * @param request    the update payload: enabled, rolloutLevel, betaSignoffRef, reason
     * @param callerRole the role of the requesting user (must be "admin")
     * @param callerId   the userId of the requesting user for audit trail
     * @return the updated policy record
     * @throws AccessDeniedException if callerRole is not admin
     * @throws ValidationException   if the request payload is malformed
     */
    public DiscoveryModePolicy updateMode(String mode, Map<String, Object> request,
                                          String callerRole, String callerId) {
        validateMode(mode);

        if (!"admin".equalsIgnoreCase(callerRole)) {
            // Emit immutable denied-audit event and reject
            publishDeniedAuditEvent(mode, callerId, callerRole);
            throw new AccessDeniedException("Discovery mode management requires admin role");
        }

        // Validate rolloutLevel if provided
        Object rolloutLevelObj = request.get("rolloutLevel");
        String rolloutLevel = rolloutLevelObj != null ? rolloutLevelObj.toString() : null;
        if (rolloutLevel != null && !VALID_ROLLOUT_LEVELS.contains(rolloutLevel)) {
            throw new ValidationException("Invalid rolloutLevel: '" + rolloutLevel
                    + "'. Must be one of: " + VALID_ROLLOUT_LEVELS);
        }

        // Require reason for all mode changes
        String reason = (String) request.get("reason");
        if (reason == null || reason.isBlank()) {
            throw new ValidationException("reason is required for discovery mode changes");
        }

        DiscoveryModePolicy policy = policyRepo.findByMode(mode).orElse(defaultPolicy(mode));
        Map<String, Object> before = toResponseMap(policy);

        // Apply updates
        Object enabledObj = request.get("enabled");
        if (enabledObj != null) {
            policy.setEnabled(Boolean.parseBoolean(enabledObj.toString()));
        }
        if (rolloutLevel != null) {
            policy.setRolloutLevel(rolloutLevel);
        }
        Object betaSignoffRef = request.get("betaSignoffRef");
        if (betaSignoffRef != null) {
            policy.setBetaSignoffRef(betaSignoffRef.toString());
        }
        policy.setReason(reason);
        policy.setUpdatedBy(callerId);
        policy.setUpdatedAt(Instant.now());

        DiscoveryModePolicy saved = policyRepo.save(policy);
        Map<String, Object> after = toResponseMap(saved);

        // Publish change audit event
        publishChangeAuditEvent(mode, callerId, callerRole, before, after);

        log.info("Discovery mode '{}' updated by admin={} rolloutLevel={} enabled={}",
                mode, callerId, saved.getRolloutLevel(), saved.isEnabled());

        return saved;
    }

    // ── Discovery gate check ──────────────────────────────────────────────────

    /**
     * Returns true if the given discovery mode is currently enabled and in a
     * production or beta rollout state.
     */
    public boolean isModeEnabled(String mode) {
        if (!VALID_MODES.contains(mode)) return false;
        return policyRepo.findByMode(mode)
                .map(p -> p.isEnabled() && !"disabled".equals(p.getRolloutLevel()))
                .orElse(false); // default: disabled
    }

    // ── private helpers ───────────────────────────────────────────────────────

    private DiscoveryModePolicy defaultPolicy(String mode) {
        DiscoveryModePolicy p = new DiscoveryModePolicy();
        p.setMode(mode);
        p.setEnabled(false);
        p.setRolloutLevel("disabled");
        p.setCreatedAt(Instant.EPOCH);
        p.setUpdatedAt(Instant.EPOCH);
        return p;
    }

    private Map<String, Object> toResponseMap(DiscoveryModePolicy p) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("enabled", p.isEnabled());
        m.put("rolloutLevel", p.getRolloutLevel() != null ? p.getRolloutLevel() : "disabled");
        m.put("betaSignoffRef", p.getBetaSignoffRef());
        m.put("updatedBy", p.getUpdatedBy());
        m.put("updatedAt", p.getUpdatedAt() != null ? p.getUpdatedAt().toString() : null);
        m.put("reason", p.getReason());
        return m;
    }

    private String toCamelCase(String mode) {
        return switch (mode) {
            case "UBR_CALL_HOME"     -> "ubrCallHome";
            case "GENERIC_DISCOVERY" -> "genericDiscovery";
            default -> mode.toLowerCase();
        };
    }

    private void validateMode(String mode) {
        if (!VALID_MODES.contains(mode)) {
            throw new ModeNotFoundException("Unknown discovery mode: '" + mode
                    + "'. Valid modes: " + VALID_MODES);
        }
    }

    private void publishChangeAuditEvent(String mode, String actorId, String actorRole,
                                         Map<String, Object> before, Map<String, Object> after) {
        try {
            Map<String, Object> event = Map.of(
                "action", "discovery.mode.changed",
                "actor", Map.of("userId", actorId, "username", actorId, "role", actorRole),
                "resource", Map.of("type", "discovery_mode_policy", "id", mode),
                "outcome", "success",
                "payload", Map.of("before", before, "after", after),
                "correlationId", UUID.randomUUID().toString(),
                "timestamp", Instant.now().toString()
            );
            kafkaTemplate.send(auditTopic, mode, objectMapper.writeValueAsString(event));
        } catch (Exception e) {
            log.warn("Failed to publish discovery mode change audit event", e);
        }
    }

    private void publishDeniedAuditEvent(String mode, String actorId, String actorRole) {
        try {
            Map<String, Object> event = Map.of(
                "action", "discovery.mode.change.denied",
                "actor", Map.of("userId", actorId != null ? actorId : "unknown",
                                "username", actorId != null ? actorId : "unknown",
                                "role", actorRole != null ? actorRole : "unknown"),
                "resource", Map.of("type", "discovery_mode_policy", "id", mode),
                "outcome", "denied",
                "correlationId", UUID.randomUUID().toString(),
                "timestamp", Instant.now().toString()
            );
            kafkaTemplate.send(auditTopic, mode, objectMapper.writeValueAsString(event));
        } catch (Exception e) {
            log.warn("Failed to publish discovery mode denied audit event", e);
        }
    }

    // ── Exception types ───────────────────────────────────────────────────────

    public static class AccessDeniedException extends RuntimeException {
        public AccessDeniedException(String msg) { super(msg); }
    }

    public static class ValidationException extends RuntimeException {
        public ValidationException(String msg) { super(msg); }
    }

    public static class ModeNotFoundException extends RuntimeException {
        public ModeNotFoundException(String msg) { super(msg); }
    }
}
