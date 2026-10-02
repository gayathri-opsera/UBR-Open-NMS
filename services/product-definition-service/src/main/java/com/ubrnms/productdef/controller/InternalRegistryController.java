package com.ubrnms.productdef.controller;

import com.ubrnms.productdef.model.FingerprintRegistryEntry;
import com.ubrnms.productdef.model.ParameterRegistryEntry;
import com.ubrnms.productdef.repository.FingerprintRegistryRepository;
import com.ubrnms.productdef.repository.ParameterRegistryRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.client.RestTemplate;


import java.util.*;
import java.util.stream.Collectors;

/**
 * Internal service-to-service registry endpoints.
 *
 * <p>These endpoints are NOT proxied through the API gateway and are not
 * accessible to external callers. They serve the discovery service (fingerprint
 * lookup) and the parameter poller (device polling profiles).
 *
 * <ul>
 *   <li>{@code GET /internal/fingerprint-registry} — fingerprint entries for the
 *       discovery service's {@code RegistryReader}</li>
 *   <li>{@code GET /internal/registry/active-profiles} — device polling profiles
 *       for the parameter poller's {@code registry.HTTPClient}</li>
 *   <li>{@code POST /internal/registry/device-association} — called by the
 *       discovery service after a successful fingerprint match to record which
 *       device maps to which product definition</li>
 * </ul>
 *
 * <p><b>Security:</b> no credential values, SNMP community strings, or vault
 * references may appear in any response from this controller.
 */
@Slf4j
@RestController
@RequestMapping("/internal")
@RequiredArgsConstructor
public class InternalRegistryController {

    private final FingerprintRegistryRepository fingerprintRepo;
    private final ParameterRegistryRepository   paramRepo;
    private final RestTemplate                  restTemplate;

    @Value("${inventory.service.url:http://inventory:8082}")
    private String inventoryUrl;

    // In-memory device-PD association map: deviceId → productDefinitionId
    // Populated by POST /internal/registry/device-association (called by discovery service)
    // and used by GET /internal/registry/active-profiles (called by parameter poller).
    private final Map<String, String> deviceToPdMap = Collections.synchronizedMap(new LinkedHashMap<>());

    // In-memory device IP map: deviceId → ipAddress (populated alongside deviceToPdMap)
    private final Map<String, String> deviceIpMap = Collections.synchronizedMap(new LinkedHashMap<>());

    // ── Fingerprint Registry ──────────────────────────────────────────────────

