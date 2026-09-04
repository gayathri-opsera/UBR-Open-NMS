package com.ubrnms.inventory.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.ubrnms.inventory.model.BirthCertificate;
import com.ubrnms.inventory.model.Device;
import com.ubrnms.inventory.model.DeviceTag;
import com.ubrnms.inventory.repository.BirthCertificateRepository;
import com.ubrnms.inventory.repository.DeviceRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

@Slf4j
@Service
@RequiredArgsConstructor
public class InventoryService {

    private final DeviceRepository deviceRepo;
    private final BirthCertificateRepository bcRepo;
    private final KafkaTemplate<String, String> kafkaTemplate;
    private final ObjectMapper objectMapper;

    @Autowired(required = false)
    private com.ubrnms.inventory.repository.hierarchy.PreAssignmentRepository preAssignRepo;

    @Autowired(required = false)
    private com.ubrnms.inventory.repository.DiscoveryModePolicyRepository discoveryModePolicyRepo;

    @Autowired(required = false)
    private com.ubrnms.inventory.repository.CapabilityProfileRepository capabilityProfileRepo;

    @Value("${kafka.topics.inventory-sync}")
    private String inventorySyncTopic;

    @Value("${kafka.topics.audit:audit-events}")
    private String auditTopic;

    @Value("${inventory.search.default-radius-km:1.0}")
    private double defaultRadiusKm;

    /** OID pattern for sysObjectID validation (WO-004). */
    private static final Pattern OID_PATTERN = Pattern.compile("^[0-9]+(\\.[0-9]+)*$");
    private static final int OID_MAX_LEN = 128;

    /**
     * UBR call-home is authoritative for these fields.
     * Generic discovery must NOT overwrite them (WO-002).
     */
    private static final Set<String> UBR_PROTECTED_FIELDS = Set.of(
        "serialNumber", "macAddress", "deviceType",
        "identityAuthority", "onlineStateAuthority",
        "bootstrapState", "lastCheckInAt", "lastRealtimeAt", "credentialRef"
    );

    // ---- Device CRUD ----

    public Device createDevice(Device device) {
        if (device.getLatitude() != 0 || device.getLongitude() != 0) {
            device.setLocation(new double[]{device.getLongitude(), device.getLatitude()});
        }
        if (device.getSchemaVersion() == null) device.setSchemaVersion("1.0");
        Device saved = deviceRepo.save(device);
        publishInventorySync(saved);
        return saved;
    }

    public Optional<Device> findById(String id) {
        return deviceRepo.findById(id);
    }

    public List<Device> listDevices(String deviceType, String status, int page, int limit) {
        return listDevices(deviceType, status, null, page, limit);
    }

    public List<Device> listDevices(String deviceType, String status, String sysObjectID, int page, int limit) {
        List<Device> all = deviceRepo.findAll();
        return all.stream()
                .filter(d -> deviceType == null || deviceType.equalsIgnoreCase(d.getDeviceType()))
                .filter(d -> status == null || status.equalsIgnoreCase(d.getStatus()))
                .filter(d -> sysObjectID == null || sysObjectID.equals(d.getSysObjectID()))
                .skip((long) page * limit)
                .limit(limit)
                .collect(Collectors.toList());
    }

    public Optional<Device> findBySerial(String serial) {
        return deviceRepo.findBySerialNumber(serial);
    }

    public Optional<Device> findByMac(String mac) {
        return deviceRepo.findByMacAddress(mac);
    }

    public Optional<Device> findByIp(String ip) {
        return deviceRepo.findByIpAddress(ip);
    }

    /**
     * Filter devices by sysObjectID — returns only generic-discovery devices matching the OID.
     * UBR devices (which never have a sysObjectID) are excluded (WO-004).
     */
    public List<Device> filterBySysObjectId(String sysObjectID) {
        return deviceRepo.findAll().stream()
                .filter(d -> sysObjectID.equals(d.getSysObjectID()))
                .collect(Collectors.toList());
    }

