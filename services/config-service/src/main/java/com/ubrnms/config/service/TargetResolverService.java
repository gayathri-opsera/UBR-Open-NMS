package com.ubrnms.config.service;

import com.ubrnms.config.model.ConfigTargetPreviewRequest;
import com.ubrnms.config.model.ConfigTargetPreviewResponse;
import com.ubrnms.config.model.ConfigTargetPreviewResponse.TargetEntry;
import com.ubrnms.config.model.ConfigTargetPreviewResponse.UnsupportedTargetEntry;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.*;
import java.util.stream.Collectors;

/**
 * Non-mutating target resolver for cross-paradigm configuration targeting (WO-039).
 *
 * <p>Accepts structured filter criteria and returns a deterministic preview of
 * devices matching those criteria, together with delivery channel classification.
 * This service NEVER executes configuration commands or enqueues device operations.
 *
 * <p>Delivery channel rules:
 * <ul>
 *   <li>UBR_CALL_HOME device, online → UBR_REALTIME</li>
 *   <li>UBR_CALL_HOME device, offline → UBR_CHECKIN (pending until next heartbeat)</li>
 *   <li>GENERIC_SNMP device → SNMP_PROTOCOL</li>
 *   <li>GENERIC_CLI device  → CLI_PROTOCOL</li>
 *   <li>UNKNOWN / null      → UNSUPPORTED</li>
 * </ul>
 *
 * <p>UBR call-home and generic discovery paths are never collapsed into one another;
 * each target keeps its own authority and delivery route (WO-039 constraint).
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class TargetResolverService {

    private final DeviceStatusChecker deviceStatusChecker;
    private final InventorySearchClient inventorySearchClient;

    /** Operation codes required for various action types. */
    private static final Map<String, String> ACTION_TO_OPERATION = Map.of(
        "CONFIG_PUSH",       "config.push",
        "FIRMWARE_UPGRADE",  "firmware.upgrade",
        "PARAMETER_CHANGE",  "config.parameter",
        "COMMAND_EXECUTE",   "command.execute"
    );

    // ── Validation ────────────────────────────────────────────────────────────

    /**
     * Validates that the request has at least one non-trivially-empty filter
     * and that no conflicting filter combinations are present.
     *
     * @throws ValidationException if filters are invalid
     */
    public void validateRequest(ConfigTargetPreviewRequest request) {
        if (request.getFilters() == null) {
            throw new ValidationException("filters", "At least one filter field is required");
        }

        ConfigTargetPreviewRequest.TargetFilters f = request.getFilters();
        boolean hasAnyFilter = isNonEmpty(f.getSerialNumbers())
            || isNonEmpty(f.getMacAddresses())
            || isNonEmpty(f.getTags())
            || isSet(f.getDeviceType())
            || isSet(f.getSysObjectID())
            || isSet(f.getVendor())
            || isSet(f.getModel())
            || isSet(f.getIpAddress())
            || isSet(f.getRegion())
            || isSet(f.getOrganizationId())
            || isSet(f.getNetworkId())
            || isSet(f.getDiscoveryParadigm())
            || isSet(f.getStatus())
            || isSet(f.getCapabilityProfileId())
            || isSet(f.getOnboardingGateState());

        if (!hasAnyFilter) {
            throw new ValidationException("filters", "At least one filter field must be non-null and non-empty");
        }

        // Conflicting filter: UBR_CALL_HOME paradigm with sysObjectID filter is impossible
        // because UBR devices never have sysObjectIDs.
        if ("UBR_CALL_HOME".equalsIgnoreCase(f.getDiscoveryParadigm()) && isSet(f.getSysObjectID())) {
            throw new ValidationException(
                "filters.sysObjectID",
                "sysObjectID filter cannot be combined with discoveryParadigm=UBR_CALL_HOME — UBR devices do not have sysObjectIDs"
            );
        }

        // Validate actionType is known
        if (!ACTION_TO_OPERATION.containsKey(request.getActionType())) {
            throw new ValidationException(
                "actionType",
                "Unknown actionType '" + request.getActionType() + "'. Allowed: " + ACTION_TO_OPERATION.keySet()
            );
        }
    }

    // ── Target resolution ─────────────────────────────────────────────────────

    /**
     * Resolves configuration targets for the given request (WO-039).
     * Does NOT execute any configuration action.
     *
     * @param request validated preview request
     * @param actorRole the caller's role (used for RBAC audit logging)
     * @return preview response with resolved targets and delivery classification
     */
    public ConfigTargetPreviewResponse resolveTargets(ConfigTargetPreviewRequest request, String actorRole) {
        String previewId = UUID.randomUUID().toString();
        String requiredOperation = ACTION_TO_OPERATION.getOrDefault(request.getActionType(), "config.push");

        log.info("Target resolution: previewId={} actionType={} actorRole={} limit={}",
            previewId, request.getActionType(), actorRole, request.getLimit());

        // Fetch matching devices from inventory via the search client.
        // The client applies filter criteria and returns a raw device list.
        List<Map<String, Object>> rawDevices = inventorySearchClient.search(
            request.getFilters(), request.getLimit()
        );

        int totalCount = rawDevices.size();
        List<TargetEntry> targets = new ArrayList<>();
        List<UnsupportedTargetEntry> unsupported = new ArrayList<>();

        for (Map<String, Object> raw : rawDevices) {
            String deviceId      = str(raw.get("id"), raw.get("deviceId"));
            String serial        = str(raw.get("serialNumber"));
            String deviceType    = str(raw.get("deviceType"));
            String discoveryParadigm = str(raw.get("discoveryParadigm"));
            String status        = str(raw.get("status"), "UNKNOWN");
            String sysObjectID   = str(raw.get("sysObjectID"));
            @SuppressWarnings("unchecked")
            List<String> caps    = raw.get("capabilities") instanceof List<?>
                ? ((List<?>) raw.get("capabilities")).stream().map(Object::toString).collect(Collectors.toList())
                : Collections.emptyList();

            // Check if device supports the required operation.
            // If capabilities list is empty (unknown profile), we still include as target with warning.
            boolean operationSupported = caps.isEmpty() || caps.contains(requiredOperation);

            if (!operationSupported) {
                unsupported.add(UnsupportedTargetEntry.builder()
                    .deviceId(deviceId)
                    .serialNumber(serial)
                    .deviceType(deviceType)
                    .discoveryParadigm(discoveryParadigm)
                    .reason("Device capability profile does not include operation '" + requiredOperation + "'")
                    .unsupportedOperation(requiredOperation)
                    .build());
                continue;
            }

            // Classify delivery channel based on paradigm and online state.
            String deliveryChannel = classifyDeliveryChannel(deviceId, discoveryParadigm);
            List<String> warnings  = buildWarnings(deviceId, discoveryParadigm, deliveryChannel, status);

            // Build displayName: prefer deviceName, fall back to serial
            String displayName = str(raw.get("deviceName"), raw.get("serialNumber"), deviceId);

            // Identify which filters matched this device for operator transparency.
            List<String> matchedFilters = computeMatchedFilters(raw, request.getFilters());

            targets.add(TargetEntry.builder()
                .deviceId(deviceId)
                .displayName(displayName)
                .serialNumber(serial)
                .macAddress(str(raw.get("macAddress")))   // never expose credential-ref
                .deviceType(deviceType)
                .sysObjectID(sysObjectID)                 // null for UBR devices
                .discoveryParadigm(discoveryParadigm)
                .status(status)
                .capabilities(caps)
                .matchedFilters(matchedFilters)
                .deliveryChannel(deliveryChannel)
                .warnings(warnings)
                .build());
        }

        boolean requiresConfirmation = "FIRMWARE_UPGRADE".equals(request.getActionType())
            || totalCount > 50;

        return ConfigTargetPreviewResponse.builder()
            .previewId(previewId)
            .totalCount(totalCount)
            .targets(targets)
            .unsupportedTargets(unsupported)
            .generatedAt(Instant.now().toString())
            .requiresConfirmation(requiresConfirmation)
            .build();
    }

    // ── Delivery channel classification ───────────────────────────────────────

    /**
     * Classifies the delivery channel for a device based on its discovery paradigm
     * and current online state. UBR and generic paths are NEVER collapsed.
     *
     * <p>UBR online  → UBR_REALTIME (WebSocket push)
     * UBR offline → UBR_CHECKIN (queue until next heartbeat)
     * GENERIC_SNMP → SNMP_PROTOCOL
     * GENERIC_CLI  → CLI_PROTOCOL
     * null/unknown → UNSUPPORTED
     */
    public String classifyDeliveryChannel(String deviceId, String discoveryParadigm) {
        if ("UBR_CALL_HOME".equalsIgnoreCase(discoveryParadigm)) {
            boolean online = safeIsOnline(deviceId);
            return online ? "UBR_REALTIME" : "UBR_CHECKIN";
        }
        if ("GENERIC_SNMP".equalsIgnoreCase(discoveryParadigm)) {
            return "SNMP_PROTOCOL";
        }
        if ("GENERIC_CLI".equalsIgnoreCase(discoveryParadigm)) {
            return "CLI_PROTOCOL";
        }
        return "UNSUPPORTED";
    }

    // ── Matched filter annotation ─────────────────────────────────────────────

    private List<String> computeMatchedFilters(Map<String, Object> device,
                                                ConfigTargetPreviewRequest.TargetFilters filters) {
        List<String> matched = new ArrayList<>();
        if (isSet(filters.getDeviceType())
            && filters.getDeviceType().equalsIgnoreCase(str(device.get("deviceType")))) {
            matched.add("deviceType");
        }
        if (isSet(filters.getDiscoveryParadigm())
            && filters.getDiscoveryParadigm().equalsIgnoreCase(str(device.get("discoveryParadigm")))) {
            matched.add("discoveryParadigm");
        }
        if (isSet(filters.getSysObjectID())
            && filters.getSysObjectID().equals(str(device.get("sysObjectID")))) {
            matched.add("sysObjectID");
        }
        if (isSet(filters.getRegion())
            && filters.getRegion().equalsIgnoreCase(str(device.get("region")))) {
            matched.add("region");
        }
        if (isSet(filters.getStatus())
            && filters.getStatus().equalsIgnoreCase(str(device.get("status")))) {
            matched.add("status");
        }
        if (isNonEmpty(filters.getSerialNumbers())
            && filters.getSerialNumbers().contains(str(device.get("serialNumber")))) {
            matched.add("serialNumber");
        }
        if (isNonEmpty(filters.getMacAddresses())
            && filters.getMacAddresses().contains(str(device.get("macAddress")))) {
            matched.add("macAddress");
        }
        return matched;
    }

    private List<String> buildWarnings(String deviceId, String paradigm,
                                        String deliveryChannel, String status) {
        List<String> warnings = new ArrayList<>();
        if ("UBR_CHECKIN".equals(deliveryChannel)) {
            warnings.add("Device is offline — delivery queued until next check-in heartbeat");
        }
        if ("UNSUPPORTED".equals(deliveryChannel)) {
            warnings.add("Discovery paradigm '" + paradigm + "' has no delivery channel mapping — configuration cannot be sent");
        }
        if ("FAULTY".equalsIgnoreCase(status)) {
            warnings.add("Device status is FAULTY — delivery may fail");
        }
        return warnings;
    }

    // ── Private helpers ───────────────────────────────────────────────────────

    private boolean safeIsOnline(String deviceId) {
        try { return deviceStatusChecker.isOnline(deviceId); }
        catch (Exception e) {
            log.warn("isOnline check failed for device={}; treating as offline", deviceId, e);
            return false;
        }
    }

    private static boolean isSet(String v) {
        return v != null && !v.isBlank();
    }

    private static boolean isNonEmpty(List<?> v) {
        return v != null && !v.isEmpty();
    }

    private static String str(Object... candidates) {
        for (Object c : candidates) {
            if (c != null) return c.toString();
        }
        return null;
    }

    // ── Inner types ───────────────────────────────────────────────────────────

    /** Thrown when filter validation fails; maps to HTTP 400. */
    public static class ValidationException extends RuntimeException {
        public final String field;
        public ValidationException(String field, String message) {
            super(message);
            this.field = field;
        }
    }
}
