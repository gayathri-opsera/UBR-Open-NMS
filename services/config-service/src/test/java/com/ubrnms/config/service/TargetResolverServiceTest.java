package com.ubrnms.config.service;

import com.ubrnms.config.model.ConfigTargetPreviewRequest;
import com.ubrnms.config.model.ConfigTargetPreviewRequest.TargetFilters;
import com.ubrnms.config.model.ConfigTargetPreviewResponse;
import com.ubrnms.config.model.ConfigTargetPreviewResponse.TargetEntry;
import com.ubrnms.config.model.ConfigTargetPreviewResponse.UnsupportedTargetEntry;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.util.*;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/**
 * Unit tests for {@link TargetResolverService} (WO-039).
 *
 * <p>Validates:
 * <ul>
 *   <li>Filter validation: empty filters, conflicting UBR+sysObjectID, unknown actionType</li>
 *   <li>Mixed-paradigm resolution: UBR and GENERIC devices in same preview</li>
 *   <li>Delivery channel classification: UBR_REALTIME, UBR_CHECKIN, SNMP_PROTOCOL, CLI_PROTOCOL</li>
 *   <li>Empty filter results: returns empty targets, not an error</li>
 *   <li>Capability gating: device missing operation goes to unsupportedTargets</li>
 *   <li>Credentials never appear in response</li>
 * </ul>
 */
@ExtendWith(MockitoExtension.class)
class TargetResolverServiceTest {

    @Mock
    private DeviceStatusChecker deviceStatusChecker;

    @Mock
    private InventorySearchClient inventorySearchClient;

    private TargetResolverService service;

    @BeforeEach
    void setUp() {
        service = new TargetResolverService(deviceStatusChecker, inventorySearchClient);
    }

    // ── AC3: Validation — empty filters ───────────────────────────────────────

    @Test
    void emptyFiltersObject_throwsValidationException() {
        ConfigTargetPreviewRequest req = buildRequest("CONFIG_PUSH", new TargetFilters());
        assertThatThrownBy(() -> service.validateRequest(req))
            .isInstanceOf(TargetResolverService.ValidationException.class)
            .hasMessageContaining("At least one filter field");
    }

    @Test
    void nullFilters_throwsValidationException() {
        ConfigTargetPreviewRequest req = buildRequest("CONFIG_PUSH", null);
        assertThatThrownBy(() -> service.validateRequest(req))
            .isInstanceOf(TargetResolverService.ValidationException.class);
    }

    @Test
    void unknownActionType_throwsValidationException() {
        TargetFilters f = new TargetFilters();
        f.setDeviceType("BTS");
        ConfigTargetPreviewRequest req = buildRequest("INVALID_ACTION", f);
        assertThatThrownBy(() -> service.validateRequest(req))
            .isInstanceOf(TargetResolverService.ValidationException.class)
            .hasMessageContaining("Unknown actionType");
    }

    @Test
    void conflictingUbrParadigmWithSysObjectID_throwsValidationException() {
        TargetFilters f = new TargetFilters();
        f.setDiscoveryParadigm("UBR_CALL_HOME");
        f.setSysObjectID("1.3.6.1.4.1.9");
        ConfigTargetPreviewRequest req = buildRequest("CONFIG_PUSH", f);

        assertThatThrownBy(() -> service.validateRequest(req))
            .isInstanceOf(TargetResolverService.ValidationException.class)
            .satisfies(ex -> assertThat(((TargetResolverService.ValidationException) ex).field)
                .isEqualTo("filters.sysObjectID"));
    }

    @Test
    void validFilters_noValidationException() {
        TargetFilters f = new TargetFilters();
        f.setDeviceType("BTS");
        ConfigTargetPreviewRequest req = buildRequest("CONFIG_PUSH", f);
        assertThatNoException().isThrownBy(() -> service.validateRequest(req));
    }

    // ── AC1/AC2: Mixed paradigm resolution ────────────────────────────────────

    @Test
    void mixedParadigm_ubrAndGenericDevices_classifiedSeparately() {
        when(inventorySearchClient.search(any(), anyInt()))
            .thenReturn(List.of(ubrDevice("SN-001"), genericSnmpDevice("SN-002")));
        when(deviceStatusChecker.isOnline("dev-SN-001")).thenReturn(true);

        TargetFilters f = new TargetFilters();
        f.setStatus("ACTIVE");
        ConfigTargetPreviewRequest req = buildRequest("CONFIG_PUSH", f);
        service.validateRequest(req);

        ConfigTargetPreviewResponse resp = service.resolveTargets(req, "network_engineer");

        assertThat(resp.getTargets()).hasSize(2);
        TargetEntry ubr = resp.getTargets().stream()
            .filter(t -> "UBR_CALL_HOME".equals(t.getDiscoveryParadigm())).findFirst().orElseThrow();
        TargetEntry generic = resp.getTargets().stream()
            .filter(t -> "GENERIC_SNMP".equals(t.getDiscoveryParadigm())).findFirst().orElseThrow();

        assertThat(ubr.getDeliveryChannel()).isEqualTo("UBR_REALTIME");
        assertThat(generic.getDeliveryChannel()).isEqualTo("SNMP_PROTOCOL");

        // UBR and generic are NEVER collapsed
        assertThat(ubr.getDiscoveryParadigm()).isNotEqualTo(generic.getDiscoveryParadigm());
    }