    public Device updateDevice(String id, Device updates) {
        Device existing = deviceRepo.findById(id)
                .orElseThrow(() -> new ResourceNotFoundException("Device not found: " + id));
        // Selective field update
        if (updates.getStatus() != null)          existing.setStatus(updates.getStatus());
        if (updates.getFirmwareVersion() != null)  existing.setFirmwareVersion(updates.getFirmwareVersion());
        if (updates.getSoftwareVersion() != null)  existing.setSoftwareVersion(updates.getSoftwareVersion());
        if (updates.getUptimeSeconds() > 0)        existing.setUptimeSeconds(updates.getUptimeSeconds());
        if (updates.getLatitude() != 0)            existing.setLatitude(updates.getLatitude());
        if (updates.getLongitude() != 0) {
            existing.setLongitude(updates.getLongitude());
            existing.setLocation(new double[]{updates.getLongitude(), updates.getLatitude()});
        }
        Device saved = deviceRepo.save(existing);
        publishInventorySync(saved);
        return saved;
    }

    public void deleteDevice(String id) {
        deviceRepo.deleteById(id);
    }

    // ---- GPS search (NMS-IV-04) ----

    public List<Device> searchByLocation(double lat, double lon, Double radiusKm) {
        double radius = (radiusKm != null ? radiusKm : defaultRadiusKm) * 1000; // metres
        return deviceRepo.findNearLocation(lon, lat, radius);
    }

    // ---- Metadata tagging (NMS-IV-06) ----

    public Device updateTags(String id, List<DeviceTag> tags) {
        Device device = deviceRepo.findById(id)
                .orElseThrow(() -> new ResourceNotFoundException("Device not found: " + id));
        device.setTags(tags);
        return deviceRepo.save(device);
    }

    // ---- Birth certificate (NMS-IV-05) ----

    public BirthCertificate createBirthCertificate(BirthCertificate bc) {
        if (bcRepo.findBySerialNumber(bc.getSerialNumber()).isPresent()) {
            throw new ConflictException("Birth certificate already exists for serial: " + bc.getSerialNumber());
        }
        bc.setCapturedAt(Instant.now());
        return bcRepo.save(bc);
    }

    public Optional<BirthCertificate> findBirthCertificate(String serialNumber) {
        return bcRepo.findBySerialNumber(serialNumber);
    }

    /**
     * Authority-aware merge for upsert operations (WO-002).
     *
     * <p>UBR call-home is authoritative for identity fields; generic discovery
     * may only update enrichment fields. Any attempt by a generic caller to
     * overwrite UBR-protected fields is silently ignored and logged with
     * correlation context (never logs secret values).
     *
     * @param existing      the persisted device record (may be a new empty Device)
     * @param update        the incoming field map from the discovery event
     * @param callerParadigm the discovery paradigm of the caller (UBR_CALL_HOME or GENERIC_*)
     * @return the merged device, not yet persisted
     */
    public Device mergeWithAuthority(Device existing, Map<String, Object> update, String callerParadigm) {
        boolean isUbr = "UBR_CALL_HOME".equalsIgnoreCase(callerParadigm);

        for (Map.Entry<String, Object> entry : update.entrySet()) {
            String field = entry.getKey();
            Object value = entry.getValue();
            if (value == null) continue;

            // Generic callers may not overwrite UBR-protected fields
            if (!isUbr && UBR_PROTECTED_FIELDS.contains(field)
                    && "UBR".equalsIgnoreCase(existing.getIdentityAuthority())) {
                log.warn(
                    "Generic discovery attempted to overwrite UBR-protected field '{}' on device serial=[redacted], correlation={}; preserving existing value",
                    field, update.getOrDefault("correlationId", "n/a")
                );
                continue;
            }

            applyField(existing, field, value, callerParadigm);
        }

        // Assign defaults when first-time creation
        if (existing.getSchemaVersion() == null) existing.setSchemaVersion("1.0");
        if (existing.getDiscoveryParadigm() == null) existing.setDiscoveryParadigm(callerParadigm);

        // Assign capability profile if not yet set
        if (existing.getCapabilityProfileId() == null) {
            assignDefaultCapabilityProfile(existing);
        }

        return existing;
    }

    // ---- Upsert from discovery ----

