package com.ubrnms.inventory.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.ubrnms.inventory.model.BirthCertificate;
import com.ubrnms.inventory.model.Device;
import com.ubrnms.inventory.model.DeviceTag;
import com.ubrnms.inventory.model.OnboardingAssignmentPolicy;
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
    private OnboardingPolicyService onboardingPolicyService;

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

    /** Upsert device from Kafka device-discovered event (idempotent). Applies assignment gate policy (WO-033). */
    public Device upsertFromDiscovery(Map<String, Object> event) {
        String serial = (String) event.get("serialNumber");

        // Check the onboarding assignment gate policy (WO-033).
        // When the gate is enabled, a device without a pre-assignment is held in
        // PENDING_ASSIGNMENT instead of being rejected.
        boolean gateEnabled = onboardingPolicyService != null && onboardingPolicyService.isGateEnabled();
        boolean hasPreAssignment = false;

        if (preAssignRepo != null) {
            var pa = preAssignRepo.findBySerialNumber(serial);
            if (pa.isPresent()) {
                hasPreAssignment = true;
                pa.get().setOnboarded(true);
                preAssignRepo.save(pa.get());
            }
        }

        // Resolve onboarding gate state before persisting.
        String onboardingGateState;
        if (!gateEnabled) {
            // Gate disabled — all valid call-home devices are automatically managed.
            onboardingGateState = OnboardingAssignmentPolicy.GateState.MANAGED.name();
        } else if (hasPreAssignment) {
            // Gate enabled but device has an explicit pre-assignment — allow as managed.
            onboardingGateState = OnboardingAssignmentPolicy.GateState.MANAGED.name();
        } else {
            // Gate enabled and no pre-assignment — hold device until operator assigns.
            onboardingGateState = OnboardingAssignmentPolicy.GateState.PENDING_ASSIGNMENT.name();
            log.info("Device serial=[redacted] held in PENDING_ASSIGNMENT; assignment gate is enabled and no pre-assignment found");
            publishAssignmentPendingAuditEvent(serial, (String) event.getOrDefault("correlationId", "n/a"));
        }

        String callerParadigm = (String) event.getOrDefault("discoveryParadigm", "UNKNOWN");
        Device device = deviceRepo.findBySerialNumber(serial).orElse(new Device());

        // Route through authority merge
        device = mergeWithAuthority(device, event, callerParadigm);

        // Apply assignment gate state (WO-033).
        device.setOnboardingGateState(onboardingGateState);
        if (OnboardingAssignmentPolicy.GateState.PENDING_ASSIGNMENT.name().equals(onboardingGateState)) {
            device.setAssignmentRequired(true);
        }

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

    // ── Generic device registration from SNMP classification (WO-030) ────────

    /**
     * Registration payload for a generic SNMP-discovered device (WO-030).
     *
     * <p>Authority rules enforced:
     * <ul>
     *   <li>UBR call-home identity fields (serial, mac, deviceType, identityAuthority,
     *       onlineStateAuthority) are NEVER overwritten by generic discovery enrichment.</li>
     *   <li>If the device already exists as UBR, sysObjectID and sysDescr are added as
     *       enrichment; other generic fields are preserved.</li>
     *   <li>If {@code classificationStatus} is DEFERRED_UNSUPPORTED, the device is NOT
     *       registered as a managed device — the deferred state is recorded and an audit
     *       event is emitted so operators can investigate.</li>
     * </ul>
     */
    public GenericRegistrationResult upsertFromGenericDiscovery(Map<String, Object> payload) {
        String ip = (String) payload.get("ip");
        String correlationId = (String) payload.getOrDefault("correlationId", "n/a");
        String classificationStatus = (String) payload.getOrDefault("classificationStatus", "UNKNOWN");

        // DEFERRED_UNSUPPORTED and CLASSIFICATION_ERROR must never silently create managed devices.
        if (!"RECOGNISED".equalsIgnoreCase(classificationStatus)) {
            String deferReason = (String) payload.getOrDefault("deferReason", "UNSPECIFIED");
            log.warn("Generic discovery deferred: ip=[redacted], classificationStatus={}, reason={}, correlationId={}",
                classificationStatus, deferReason, correlationId);
            publishDeferredDiscoveryAuditEvent(ip, classificationStatus, deferReason, correlationId);
            return new GenericRegistrationResult(
                GenericRegistrationStatus.DEFERRED, null, classificationStatus, deferReason
            );
        }

        // For recognised devices, locate the existing record by IP or create a new one.
        // We deliberately do NOT use serial as idempotency key for generic devices because
        // generic discovery cannot reliably obtain serial numbers — management IP + sysObjectID
        // forms a stable composite identity (WO-030 technical_details).
        String sysObjectID = (String) payload.get("sysObjectID");
        Device device = deviceRepo.findByIpAddress(ip).orElse(new Device());

        // Determine the existing discovery paradigm for authority enforcement.
        String existingParadigm = device.getDiscoveryParadigm();
        String callerParadigm = "GENERIC_SNMP";

        device = mergeWithAuthority(device, payload, callerParadigm);

        // Apply WO-030 classification result fields (never overwrite for UBR devices).
        if (!"UBR_CALL_HOME".equalsIgnoreCase(existingParadigm)) {
            device.setVendor((String) payload.get("vendor"));
            device.setGenericDeviceType((String) payload.get("genericDeviceType"));
            device.setDriverId((String) payload.get("driverId"));
            device.setIdentityAuthority("GENERIC");
            device.setOnlineStateAuthority("GENERIC");
        }
        // Classification metadata is always recorded, even on UBR enrichment.
        device.setClassificationStatus(classificationStatus);
        device.setClassificationDeferReason((String) payload.get("deferReason"));
        device.setClassificationCorrelationId(correlationId);

        // Validate and apply sysObjectID (WO-004).
        if (sysObjectID != null && !sysObjectID.isBlank()) {
            validateSysObjectId(stripLeadingDot(sysObjectID));
            device.setSysObjectID(sysObjectID);
        }
        if (payload.containsKey("sysDescr") && payload.get("sysDescr") != null) {
            device.setSysDescr((String) payload.get("sysDescr"));
        }

        // Default IP address for generic devices.
        if (device.getIpAddress() == null && ip != null) {
            device.setIpAddress(ip);
        }

        // Assign default serial for generic devices that have no serial (prevents compound-index clash).
        // Format: GENERIC-IP-<ip> — stable across rediscovery runs for the same host.
        if (device.getSerialNumber() == null || device.getSerialNumber().isBlank()) {
            device.setSerialNumber("GENERIC-IP-" + ip);
        }

        publishOnboardingAuditEvent(device, callerParadigm);
        Device saved = deviceRepo.save(device);
        publishInventorySync(saved);

        log.info("Generic device registered: ip=[redacted], genericDeviceType={}, correlationId={}",
            device.getGenericDeviceType(), correlationId);

        return new GenericRegistrationResult(
            GenericRegistrationStatus.REGISTERED, saved.getId(), classificationStatus, null
        );
    }

    /** Strips the leading dot from an OID string before OID_PATTERN validation. */
    private static String stripLeadingDot(String oid) {
        return oid.startsWith(".") ? oid.substring(1) : oid;
    }

    /** Emits a structured audit event for deferred discoveries so operators can investigate. */
    private void publishDeferredDiscoveryAuditEvent(
            String ip, String classificationStatus, String deferReason, String correlationId) {
        try {
            Map<String, Object> auditEvent = Map.of(
                "action", "discovery.classification.deferred",
                "actor", Map.of("userId", "system", "username", "inventory-service", "role", "system"),
                "resource", Map.of("type", "device", "id", ip != null ? "[redacted]" : "unknown"),
                "outcome", "deferred",
                "classificationStatus", classificationStatus,
                "deferReason", deferReason,
                "correlationId", correlationId,
                "timestamp", Instant.now().toString()
            );
            kafkaTemplate.send(auditTopic, correlationId, objectMapper.writeValueAsString(auditEvent));
        } catch (Exception e) {
            log.warn("Failed to publish deferred discovery audit event; correlationId={}", correlationId, e);
        }
    }

    /** Status of a generic device registration attempt (WO-030). */
    public enum GenericRegistrationStatus {
        REGISTERED, DEFERRED, ERROR
    }

    /** Result returned from {@link #upsertFromGenericDiscovery(Map)}. */
    public record GenericRegistrationResult(
        GenericRegistrationStatus status,
        String inventoryDeviceId,
        String classificationStatus,
        String deferReason
    ) {}

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
            // WO-030 classification enrichment fields (generic-discovery only)
            case "vendor"              -> device.setVendor(str(value));
            case "genericDeviceType"   -> device.setGenericDeviceType(str(value));
            case "driverId"            -> device.setDriverId(str(value));
            case "classificationStatus" -> device.setClassificationStatus(str(value));
            case "classificationDeferReason" -> device.setClassificationDeferReason(str(value));
            case "classificationCorrelationId" -> device.setClassificationCorrelationId(str(value));
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

    /** Emits an audit event when a device is held in PENDING_ASSIGNMENT state (WO-033). */
    private void publishAssignmentPendingAuditEvent(String serial, String correlationId) {
        try {
            Map<String, Object> auditEvent = Map.of(
                "action", "onboarding.assignment.pending",
                "actor", Map.of("userId", "system", "username", "inventory-service", "role", "system"),
                "resource", Map.of("type", "device", "id", "[redacted]"),
                "outcome", "pending_assignment",
                "reason", "assignment_gate_enabled_no_pre_assignment",
                "correlationId", correlationId,
                "timestamp", Instant.now().toString()
            );
            kafkaTemplate.send(auditTopic, serial, objectMapper.writeValueAsString(auditEvent));
        } catch (Exception e) {
            log.warn("Failed to publish pending-assignment audit event; correlationId={}", correlationId, e);
        }
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
