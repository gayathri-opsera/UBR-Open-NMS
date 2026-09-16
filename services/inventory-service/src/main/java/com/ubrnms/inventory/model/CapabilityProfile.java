package com.ubrnms.inventory.model;

import lombok.Data;
import lombok.NoArgsConstructor;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.index.Indexed;
import org.springframework.data.mongodb.core.mapping.Document;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * Capability profile document — maps a device profile to supported operations,
 * protocol priorities, and release-1 eligibility (WO-003).
 *
 * <p>Profiles are matched by deviceType + discoveryParadigm. A null deviceType
 * matches any device type within that paradigm (e.g. generic SNMP catch-all).
 *
 * <p>Deny-by-default: a device with no capabilityProfileId is considered
 * unsupported for ALL state-changing operations.
 */
@Data
@NoArgsConstructor
@Document(collection = "capability_profiles")
public class CapabilityProfile {

    @Id
    private String id;

    /** Unique stable identifier referenced from Device.capabilityProfileId. */
    @Indexed(unique = true)
    private String profileId;

    /**
     * Device type this profile applies to (BTS, CPE, IDU).
     * Null means the profile applies to any device type for the given paradigm.
     */
    @Indexed
    private String deviceType;

    /** Discovery paradigm this profile applies to (UBR_CALL_HOME, GENERIC_SNMP, etc.). */
    @Indexed
    private String discoveryParadigm;

    /**
     * Operations this profile explicitly supports.
     * Any operation NOT in this list is considered unsupported.
     */
    private List<String> supportedOperations = new ArrayList<>();

    /**
     * Protocol priority ordering per operation.
     * Key: operation name; Value: ordered list of protocol names to try.
     * An empty list means the operation is blocked even if listed as supported.
     */
    private Map<String, List<String>> protocolPriorityByOperation;

    /**
     * Whether this profile is eligible for release-1 production use.
     * Profiles in beta or experimental state should set this to false.
     */
    private boolean releaseEligible;

    /**
     * Human-readable reasons why specific operations are not supported.
     * Key: operation name; Value: reason string.
     */
    private Map<String, String> unsupportedReasons;
}
