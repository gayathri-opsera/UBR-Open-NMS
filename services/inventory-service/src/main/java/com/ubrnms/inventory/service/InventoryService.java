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

    @Value("${kafka.topics.inventory-sync}")
    private String inventorySyncTopic;

    @Value("${inventory.search.default-radius-km:1.0}")
    private double defaultRadiusKm;

    // ---- Device CRUD ----

    public Device createDevice(Device device) {
        if (device.getLatitude() != 0 || device.getLongitude() != 0) {
            device.setLocation(new double[]{device.getLongitude(), device.getLatitude()});
        }
        Device saved = deviceRepo.save(device);
        publishInventorySync(saved);
        return saved;
    }

    public Optional<Device> findById(String id) {
        return deviceRepo.findById(id);
    }

    public List<Device> listDevices(String deviceType, String status, int page, int limit) {
        List<Device> all = deviceRepo.findAll();
        return all.stream()
                .filter(d -> deviceType == null || deviceType.equalsIgnoreCase(d.getDeviceType()))
                .filter(d -> status == null || status.equalsIgnoreCase(d.getStatus()))
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
                    log.error("Failed to publish unassigned device alarm for {}", serial, e);
                }
                throw new NotPreAssignedException("Device not pre-assigned: " + serial);
            }
            // Update pre-assignment as onboarded
            pa.get().setOnboarded(true);
            preAssignRepo.save(pa.get());
        }

        Device device = deviceRepo.findBySerialNumber(serial).orElse(new Device());
        device.setSerialNumber(serial);
        device.setMacAddress((String) event.get("macAddress"));
        device.setIpAddress((String) event.get("ipAddress"));
        device.setDeviceType((String) event.getOrDefault("deviceType", "UNKNOWN"));
        device.setSoftwareVersion((String) event.get("softwareVersion"));
        device.setStatus("ACTIVE");
        Number lat = (Number) event.get("latitude");
        Number lon = (Number) event.get("longitude");
        if (lat != null && lon != null) {
            device.setLatitude(lat.doubleValue());
            device.setLongitude(lon.doubleValue());
            device.setLocation(new double[]{lon.doubleValue(), lat.doubleValue()});
        }
        Number azimuth = (Number) event.get("azimuth");
        if (azimuth != null) device.setAzimuth(azimuth.doubleValue());
        Number uptime = (Number) event.get("uptimeSeconds");
        if (uptime != null) device.setUptimeSeconds(uptime.longValue());

        Device saved = deviceRepo.save(device);
        publishInventorySync(saved);
        return saved;
    }

    private void publishInventorySync(Device device) {
        try {
            String payload = objectMapper.writeValueAsString(device);
            kafkaTemplate.send(inventorySyncTopic, device.getSerialNumber(), payload);
        } catch (Exception e) {
            log.error("Failed to publish inventory-sync for device {}", device.getSerialNumber(), e);
        }
    }

    public static class NotPreAssignedException extends RuntimeException {
        public NotPreAssignedException(String msg) { super(msg); }
    }

    // ---- Inner exception types ----

    public static class ResourceNotFoundException extends RuntimeException {
        public ResourceNotFoundException(String msg) { super(msg); }
    }

    public static class ConflictException extends RuntimeException {
        public ConflictException(String msg) { super(msg); }
    }
}