    /** Upsert device from Kafka device-discovered event (idempotent). Validates pre-assignment. */
    public Device upsertFromDiscovery(Map<String, Object> event) {
        String serial = (String) event.get("serialNumber");

        // Validate pre-assignment (WO-010)
        if (preAssignRepo != null) {
            var pa = preAssignRepo.findBySerialNumber(serial);
            if (pa.isEmpty()) {
                // Publish WARNING alarm for unassigned device
                try {
                    String alarmPayload = objectMapper.writeValueAsString(Map.of(
                        "alarmType", "NMS-DIS-UNASSIGNED",
                        "severity", "WARNING",
                        "source", serial,
                        "message", "Device attempted onboarding without pre-assignment: " + serial
                    ));
                    kafkaTemplate.send("raw-alarms", serial, alarmPayload);
                } catch (Exception e) {
                    log.error("Failed to publish unassigned device alarm for serial=[redacted]", e);
                }
                throw new NotPreAssignedException("Device not pre-assigned: " + serial);
            }
            // Update pre-assignment as onboarded
            pa.get().setOnboarded(true);
            preAssignRepo.save(pa.get());
        }

        String callerParadigm = (String) event.getOrDefault("discoveryParadigm", "UNKNOWN");
        Device device = deviceRepo.findBySerialNumber(serial).orElse(new Device());

        // Route through authority merge
        device = mergeWithAuthority(device, event, callerParadigm);

        // Validate and apply sysObjectID for generic devices (WO-004)
        if (event.containsKey("sysObjectID")) {
            String oid = (String) event.get("sysObjectID");
            if (oid != null && !oid.isBlank()) {
                validateSysObjectId(oid);
                device.setSysObjectID(oid);
            }
        }

        // Emit audit event for discovery mode change audit trail (WO-006)
        publishOnboardingAuditEvent(device, callerParadigm);

        Device saved = deviceRepo.save(device);
        publishInventorySync(saved);
        return saved;
    }

    // ── sysObjectID validation (WO-004) ──────────────────────────────────────

    /**
     * Validates a sysObjectID string against OID format rules.
     * Pattern: dotted-numeric segments only, max 128 chars.
     * Rejects empty, alphabetic tokens, path-like input, excessively long values.
     */
    public void validateSysObjectId(String oid) {
        if (oid == null || oid.isBlank()) {
            throw new ValidationException("sysObjectID must not be empty");
        }
        if (oid.length() > OID_MAX_LEN) {
            throw new ValidationException("sysObjectID exceeds maximum length of " + OID_MAX_LEN + " characters");
        }
        if (!OID_PATTERN.matcher(oid).matches()) {
            throw new ValidationException(
                "sysObjectID must be a dotted-numeric OID (e.g. 1.3.6.1.4.1.9) — received: [redacted]"
            );
        }
    }

    // ── private helpers ───────────────────────────────────────────────────────

    /**
     * Applies a single field from a discovery event to a device, respecting authority rules.
     * UBR-only fields are set unconditionally from UBR callers; generic callers
     * are limited to enrichment fields only.
     */
    @SuppressWarnings("unchecked")
    private void applyField(Device device, String field, Object value, String callerParadigm) {
        switch (field) {
            // --- Shared identity (set by UBR or first writer) ---
            case "serialNumber"    -> device.setSerialNumber(str(value));
            case "macAddress"      -> device.setMacAddress(str(value));
            case "deviceType"      -> device.setDeviceType(str(value));
            case "ipAddress"       -> device.setIpAddress(str(value));
            // --- UBR-authoritative fields ---
            case "identityAuthority"    -> device.setIdentityAuthority(str(value));
            case "onlineStateAuthority" -> device.setOnlineStateAuthority(str(value));
            case "bootstrapState"       -> device.setBootstrapState(str(value));
            case "lastCheckInAt"        -> device.setLastCheckInAt(toInstant(value));
            case "lastRealtimeAt"       -> device.setLastRealtimeAt(toInstant(value));
            // credentialRef is never logged or surfaced — stored opaquely
            case "credentialRef"        -> device.setCredentialRef(str(value));
            // --- Enrichment fields (generic or UBR may set) ---
            case "model"             -> device.setModel(str(value));
            case "firmwareVersion"   -> device.setFirmwareVersion(str(value));
            case "softwareVersion"   -> device.setSoftwareVersion(str(value));
            case "status"            -> device.setStatus(str(value));
            case "configVersion"     -> device.setConfigVersion(str(value));
            case "capabilityProfileId" -> device.setCapabilityProfileId(str(value));
            case "discoveryParadigm" -> device.setDiscoveryParadigm(str(value));
            case "schemaVersion"     -> device.setSchemaVersion(str(value));
            case "latitude" -> {
                double lat = toDouble(value);
                device.setLatitude(lat);
                if (device.getLongitude() != 0) {
                    device.setLocation(new double[]{device.getLongitude(), lat});
                }
            }
            case "longitude" -> {
                double lon = toDouble(value);
                device.setLongitude(lon);
                device.setLocation(new double[]{lon, device.getLatitude()});
            }
            case "azimuth"        -> device.setAzimuth(toDouble(value));
            case "uptimeSeconds"  -> device.setUptimeSeconds(toLong(value));
            case "region"         -> device.setRegion(str(value));
            case "organizationId" -> device.setOrganizationId(str(value));
            default -> { /* ignore unknown fields */ }
        }
    }