    /**
     * Returns all active fingerprint registry entries in the format expected by
     * the discovery service's {@code fingerprint.RegistryReader} interface.
     *
     * <p>The discovery service calls this endpoint to load its in-memory cache,
     * then matches {@code sysObjectID} from SNMP probes against {@code fingerprintValue}
     * to resolve {@code productDefinitionId}.
     */
    @GetMapping("/fingerprint-registry")
    public ResponseEntity<Map<String, Object>> getFingerprintRegistry() {
        List<FingerprintRegistryEntry> all = fingerprintRepo.findAll();

        // Build the registryVersion from the max across all entries
        long maxVersion = all.stream()
            .mapToLong(FingerprintRegistryEntry::getRegistryVersion)
            .max()
            .orElse(0L);

        // Map to the Go RegistryEntry wire format
        List<Map<String, Object>> entries = all.stream().map(e -> {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("RegistryEntryID",          e.getId());
            m.put("ProductDefinitionID",       e.getProductDefinitionId());
            m.put("ProductDefinitionVersion",  e.getVersionId());
            m.put("RegistryVersion",           String.valueOf(e.getRegistryVersion()));
            m.put("DeviceType", e.getDeviceType() != null ? e.getDeviceType() : "");
            m.put("Vendor",     e.getVendor() != null ? e.getVendor() : "");
            m.put("Model",      e.getModel()  != null ? e.getModel()  : "");
            m.put("FirmwareMin",               e.getFirmwareFrom());
            m.put("FirmwareMax",               e.getFirmwareTo());
            m.put("SupportedProtocols",        e.getSupportedProtocols() != null ? e.getSupportedProtocols() : List.of());
            m.put("PreferredProtocol",         e.getSupportedProtocols() != null && !e.getSupportedProtocols().isEmpty()
                ? e.getSupportedProtocols().get(0) : "SNMP");

            String type  = e.getFingerprintType();
            String value = e.getFingerprintValue();
            // Map to the Go RegistryEntry selector fields
            if ("SNMP_OID".equals(type)) {
                // Treat SNMP_OID fingerprints as prefix matches so that vendor enterprise OID
                // subtrees (e.g. 1.3.6.1.4.1.99999) match any device OID beneath them
                // (e.g. 1.3.6.1.4.1.99999.1.3). The Go matcher's SNMPOIDPrefix field uses
                // strings.HasPrefix(), which is exactly the right semantic here.
                m.put("SNMPOIDExact",       "");
                m.put("SNMPOIDPrefix",      value);
                m.put("SSHBannerSubstring", "");
                m.put("HTTPHeaderKey",      "");
                m.put("HTTPHeaderContains", "");
                m.put("HTTPBodyContains",   "");
                m.put("GRPCServiceExact",   "");
            } else if ("BANNER".equals(type)) {
                m.put("SNMPOIDExact",       "");
                m.put("SNMPOIDPrefix",      "");
                m.put("SSHBannerSubstring", value);
                m.put("HTTPHeaderKey",      "");
                m.put("HTTPHeaderContains", "");
                m.put("HTTPBodyContains",   "");
                m.put("GRPCServiceExact",   "");
            } else {
                // Default: OID exact
                m.put("SNMPOIDExact",       value != null ? value : "");
                m.put("SNMPOIDPrefix",      "");
                m.put("SSHBannerSubstring", "");
                m.put("HTTPHeaderKey",      "");
                m.put("HTTPHeaderContains", "");
                m.put("HTTPBodyContains",   "");
                m.put("GRPCServiceExact",   "");
            }
            return m;
        }).collect(Collectors.toList());

        Map<String, Object> response = new LinkedHashMap<>();
        response.put("registryVersion", String.valueOf(maxVersion));
        response.put("entries",         entries);
        response.put("count",           entries.size());

        log.info("[internal] fingerprint-registry served {} entries at version {}", entries.size(), maxVersion);
        return ResponseEntity.ok(response);
    }

    // ── Device Association ────────────────────────────────────────────────────

    /**
     * Called by the discovery service after a successful fingerprint match to
     * register which inventory device maps to which product definition.
     *
     * <p>Body: {@code { "deviceId": "...", "productDefinitionId": "...", "registryVersion": "1" }}
     */
    @PostMapping("/registry/device-association")
    public ResponseEntity<Map<String, String>> registerDeviceAssociation(
            @RequestBody Map<String, String> body) {
        String deviceId  = body.get("deviceId");
        String pdId      = body.get("productDefinitionId");
        String ipAddress = body.get("ipAddress");
        if (deviceId == null || pdId == null) {
            return ResponseEntity.badRequest()
                .body(Map.of("error", "deviceId and productDefinitionId are required"));
        }
        deviceToPdMap.put(deviceId, pdId);
        if (ipAddress != null && !ipAddress.isBlank()) {
            deviceIpMap.put(deviceId, ipAddress);
        }
        log.info("[internal] device-association registered: deviceId={} pdId={} ip={}", deviceId, pdId, ipAddress);
        return ResponseEntity.ok(Map.of("deviceId", deviceId, "productDefinitionId", pdId));
    }

    // ── Active Profiles ───────────────────────────────────────────────────────