    // ── AC1: UBR offline device → UBR_CHECKIN ────────────────────────────────

    @Test
    void ubrOfflineDevice_deliveryChannelIsUbrCheckin() {
        when(inventorySearchClient.search(any(), anyInt()))
            .thenReturn(List.of(ubrDevice("SN-OFFLINE")));
        when(deviceStatusChecker.isOnline("dev-SN-OFFLINE")).thenReturn(false);

        TargetFilters f = new TargetFilters();
        f.setDiscoveryParadigm("UBR_CALL_HOME");
        ConfigTargetPreviewRequest req = buildRequest("CONFIG_PUSH", f);
        service.validateRequest(req);

        ConfigTargetPreviewResponse resp = service.resolveTargets(req, "admin");

        TargetEntry t = resp.getTargets().get(0);
        assertThat(t.getDeliveryChannel()).isEqualTo("UBR_CHECKIN");
        assertThat(t.getWarnings()).anyMatch(w -> w.contains("offline"));
    }

    // ── AC1: GENERIC_CLI device → CLI_PROTOCOL ────────────────────────────────

    @Test
    void genericCliDevice_deliveryChannelIsCliProtocol() {
        when(inventorySearchClient.search(any(), anyInt()))
            .thenReturn(List.of(genericCliDevice("SN-CLI")));

        TargetFilters f = new TargetFilters();
        f.setDiscoveryParadigm("GENERIC_CLI");
        ConfigTargetPreviewRequest req = buildRequest("CONFIG_PUSH", f);
        service.validateRequest(req);

        ConfigTargetPreviewResponse resp = service.resolveTargets(req, "admin");

        assertThat(resp.getTargets()).hasSize(1);
        assertThat(resp.getTargets().get(0).getDeliveryChannel()).isEqualTo("CLI_PROTOCOL");
    }

    // ── AC3: Valid filters, empty inventory result → empty preview ────────────

    @Test
    void validFilters_inventoryReturnsEmpty_previewIsEmpty() {
        when(inventorySearchClient.search(any(), anyInt())).thenReturn(Collections.emptyList());

        TargetFilters f = new TargetFilters();
        f.setDeviceType("BTS");
        f.setRegion("NORTH");
        ConfigTargetPreviewRequest req = buildRequest("CONFIG_PUSH", f);
        service.validateRequest(req);

        ConfigTargetPreviewResponse resp = service.resolveTargets(req, "admin");

        assertThat(resp.getTargets()).isEmpty();
        assertThat(resp.getUnsupportedTargets()).isEmpty();
        assertThat(resp.getTotalCount()).isZero();
        assertThat(resp.getPreviewId()).isNotBlank();
        assertThat(resp.getGeneratedAt()).isNotBlank();
    }

    // ── AC4: Capability gating ────────────────────────────────────────────────

    @Test
    void deviceMissingFirmwareOperation_goesToUnsupportedTargets() {
        Map<String, Object> dev = genericSnmpDevice("SN-NO-FW");
        // Device has config.push but NOT firmware.upgrade
        dev.put("capabilities", List.of("config.push", "config.parameter"));
        when(inventorySearchClient.search(any(), anyInt())).thenReturn(List.of(dev));

        TargetFilters f = new TargetFilters();
        f.setSysObjectID("1.3.6.1.4.1.9");
        ConfigTargetPreviewRequest req = buildRequest("FIRMWARE_UPGRADE", f);
        service.validateRequest(req);

        ConfigTargetPreviewResponse resp = service.resolveTargets(req, "admin");

        assertThat(resp.getTargets()).isEmpty();
        assertThat(resp.getUnsupportedTargets()).hasSize(1);
        UnsupportedTargetEntry u = resp.getUnsupportedTargets().get(0);
        assertThat(u.getUnsupportedOperation()).isEqualTo("firmware.upgrade");
        assertThat(u.getReason()).contains("firmware.upgrade");
    }

    // ── AC6: Credentials never in response ────────────────────────────────────

