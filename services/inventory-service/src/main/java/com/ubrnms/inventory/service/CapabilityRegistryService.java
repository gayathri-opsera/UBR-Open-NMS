package com.ubrnms.inventory.service;

import com.ubrnms.inventory.model.CapabilityProfile;
import com.ubrnms.inventory.model.Device;
import com.ubrnms.inventory.repository.CapabilityProfileRepository;
import com.ubrnms.inventory.repository.DeviceRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.util.*;
import java.util.stream.Collectors;

/**
 * Central capability registry service (WO-003).
 *
 * <p>Deny-by-default semantics:
 * <ul>
 *   <li>No capabilityProfileId on device → all state-changing ops unsupported</li>
 *   <li>Unknown operation → structured unsupported reason, no fallthrough</li>
 *   <li>Empty protocol chain → block delivery (not unsafe default)</li>
 * </ul>
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class CapabilityRegistryService {

    private final CapabilityProfileRepository profileRepo;
    private final DeviceRepository deviceRepo;

    // ── Profile lookup ────────────────────────────────────────────────────────

    public List<CapabilityProfile> listAllProfiles() {
        return profileRepo.findAll();
    }

    public Optional<CapabilityProfile> findProfile(String profileId) {
        return profileRepo.findByProfileId(profileId);
    }

    // ── Device capability evaluation ─────────────────────────────────────────

    /**
     * Returns the resolved capability response for a given device.
     * Includes all supported and unsupported operations, protocol priorities,
     * release eligibility, and structured reasons.
     */
    public DeviceCapabilityResponse evaluateDevice(String deviceId) {
        Device device = deviceRepo.findById(deviceId)
                .orElseThrow(() -> new InventoryService.ResourceNotFoundException("Device not found: " + deviceId));

        String profileId = device.getCapabilityProfileId();
        if (profileId == null) {
            // Deny-by-default: no profile → unsupported for all state-changing ops
            return DeviceCapabilityResponse.noProfile(deviceId);
        }

        CapabilityProfile profile = profileRepo.findByProfileId(profileId)
                .orElse(null);
        if (profile == null) {
            log.warn("Device {} references unknown capabilityProfileId={} — treating as no-profile", deviceId, profileId);
            return DeviceCapabilityResponse.noProfile(deviceId);
        }

        return buildResponse(deviceId, profile);
    }

    /**
     * Bulk operation eligibility check for a list of devices against a single operation.
     * Returns two lists: eligible device IDs and ineligible entries with structured reasons.
     */
    public BulkEvaluationResult evaluateBulk(List<String> deviceIds, String operation) {
        List<String> eligible = new ArrayList<>();
        List<IneligibleEntry> ineligible = new ArrayList<>();

        for (String deviceId : deviceIds) {
            try {
                DeviceCapabilityResponse resp = evaluateDevice(deviceId);
                if (resp.getSupportedOperations().contains(operation)) {
                    // Also check protocol chain isn't empty
                    List<String> chain = resp.getProtocolPriorityByOperation() == null
                            ? List.of()
                            : resp.getProtocolPriorityByOperation().getOrDefault(operation, List.of());
                    // If the profile specifies an explicit empty chain, block delivery
                    Map<String, List<String>> protocolMap = resp.getProtocolPriorityByOperation();
                    if (protocolMap != null && protocolMap.containsKey(operation) && chain.isEmpty()) {
                        ineligible.add(new IneligibleEntry(deviceId,
                                "Empty protocol chain for operation '" + operation + "' — delivery blocked"));
                    } else {
                        eligible.add(deviceId);
                    }
                } else {
                    String reason = resp.getUnsupportedOperations() != null
                            ? resp.getUnsupportedOperations().getOrDefault(operation,
                                    "Operation '" + operation + "' not supported by capability profile")
                            : "Operation '" + operation + "' not supported by capability profile";
                    ineligible.add(new IneligibleEntry(deviceId, reason));
                }
            } catch (InventoryService.ResourceNotFoundException e) {
                ineligible.add(new IneligibleEntry(deviceId, "Device not found"));
            }
        }

        return new BulkEvaluationResult(eligible, ineligible);
    }

    // ── private helpers ───────────────────────────────────────────────────────

    private DeviceCapabilityResponse buildResponse(String deviceId, CapabilityProfile profile) {
        Set<String> supported = new HashSet<>(profile.getSupportedOperations());

        // Build unsupported reasons: explicit unsupportedReasons map + deny-by-default for unknowns
        Map<String, String> unsupported = new LinkedHashMap<>();
        if (profile.getUnsupportedReasons() != null) {
            unsupported.putAll(profile.getUnsupportedReasons());
        }

        return new DeviceCapabilityResponse(
            deviceId,
            profile.getProfileId(),
            new ArrayList<>(supported),
            unsupported,
            profile.getProtocolPriorityByOperation(),
            profile.isReleaseEligible(),
            null
        );
    }

    // ── Response DTOs ─────────────────────────────────────────────────────────

    public record DeviceCapabilityResponse(
        String deviceId,
        String capabilityProfileId,
        List<String> supportedOperations,
        Map<String, String> unsupportedOperations,
        Map<String, List<String>> protocolPriorityByOperation,
        boolean releaseEligible,
        String reason
    ) {
        static DeviceCapabilityResponse noProfile(String deviceId) {
            return new DeviceCapabilityResponse(
                deviceId,
                null,
                List.of(),
                Map.of("*", "No capability profile assigned — all state-changing operations denied by default"),
                Map.of(),
                false,
                "No capability profile assigned"
            );
        }
    }

    public record BulkEvaluationResult(
        List<String> eligible,
        List<IneligibleEntry> ineligible
    ) {}

    public record IneligibleEntry(
        String deviceId,
        String reason
    ) {}
}