    /**
     * Assigns the default capability profile based on deviceType + discoveryParadigm (WO-003).
     * Falls back to a UNKNOWN paradigm entry when no exact match exists.
     */
    private void assignDefaultCapabilityProfile(Device device) {
        if (capabilityProfileRepo == null) return;
        String paradigm = device.getDiscoveryParadigm();
        String type = device.getDeviceType();
        capabilityProfileRepo.findByDeviceTypeAndDiscoveryParadigm(type, paradigm)
            .or(() -> capabilityProfileRepo.findByDiscoveryParadigm(paradigm))
            .ifPresent(p -> device.setCapabilityProfileId(p.getProfileId()));
    }

    /** Emits an onboarding attempt audit event via Kafka (WO-006). */
    private void publishOnboardingAuditEvent(Device device, String callerParadigm) {
        try {
            Map<String, Object> auditEvent = Map.of(
                "action", "onboarding.attempt",
                "actor", Map.of("userId", "system", "username", "inventory-service", "role", "system"),
                "resource", Map.of("type", "device", "id",
                    device.getSerialNumber() != null ? device.getSerialNumber() : "unknown"),
                "outcome", "pending",
                "discoveryParadigm", callerParadigm,
                "timestamp", Instant.now().toString()
            );
            kafkaTemplate.send(auditTopic, device.getSerialNumber(), objectMapper.writeValueAsString(auditEvent));
        } catch (Exception e) {
            log.warn("Failed to publish onboarding audit event; continuing upsert", e);
        }
    }

    private void publishInventorySync(Device device) {
        try {
            String payload = objectMapper.writeValueAsString(device);
            kafkaTemplate.send(inventorySyncTopic, device.getSerialNumber(), payload);
        } catch (Exception e) {
            log.error("Failed to publish inventory-sync for device serial=[redacted]", e);
        }
    }

    // ── Type coercions ────────────────────────────────────────────────────────

    private static String str(Object v) {
        return v != null ? v.toString() : null;
    }

    private static double toDouble(Object v) {
        if (v instanceof Number n) return n.doubleValue();
        try { return Double.parseDouble(v.toString()); } catch (Exception e) { return 0; }
    }

    private static long toLong(Object v) {
        if (v instanceof Number n) return n.longValue();
        try { return Long.parseLong(v.toString()); } catch (Exception e) { return 0; }
    }

    private static Instant toInstant(Object v) {
        if (v instanceof Instant i) return i;
        if (v instanceof String s) {
            try { return Instant.parse(s); } catch (Exception e) { return null; }
        }
        return null;
    }

    // ---- Inner exception types ----

    public static class NotPreAssignedException extends RuntimeException {
        public NotPreAssignedException(String msg) { super(msg); }
    }

    public static class ResourceNotFoundException extends RuntimeException {
        public ResourceNotFoundException(String msg) { super(msg); }
    }

    public static class ConflictException extends RuntimeException {
        public ConflictException(String msg) { super(msg); }
    }

    public static class ValidationException extends RuntimeException {
        public ValidationException(String msg) { super(msg); }
    }
}
