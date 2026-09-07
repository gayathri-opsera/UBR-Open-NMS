package com.ubrnms.inventory.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.ubrnms.inventory.model.Device;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.*;

/**
 * Authority-aware merge policy service for inventory convergence (WO-032).
 *
 * <p>Enforces deterministic source-of-truth rules when device records are updated
 * by multiple discovery paradigms (UBR call-home and generic SNMP/CLI discovery):
 *
 * <ul>
 *   <li>UBR call-home is authoritative for identity and online-state fields.
 *       Generic discovery MUST NOT overwrite them when the existing record has
 *       {@code identityAuthority=UBR}.</li>
 *   <li>Generic discovery may enrich safe attributes (sysObjectID, vendor, model,
 *       tags, classificationStatus, capability profile, monitoring metadata).</li>
 *   <li>Every rejected overwrite emits a structured operational event via Kafka
 *       so operators can observe the conflict without exposing secrets.</li>
 * </ul>
 *
 * <p>This service encapsulates the merge rules that were previously inline in
 * {@link InventoryService#mergeWithAuthority(Device, Map, String)} and adds
 * the observable rejection-event path required by WO-032.
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class InventoryMergePolicyService {

    private final KafkaTemplate<String, String> kafkaTemplate;
    private final ObjectMapper objectMapper;

    @Value("${kafka.topics.audit:audit-events}")
    private String auditTopic;

    // ── Protected field classifications ──────────────────────────────────────

    /**
     * Fields for which UBR call-home is the exclusive authority.
     * Generic discovery may NEVER overwrite these when the existing record
     * shows {@code identityAuthority=UBR} or {@code onlineStateAuthority=UBR}.
     */
    public static final Set<String> UBR_IDENTITY_FIELDS = Set.of(
        "serialNumber", "macAddress", "deviceType",
        "identityAuthority", "onlineStateAuthority",
        "birthCertificateId", "credentialRef"
    );

    /**
     * Online-state fields owned by the UBR call-home paradigm.
     * Generic discovery MUST NOT overwrite these when {@code onlineStateAuthority=UBR}.
     */
    public static final Set<String> UBR_ONLINE_STATE_FIELDS = Set.of(
        "bootstrapState", "lastCheckInAt", "lastRealtimeAt",
        "realtimeConnectionId", "realtimeStatusReason"
    );

    /**
     * Fields that generic discovery may always enrich regardless of authority.
     * This is an explicit allow-list; fields not in this set and not in the
     * caller's own authority domain are blocked.
     */
    public static final Set<String> GENERIC_ENRICHMENT_FIELDS = Set.of(
        "sysObjectID", "sysDescr", "vendor", "model",
        "genericDeviceType", "driverId", "capabilityProfileId",
        "classificationStatus", "classificationDeferReason", "classificationCorrelationId",
        "ipAddress", "region", "organizationId", "schemaVersion"
    );

    // ── Merge result ──────────────────────────────────────────────────────────

    /**
     * Result of a merge policy evaluation.
     * Contains the list of rejected fields so callers can decide whether to
     * emit an operational event or surface a warning.
     */
    public record MergePolicyResult(List<String> rejectedFields, boolean hasRejections) {}

    // ── Policy evaluation ─────────────────────────────────────────────────────

    /**
     * Evaluates whether the incoming {@code update} map may overwrite fields on
     * {@code existing} given the {@code callerParadigm}.
     *
     * <p>Rejected fields are removed from {@code update} in-place so callers can
     * apply the safe remainder directly. A structured rejection event is emitted
     * for each rejected field via Kafka.
     *
     * @param existing       the persisted device record
     * @param update         mutable map of incoming field updates (modified in place)
     * @param callerParadigm discovery paradigm of the caller (UBR_CALL_HOME, GENERIC_*)
     * @param correlationId  request correlation ID for audit trail
     * @return {@link MergePolicyResult} with list of rejected fields
     */
    public MergePolicyResult evaluateAndFilter(Device existing, Map<String, Object> update,
                                                String callerParadigm, String correlationId) {
        boolean isUbrCaller = "UBR_CALL_HOME".equalsIgnoreCase(callerParadigm);
        String existingIdentityAuthority = existing.getIdentityAuthority();
        boolean existingIsUbrAuthoritative = "UBR".equalsIgnoreCase(existingIdentityAuthority);

        List<String> rejected = new ArrayList<>();

        // Generic callers must not overwrite UBR-authoritative identity or online-state fields.
        if (!isUbrCaller && existingIsUbrAuthoritative) {
            Iterator<Map.Entry<String, Object>> it = update.entrySet().iterator();
            while (it.hasNext()) {
                Map.Entry<String, Object> entry = it.next();
                String field = entry.getKey();
                if (UBR_IDENTITY_FIELDS.contains(field) || UBR_ONLINE_STATE_FIELDS.contains(field)) {
                    rejected.add(field);
                    it.remove();
                }
            }
        }

        // A malformed or absent callerParadigm must be treated as untrusted.
        // Untrusted callers get only the generic enrichment allow-list.
        boolean isTrustedParadigm = isUbrCaller
            || "GENERIC_SNMP".equalsIgnoreCase(callerParadigm)
            || "GENERIC_CLI".equalsIgnoreCase(callerParadigm);

        if (!isTrustedParadigm && !isUbrCaller) {
            Iterator<Map.Entry<String, Object>> it = update.entrySet().iterator();
            while (it.hasNext()) {
                Map.Entry<String, Object> entry = it.next();
                String field = entry.getKey();
                if (!GENERIC_ENRICHMENT_FIELDS.contains(field) && !rejected.contains(field)) {
                    rejected.add(field);
                    it.remove();
                }
            }
        }

        if (!rejected.isEmpty()) {
            log.warn(
                "Merge policy: {} fields rejected from callerParadigm={} due to UBR authority (correlationId={}): {}",
                rejected.size(), callerParadigm, correlationId, rejected
            );
            publishRejectionEvent(existing, callerParadigm, rejected, correlationId);
        }

        return new MergePolicyResult(Collections.unmodifiableList(rejected), !rejected.isEmpty());
    }

    // ── Inventory sync event with authority metadata ──────────────────────────

    /**
     * Builds an inventory sync event payload that includes authority metadata
     * fields required by downstream consumers (topology, alarms, KPI, config).
     *
     * <p>Per WO-032: emitted events MUST include {@code discoveryParadigm},
     * {@code identityAuthority}, {@code onlineStateAuthority}, {@code sysObjectID},
     * {@code lastCheckInAt}, and {@code lastRealtimeAt} when present.
     */
    public Map<String, Object> buildInventorySyncPayload(Device device) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("deviceId",               device.getId());
        payload.put("serialNumber",            device.getSerialNumber());
        payload.put("deviceType",              device.getDeviceType());
        payload.put("macAddress",              device.getMacAddress());
        payload.put("ipAddress",               device.getIpAddress());
        payload.put("status",                  device.getStatus());
        payload.put("firmwareVersion",         device.getFirmwareVersion());
        payload.put("softwareVersion",         device.getSoftwareVersion());
        payload.put("capabilityProfileId",     device.getCapabilityProfileId());
        payload.put("configVersion",           device.getConfigVersion());
        payload.put("onboardingGateState",     device.getOnboardingGateState());
        // WO-032: authority metadata — required by all downstream consumers
        payload.put("discoveryParadigm",       device.getDiscoveryParadigm());
        payload.put("identityAuthority",       device.getIdentityAuthority());
        payload.put("onlineStateAuthority",    device.getOnlineStateAuthority());
        payload.put("bootstrapState",          device.getBootstrapState());
        payload.put("lastCheckInAt",           device.getLastCheckInAt() != null ? device.getLastCheckInAt().toString() : null);
        payload.put("lastRealtimeAt",          device.getLastRealtimeAt() != null ? device.getLastRealtimeAt().toString() : null);
        payload.put("sysObjectID",             device.getSysObjectID());
        payload.put("schemaVersion",           device.getSchemaVersion());
        payload.put("updatedAt",               device.getUpdatedAt() != null ? device.getUpdatedAt().toString() : null);
        return payload;
    }

    // ── Private helpers ───────────────────────────────────────────────────────

    /**
     * Emits a structured rejection event to the audit topic.
     * Never includes credential values, HMAC keys, or secret material.
     * The device serial number is redacted; only the device ID is logged.
     */
    private void publishRejectionEvent(Device device, String callerParadigm,
                                        List<String> rejectedFields, String correlationId) {
        try {
            Map<String, Object> event = Map.of(
                "action",          "inventory.convergence.overwrite.rejected",
                "actor",           Map.of("userId", "system", "username", "inventory-service",
                                          "role", "system", "discoverySource", callerParadigm),
                "resource",        Map.of("type", "device", "id", device.getId() != null ? device.getId() : "unknown"),
                "outcome",         "rejected",
                "reason",          "UBR_AUTHORITY_PROTECTED",
                "rejectedFields",  rejectedFields,
                "callerParadigm",  callerParadigm,
                "correlationId",   correlationId != null ? correlationId : "n/a",
                "timestamp",       Instant.now().toString()
            );
            kafkaTemplate.send(auditTopic, correlationId, objectMapper.writeValueAsString(event));
        } catch (Exception e) {
            log.warn("Failed to publish convergence rejection audit event; correlationId={}", correlationId, e);
        }
    }
}