    /**
     * Returns device polling profiles for the parameter poller's
     * {@code registry.HTTPClient.GetDeviceProfile()}.
     *
     * <p>The poller calls {@code GET /internal/registry/active-profiles} and caches
     * the response, keyed by {@code DeviceID}.  This endpoint:
     * <ol>
     *   <li>Queries the inventory service for all devices.</li>
     *   <li>Filters for devices with a non-null {@code productDefinitionId} (set
     *       either by the discovery service or by the manual device-association API above).</li>
     *   <li>Joins with the parameter registry to build the per-group OID lists.</li>
     * </ol>
     *
     * <p><b>Credential policy:</b> {@code CredentialRef} is an opaque reference
     * string, never the actual community string or password.
     */
    @GetMapping("/registry/active-profiles")
    public ResponseEntity<Map<String, Object>> getActiveProfiles() {
        // 1. Merge in-memory device-association map with inventory data
        Map<String, String> associations = new LinkedHashMap<>(deviceToPdMap);

        // 2. Also query inventory for devices that have productDefinitionId set
        //    (set by the discovery service or manual admin action on inventory)
        try {
            associations.putAll(fetchInventoryDeviceAssociations());
        } catch (Exception e) {
            log.warn("[internal] Could not reach inventory service — using in-memory associations only: {}", e.getMessage());
        }

        if (associations.isEmpty()) {
            log.info("[internal] active-profiles: no device-PD associations found — returning empty profiles");
            return ResponseEntity.ok(Map.of("version", "0", "profiles", List.of()));
        }

        // 3. Group associations by pdId so we can batch-fetch parameters
        Map<String, List<String>> pdToDevices = new LinkedHashMap<>();
        for (Map.Entry<String, String> entry : associations.entrySet()) {
            pdToDevices.computeIfAbsent(entry.getValue(), k -> new ArrayList<>()).add(entry.getKey());
        }

        // 4. Build profiles
        List<Map<String, Object>> profiles = new ArrayList<>();
        long maxRegistryVersion = 0L;

        for (Map.Entry<String, List<String>> pdEntry : pdToDevices.entrySet()) {
            String pdId   = pdEntry.getKey();
            List<String> deviceIds = pdEntry.getValue();

            List<ParameterRegistryEntry> params = paramRepo.findByProductDefinitionId(pdId);
            if (params.isEmpty()) {
                log.warn("[internal] active-profiles: no parameter entries for pdId={}", pdId);
                continue;
            }

            long regVer = params.stream()
                .mapToLong(ParameterRegistryEntry::getRegistryVersion)
                .max().orElse(0L);
            if (regVer > maxRegistryVersion) maxRegistryVersion = regVer;

            // Group parameters by groupId
            Map<String, List<ParameterRegistryEntry>> byGroup = params.stream()
                .collect(Collectors.groupingBy(ParameterRegistryEntry::getGroupId));

            List<Map<String, Object>> groups = byGroup.entrySet().stream().map(ge -> {
                Map<String, Object> g = new LinkedHashMap<>();
                g.put("GroupID",             ge.getKey());
                g.put("Label",               ge.getKey());
                g.put("PollIntervalSeconds",  300);

                List<Map<String, Object>> paramList = ge.getValue().stream().map(p -> {
                    Map<String, Object> pm = new LinkedHashMap<>();
                    pm.put("ParameterID",   p.getParameterId());
                    pm.put("Label",         p.getDisplayName() != null ? p.getDisplayName() : p.getParameterId());
                    pm.put("DataType",      p.getDataType() != null ? p.getDataType() : "STRING");
                    pm.put("Unit",          p.getUnit() != null ? p.getUnit() : "");
                    // Protocol and ReadRef — prefer SNMP OID
                    if (p.getSnmpOid() != null && !p.getSnmpOid().isBlank()) {
                        pm.put("Protocol",  "SNMP");
                        pm.put("ReadRef",   p.getSnmpOid());
                    } else if (p.getApiPath() != null && !p.getApiPath().isBlank()) {
                        pm.put("Protocol",  "REST");
                        pm.put("ReadRef",   p.getApiPath());
                    } else if (p.getCliCommand() != null && !p.getCliCommand().isBlank()) {
                        pm.put("Protocol",  "CLI");
                        pm.put("ReadRef",   p.getCliCommand());
                    } else {
                        pm.put("Protocol",  "SNMP");
                        pm.put("ReadRef",   "");
                    }
                    // CredentialRef: opaque reference — never the actual secret
                    pm.put("CredentialRef", "snmp-default-community");
                    // Threshold values from the Product Definition (for alarm evaluation)
                    try {
                        if (p.getThresholdHigh() != null) {
                            pm.put("ThresholdHigh", Double.parseDouble(p.getThresholdHigh()));
                        }
                    } catch (NumberFormatException ignored) { /* non-numeric threshold */ }
                    try {
                        if (p.getThresholdLow() != null) {
                            pm.put("ThresholdLow", Double.parseDouble(p.getThresholdLow()));
                        }
                    } catch (NumberFormatException ignored) { /* non-numeric threshold */ }
                    // Schema-declared min/max constraints for config drift detection.
                    // When a polled value falls outside these bounds and no operational
                    // threshold is configured, the poller raises a FRAMEWORK_DRIFT alarm.
                    if (p.getMinValue() != null) {
                        pm.put("MinValue", p.getMinValue());
                    }
                    if (p.getMaxValue() != null) {
                        pm.put("MaxValue", p.getMaxValue());
                    }
                    return pm;
                }).collect(Collectors.toList());

                g.put("Parameters", paramList);
                return g;
            }).collect(Collectors.toList());

            // Emit one profile per device ID (include DeviceIP for SNMP adapter targeting)
            for (String deviceId : deviceIds) {
                Map<String, Object> profile = new LinkedHashMap<>();
                profile.put("DeviceID",            deviceId);
                profile.put("DeviceIP",            deviceIpMap.getOrDefault(deviceId, ""));
                profile.put("ProductDefinitionID",  pdId);
                profile.put("RegistryVersion",      String.valueOf(regVer));
                profile.put("Groups",               groups);
                profiles.add(profile);
            }
        }

        Map<String, Object> response = new LinkedHashMap<>();
        response.put("version",  String.valueOf(maxRegistryVersion));
        response.put("profiles", profiles);

        log.info("[internal] active-profiles served {} profiles", profiles.size());
        return ResponseEntity.ok(response);
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    /**
     * Calls the inventory service to discover all devices that have a non-null
     * {@code productDefinitionId} and returns a map of deviceId → productDefinitionId.
     */
    @SuppressWarnings("unchecked")
    private Map<String, String> fetchInventoryDeviceAssociations() {
        Map<String, String> result = new LinkedHashMap<>();
        try {
            String url = inventoryUrl + "/api/v1/devices?limit=1000&page=0";
            Object raw = restTemplate.getForObject(url, Object.class);

            List<Map<String, Object>> devices;
            if (raw instanceof List) {
                devices = (List<Map<String, Object>>) raw;
            } else if (raw instanceof Map) {
                Object inner = ((Map<?, ?>) raw).get("devices");
                if (inner == null) inner = ((Map<?, ?>) raw).get("data");
                if (inner == null) inner = ((Map<?, ?>) raw).get("items");
                devices = inner instanceof List ? (List<Map<String, Object>>) inner : List.of();
            } else {
                return result;
            }

            for (Map<String, Object> d : devices) {
                String pdId = (String) d.get("productDefinitionId");
                if (pdId != null && !pdId.isBlank()) {
                    String devId = (String) d.get("id");
                    if (devId != null) {
                        result.put(devId, pdId);
                        // Cache IP so the parameter poller profile includes it
                        String ip = (String) d.get("ipAddress");
                        if (ip != null && !ip.isBlank()) {
                            deviceIpMap.put(devId, ip);
                        }
                    }
                }
            }
        } catch (Exception e) {
            log.warn("[internal] inventory call failed: {}", e.getMessage());
        }
        return result;
    }
}
