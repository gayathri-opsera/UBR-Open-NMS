package com.ubrnms.inventory.controller;

import com.ubrnms.inventory.model.BirthCertificate;
import com.ubrnms.inventory.model.Device;
import com.ubrnms.inventory.model.DeviceTag;
import com.ubrnms.inventory.model.PagedResponse;
import com.ubrnms.inventory.service.ExportService;
import com.ubrnms.inventory.service.InventoryService;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/v1/devices")
@RequiredArgsConstructor
public class InventoryController {

    private final InventoryService inventoryService;
    private final ExportService exportService;

    @PostMapping
    public ResponseEntity<Device> create(@RequestBody Device device) {
        return ResponseEntity.status(HttpStatus.CREATED).body(inventoryService.createDevice(device));
    }

    @GetMapping("/{id}")
    public ResponseEntity<Device> getById(@PathVariable String id) {
        return inventoryService.findById(id)
                .map(ResponseEntity::ok)
                .orElse(ResponseEntity.notFound().build());
    }

    @GetMapping
    public ResponseEntity<?> search(
            @RequestParam(required = false) String serial,
            @RequestParam(required = false) String mac,
            @RequestParam(required = false) String ip,
            @RequestParam(required = false) String deviceType,
            @RequestParam(required = false) String status,
            @RequestParam(required = false, defaultValue = "0") int page,
            @RequestParam(required = false, defaultValue = "100") int limit) {
        if (serial != null) {
            return inventoryService.findBySerial(serial)
                    .map(ResponseEntity::ok)
                    .orElse(ResponseEntity.notFound().build());
        }
        if (mac != null) {
            return inventoryService.findByMac(mac)
                    .map(ResponseEntity::ok)
                    .orElse(ResponseEntity.notFound().build());
        }
        if (ip != null) {
            return inventoryService.findByIp(ip)
                    .map(ResponseEntity::ok)
                    .orElse(ResponseEntity.notFound().build());
        }
        // List all devices with optional type/status filters — DB-level pagination (WO-008).
        try {
            PagedResponse<Device> paged = inventoryService.listDevices(deviceType, status, page, limit);
            return ResponseEntity.ok(paged);
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest()
                    .body(Map.of("error", Map.of("code", "INVALID_PAGINATION", "message", e.getMessage())));
        }
    }

    @PostMapping("/search")
    public ResponseEntity<List<Device>> locationSearch(
            @RequestBody Map<String, Object> body) {
        double lat = ((Number) body.get("latitude")).doubleValue();
        double lon = ((Number) body.get("longitude")).doubleValue();
        Double radius = body.containsKey("radiusKm") ? ((Number) body.get("radiusKm")).doubleValue() : null;
        return ResponseEntity.ok(inventoryService.searchByLocation(lat, lon, radius));
    }

    @PutMapping("/{id}")
    public ResponseEntity<Device> update(@PathVariable String id, @RequestBody Device updates) {
        try {
            return ResponseEntity.ok(inventoryService.updateDevice(id, updates));
        } catch (InventoryService.ResourceNotFoundException e) {
            return ResponseEntity.notFound().build();
        }
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<Void> delete(@PathVariable String id) {
        inventoryService.deleteDevice(id);
        return ResponseEntity.noContent().build();
    }

    @PutMapping("/{id}/tags")
    public ResponseEntity<Device> updateTags(@PathVariable String id, @RequestBody List<DeviceTag> tags) {
        try {
            return ResponseEntity.ok(inventoryService.updateTags(id, tags));
        } catch (InventoryService.ResourceNotFoundException e) {
            return ResponseEntity.notFound().build();
        }
    }

    @GetMapping("/{serial}/birth-certificate")
    public ResponseEntity<BirthCertificate> getBirthCertificate(@PathVariable String serial) {
        return inventoryService.findBirthCertificate(serial)
                .map(ResponseEntity::ok)
                .orElse(ResponseEntity.notFound().build());
    }

    @PostMapping("/{serial}/birth-certificate")
    public ResponseEntity<?> createBirthCertificate(
            @PathVariable String serial,
            @RequestBody BirthCertificate bc) {
        bc.setSerialNumber(serial);
        try {
            return ResponseEntity.status(HttpStatus.CREATED).body(inventoryService.createBirthCertificate(bc));
        } catch (InventoryService.ConflictException e) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN)
                    .body(Map.of("error", Map.of("code", "IMMUTABLE", "message", e.getMessage())));
        }
    }

    /**
     * Upserts a generic SNMP-discovered device from a classification payload (WO-030).
     *
     * <p>POST /api/v1/inventory/devices/generic
     *
     * <p>Authority rules enforced by InventoryService:
     * <ul>
     *   <li>DEFERRED_UNSUPPORTED and CLASSIFICATION_ERROR payloads are not persisted as
     *       managed devices — a 422 is returned with the deferReason.</li>
     *   <li>UBR call-home identity fields are never overwritten.</li>
     * </ul>
     */
    @PostMapping("/generic")
    public ResponseEntity<?> createGenericDevice(@RequestBody Map<String, Object> payload) {
        try {
            InventoryService.GenericRegistrationResult result = inventoryService.upsertFromGenericDiscovery(payload);
            if (result.status() == InventoryService.GenericRegistrationStatus.REGISTERED) {
                return ResponseEntity.status(HttpStatus.CREATED)
                        .body(Map.of(
                            "registrationStatus", result.status().name(),
                            "deviceId", result.inventoryDeviceId() != null ? result.inventoryDeviceId() : ""
                        ));
            }
            // DEFERRED — return 422 Unprocessable Entity with operator-visible reason
            return ResponseEntity.status(HttpStatus.UNPROCESSABLE_ENTITY)
                    .body(Map.of(
                        "registrationStatus", result.status().name(),
                        "classificationStatus", result.classificationStatus(),
                        "deferReason", result.deferReason() != null ? result.deferReason() : ""
                    ));
        } catch (InventoryService.ValidationException e) {
            return ResponseEntity.badRequest()
                    .body(Map.of("error", Map.of("code", "VALIDATION_FAILED", "message", e.getMessage())));
        } catch (Exception e) {
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                    .body(Map.of("error", Map.of("code", "INTERNAL_ERROR", "message", "Registration failed")));
        }
    }

    @GetMapping("/export")
    public ResponseEntity<byte[]> export(
            @RequestParam(required = false, defaultValue = "csv") String format) throws Exception {
        if ("xls".equalsIgnoreCase(format)) {
            byte[] data = exportService.exportXls();
            return ResponseEntity.ok()
                    .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"devices.xlsx\"")
                    .contentType(MediaType.parseMediaType("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"))
                    .body(data);
        }
        byte[] data = exportService.exportCsv();
        return ResponseEntity.ok()
                .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"devices.csv\"")
                .contentType(MediaType.parseMediaType("text/csv"))
                .body(data);
    }
}
