package com.ubrnms.inventory.service;

import com.ubrnms.inventory.model.CapabilityProfile;
import com.ubrnms.inventory.model.Device;
import com.ubrnms.inventory.repository.CapabilityProfileRepository;
import com.ubrnms.inventory.repository.DeviceRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;

/**
 * Unit tests for CapabilityRegistryService (WO-003).
 * Covers: lookup, deny-by-default, protocol priority, bulk evaluation.
 */
@ExtendWith(MockitoExtension.class)
class CapabilityRegistryServiceTest {

    @Mock private CapabilityProfileRepository profileRepo;
    @Mock private DeviceRepository deviceRepo;

    @InjectMocks
    private CapabilityRegistryService registryService;

    // ── Test fixtures ─────────────────────────────────────────────────────────

    private CapabilityProfile ubrBtsProfile() {
        CapabilityProfile p = new CapabilityProfile();
        p.setProfileId("ubr-bts-r1");
        p.setDeviceType("BTS");
        p.setDiscoveryParadigm("UBR_CALL_HOME");
        p.setSupportedOperations(List.of("firmware.upgrade", "config.push", "reboot", "status.read", "kpi.collect"));
        p.setProtocolPriorityByOperation(Map.of("config.push", List.of("NETCONF", "CLI")));
        p.setReleaseEligible(true);
        return p;
    }

    private CapabilityProfile genericSnmpProfile() {
        CapabilityProfile p = new CapabilityProfile();
        p.setProfileId("generic-snmp-r1");
        p.setDeviceType(null);
        p.setDiscoveryParadigm("GENERIC_SNMP");
        p.setSupportedOperations(List.of("status.read", "kpi.collect"));
        p.setProtocolPriorityByOperation(Map.of());
        p.setReleaseEligible(true);
        p.setUnsupportedReasons(Map.of(
            "firmware.upgrade", "Not supported for generic SNMP discovery in release 1",
            "config.push", "Not supported for generic SNMP discovery in release 1"
        ));
        return p;
    }

    private Device ubrBtsDevice(String id, String profileId) {
        Device d = new Device();
        d.setId(id);
        d.setDeviceType("BTS");
        d.setDiscoveryParadigm("UBR_CALL_HOME");
        d.setCapabilityProfileId(profileId);
        return d;
    }

    // ── Lookup tests ──────────────────────────────────────────────────────────

    @Test
    void listAllProfiles_returnsAllSeededProfiles() {
        when(profileRepo.findAll()).thenReturn(List.of(ubrBtsProfile(), genericSnmpProfile()));

        List<CapabilityProfile> profiles = registryService.listAllProfiles();

        assertThat(profiles).hasSize(2);
        assertThat(profiles).extracting("profileId").contains("ubr-bts-r1", "generic-snmp-r1");
    }

    @Test
    void evaluateDevice_withValidProfile_returnsSupportedOps() {
        Device device = ubrBtsDevice("dev-001", "ubr-bts-r1");
        when(deviceRepo.findById("dev-001")).thenReturn(Optional.of(device));
        when(profileRepo.findByProfileId("ubr-bts-r1")).thenReturn(Optional.of(ubrBtsProfile()));

        CapabilityRegistryService.DeviceCapabilityResponse resp = registryService.evaluateDevice("dev-001");

        assertThat(resp.deviceId()).isEqualTo("dev-001");
        assertThat(resp.capabilityProfileId()).isEqualTo("ubr-bts-r1");
        assertThat(resp.supportedOperations()).contains("firmware.upgrade", "config.push", "reboot");
        assertThat(resp.releaseEligible()).isTrue();
        assertThat(resp.protocolPriorityByOperation()).containsKey("config.push");
        assertThat(resp.protocolPriorityByOperation().get("config.push")).containsExactly("NETCONF", "CLI");
    }

    // ── Deny-by-default tests ─────────────────────────────────────────────────

    @Test
    void evaluateDevice_withNoProfile_denyByDefault() {
        Device device = new Device();
        device.setId("dev-002");
        device.setCapabilityProfileId(null);
        when(deviceRepo.findById("dev-002")).thenReturn(Optional.of(device));

        CapabilityRegistryService.DeviceCapabilityResponse resp = registryService.evaluateDevice("dev-002");

        assertThat(resp.supportedOperations()).isEmpty();
        assertThat(resp.releaseEligible()).isFalse();
        assertThat(resp.reason()).contains("No capability profile");
    }