    @Test
    void response_neverContainsCredentials() {
        Map<String, Object> dev = ubrDevice("SN-001");
        dev.put("hmacKey", "secret-key");
        dev.put("credentialRef", "vault://ubr/SN-001");
        dev.put("birthCertificateId", "cert-abc");
        when(inventorySearchClient.search(any(), anyInt())).thenReturn(List.of(dev));
        when(deviceStatusChecker.isOnline("dev-SN-001")).thenReturn(true);

        TargetFilters f = new TargetFilters();
        f.setDiscoveryParadigm("UBR_CALL_HOME");
        ConfigTargetPreviewRequest req = buildRequest("CONFIG_PUSH", f);
        service.validateRequest(req);

        ConfigTargetPreviewResponse resp = service.resolveTargets(req, "admin");

        // Convert to string to check no secrets leak
        String serialized = resp.toString();
        assertThat(serialized).doesNotContain("secret-key");
        assertThat(serialized).doesNotContain("vault://");

        // TargetEntry fields never include hmacKey or credentialRef
        TargetEntry t = resp.getTargets().get(0);
        assertThat(t).hasNoNullFieldsOrPropertiesExcept("sysObjectID");
        // macAddress is present for SNMP, may be null for UBR — check it's there
        assertThat(t.getDeviceId()).isNotBlank();
    }

    // ── AC1: requiresConfirmation flag ────────────────────────────────────────

    @Test
    void firmwareUpgrade_requiresConfirmationIsTrue() {
        when(inventorySearchClient.search(any(), anyInt()))
            .thenReturn(List.of(genericSnmpDevice("SN-FW")));

        TargetFilters f = new TargetFilters();
        f.setSysObjectID("1.3.6.1.4.1.9");
        ConfigTargetPreviewRequest req = buildRequest("FIRMWARE_UPGRADE", f);
        service.validateRequest(req);

        ConfigTargetPreviewResponse resp = service.resolveTargets(req, "admin");
        assertThat(resp.isRequiresConfirmation()).isTrue();
    }

    @Test
    void configPushSmallFleet_requiresConfirmationIsFalse() {
        when(inventorySearchClient.search(any(), anyInt()))
            .thenReturn(List.of(genericSnmpDevice("SN-001")));
        TargetFilters f = new TargetFilters();
        f.setDeviceType("GENERIC");
        ConfigTargetPreviewRequest req = buildRequest("CONFIG_PUSH", f);
        service.validateRequest(req);

        ConfigTargetPreviewResponse resp = service.resolveTargets(req, "admin");
        assertThat(resp.isRequiresConfirmation()).isFalse();
    }

    // ── AC4: tag matching survives missing sysObjectID ────────────────────────

    @Test
    void deviceMissingSysObjectID_matchesByDeviceTypeOnly() {
        Map<String, Object> dev = ubrDevice("SN-NO-OID");
        dev.remove("sysObjectID");
        when(inventorySearchClient.search(any(), anyInt())).thenReturn(List.of(dev));
        when(deviceStatusChecker.isOnline("dev-SN-NO-OID")).thenReturn(true);

        TargetFilters f = new TargetFilters();
        f.setDeviceType("BTS");
        ConfigTargetPreviewRequest req = buildRequest("CONFIG_PUSH", f);
        service.validateRequest(req);

        ConfigTargetPreviewResponse resp = service.resolveTargets(req, "admin");
        assertThat(resp.getTargets()).hasSize(1);
        assertThat(resp.getTargets().get(0).getSysObjectID()).isNull();
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private ConfigTargetPreviewRequest buildRequest(String actionType, TargetFilters filters) {
        ConfigTargetPreviewRequest req = new ConfigTargetPreviewRequest();
        req.setActionType(actionType);
        req.setFilters(filters);
        req.setLimit(500);
        return req;
    }

    private Map<String, Object> ubrDevice(String serial) {
        Map<String, Object> d = new HashMap<>();
        d.put("id", "dev-" + serial);
        d.put("serialNumber", serial);
        d.put("deviceType", "BTS");
        d.put("macAddress", "AA:BB:CC:DD:EE:FF");
        d.put("discoveryParadigm", "UBR_CALL_HOME");
        d.put("status", "ACTIVE");
        d.put("capabilities", List.of("config.push", "firmware.upgrade", "config.parameter", "command.execute"));
        return d;
    }

    private Map<String, Object> genericSnmpDevice(String serial) {
        Map<String, Object> d = new HashMap<>();
        d.put("id", "dev-" + serial);
        d.put("serialNumber", serial);
        d.put("deviceType", "GENERIC");
        d.put("macAddress", "00:11:22:33:44:55");
        d.put("discoveryParadigm", "GENERIC_SNMP");
        d.put("sysObjectID", "1.3.6.1.4.1.9");
        d.put("vendor", "Cisco");
        d.put("status", "ACTIVE");
        d.put("capabilities", List.of("config.push", "firmware.upgrade", "config.parameter", "command.execute"));
        return d;
    }

    private Map<String, Object> genericCliDevice(String serial) {
        Map<String, Object> d = new HashMap<>();
        d.put("id", "dev-" + serial);
        d.put("serialNumber", serial);
        d.put("deviceType", "GENERIC");
        d.put("macAddress", "BB:CC:DD:EE:FF:00");
        d.put("discoveryParadigm", "GENERIC_CLI");
        d.put("status", "ACTIVE");
        d.put("capabilities", Collections.emptyList());
        return d;
    }
}