    @Test
    void evaluateDevice_withUnknownProfileId_denyByDefault() {
        Device device = ubrBtsDevice("dev-003", "nonexistent-profile");
        when(deviceRepo.findById("dev-003")).thenReturn(Optional.of(device));
        when(profileRepo.findByProfileId("nonexistent-profile")).thenReturn(Optional.empty());

        CapabilityRegistryService.DeviceCapabilityResponse resp = registryService.evaluateDevice("dev-003");

        assertThat(resp.supportedOperations()).isEmpty();
        assertThat(resp.releaseEligible()).isFalse();
    }

    @Test
    void evaluateDevice_notFound_throwsResourceNotFoundException() {
        when(deviceRepo.findById("missing")).thenReturn(Optional.empty());

        assertThatThrownBy(() -> registryService.evaluateDevice("missing"))
                .isInstanceOf(InventoryService.ResourceNotFoundException.class);
    }

    // ── Protocol priority tests ───────────────────────────────────────────────

    @Test
    void evaluateDevice_genericSnmp_hasNoProtocolChain() {
        Device device = new Device();
        device.setId("dev-004");
        device.setCapabilityProfileId("generic-snmp-r1");
        when(deviceRepo.findById("dev-004")).thenReturn(Optional.of(device));
        when(profileRepo.findByProfileId("generic-snmp-r1")).thenReturn(Optional.of(genericSnmpProfile()));

        CapabilityRegistryService.DeviceCapabilityResponse resp = registryService.evaluateDevice("dev-004");

        // generic SNMP profile has an empty protocol map — no config.push
        assertThat(resp.supportedOperations()).doesNotContain("config.push");
        assertThat(resp.unsupportedOperations()).containsKey("config.push");
    }

    // ── Bulk evaluation tests ─────────────────────────────────────────────────

    @Test
    void evaluateBulk_splitEligibleAndIneligible() {
        Device ubrDev = ubrBtsDevice("dev-001", "ubr-bts-r1");
        Device genericDev = new Device();
        genericDev.setId("dev-004");
        genericDev.setCapabilityProfileId("generic-snmp-r1");

        when(deviceRepo.findById("dev-001")).thenReturn(Optional.of(ubrDev));
        when(deviceRepo.findById("dev-004")).thenReturn(Optional.of(genericDev));
        when(profileRepo.findByProfileId("ubr-bts-r1")).thenReturn(Optional.of(ubrBtsProfile()));
        when(profileRepo.findByProfileId("generic-snmp-r1")).thenReturn(Optional.of(genericSnmpProfile()));

        CapabilityRegistryService.BulkEvaluationResult result =
                registryService.evaluateBulk(List.of("dev-001", "dev-004"), "config.push");

        assertThat(result.eligible()).contains("dev-001");
        assertThat(result.ineligible()).extracting("deviceId").contains("dev-004");
        assertThat(result.ineligible().get(0).reason()).contains("generic SNMP");
    }

    @Test
    void evaluateBulk_missingDevice_markedIneligible() {
        when(deviceRepo.findById("ghost")).thenReturn(Optional.empty());

        CapabilityRegistryService.BulkEvaluationResult result =
                registryService.evaluateBulk(List.of("ghost"), "status.read");

        assertThat(result.eligible()).isEmpty();
        assertThat(result.ineligible()).hasSize(1);
        assertThat(result.ineligible().get(0).reason()).contains("not found");
    }

    // ── Default profile assignment ────────────────────────────────────────────

    @Test
    void defaultProfiles_btsUbr_supportsConfigPush() {
        CapabilityProfile profile = ubrBtsProfile();
        assertThat(profile.getSupportedOperations()).contains("config.push");
        assertThat(profile.getProtocolPriorityByOperation().get("config.push"))
                .containsExactly("NETCONF", "CLI");
    }

    @Test
    void defaultProfiles_genericSnmp_doesNotSupportFirmwareUpgrade() {
        CapabilityProfile profile = genericSnmpProfile();
        assertThat(profile.getSupportedOperations()).doesNotContain("firmware.upgrade");
        assertThat(profile.getUnsupportedReasons()).containsKey("firmware.upgrade");
    }
}
