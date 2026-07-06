package com.ubrnms.inventory.controller;

import com.ubrnms.inventory.model.hierarchy.*;
import com.ubrnms.inventory.repository.hierarchy.*;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.time.Instant;
import java.util.List;
import java.util.Map;

@RestController
@RequiredArgsConstructor
public class HierarchyController {

    private final OrganizationRepository orgRepo;
    private final HierarchyViewRepository hierarchyRepo;
    private final NetworkRepository networkRepo;
    private final PreAssignmentRepository preAssignRepo;

    // --- Organizations ---

    @PostMapping("/api/v1/organizations")
    public ResponseEntity<Organization> createOrg(@RequestBody Organization org) {
        return ResponseEntity.status(HttpStatus.CREATED).body(orgRepo.save(org));
    }

    @GetMapping("/api/v1/organizations")
    public List<Organization> listOrgs() { return orgRepo.findAll(); }

    @GetMapping("/api/v1/organizations/{id}")
    public ResponseEntity<Organization> getOrg(@PathVariable String id) {
        return orgRepo.findById(id).map(ResponseEntity::ok).orElse(ResponseEntity.notFound().build());
    }

    @PutMapping("/api/v1/organizations/{id}")
    public ResponseEntity<Organization> updateOrg(@PathVariable String id, @RequestBody Organization updates) {
        return orgRepo.findById(id).map(org -> {
            if (updates.getName() != null) org.setName(updates.getName());
            if (updates.getDescription() != null) org.setDescription(updates.getDescription());
            return ResponseEntity.ok(orgRepo.save(org));
        }).orElse(ResponseEntity.notFound().build());
    }

    @DeleteMapping("/api/v1/organizations/{id}")
    public ResponseEntity<Void> deleteOrg(@PathVariable String id) {
        orgRepo.deleteById(id);
        return ResponseEntity.noContent().build();
    }

    // --- Hierarchy views ---

    @PostMapping("/api/v1/organizations/{orgId}/hierarchies")
    public ResponseEntity<HierarchyView> createHierarchy(@PathVariable String orgId, @RequestBody HierarchyView h) {
        h.setOrganizationId(orgId);
        return ResponseEntity.status(HttpStatus.CREATED).body(hierarchyRepo.save(h));
    }

    @GetMapping("/api/v1/organizations/{orgId}/hierarchies")
    public List<HierarchyView> listHierarchies(@PathVariable String orgId) {
        return hierarchyRepo.findByOrganizationId(orgId);
    }

    @GetMapping("/api/v1/organizations/{orgId}/hierarchies/{hid}")
    public ResponseEntity<HierarchyView> getHierarchy(@PathVariable String orgId, @PathVariable String hid) {
        return hierarchyRepo.findById(hid).map(ResponseEntity::ok).orElse(ResponseEntity.notFound().build());
    }

    @DeleteMapping("/api/v1/organizations/{orgId}/hierarchies/{hid}")
    public ResponseEntity<Void> deleteHierarchy(@PathVariable String orgId, @PathVariable String hid) {
        hierarchyRepo.deleteById(hid);
        return ResponseEntity.noContent().build();
    }

    // --- Networks ---

    @PostMapping("/api/v1/organizations/{orgId}/hierarchies/{hid}/networks")
    public ResponseEntity<Network> createNetwork(@PathVariable String orgId, @PathVariable String hid, @RequestBody Network n) {
        n.setOrganizationId(orgId);
        n.setHierarchyId(hid);
        return ResponseEntity.status(HttpStatus.CREATED).body(networkRepo.save(n));
    }

    @GetMapping("/api/v1/organizations/{orgId}/hierarchies/{hid}/networks")
    public List<Network> listNetworks(@PathVariable String orgId, @PathVariable String hid) {
        return networkRepo.findByHierarchyId(hid);
    }

    @DeleteMapping("/api/v1/organizations/{orgId}/hierarchies/{hid}/networks/{nid}")
    public ResponseEntity<Void> deleteNetwork(@PathVariable String nid) {
        networkRepo.deleteById(nid);
        return ResponseEntity.noContent().build();
    }

    // --- Pre-assignment ---

    @PostMapping("/api/v1/networks/{networkId}/devices/pre-assign")
    public ResponseEntity<?> preAssign(@PathVariable String networkId, @RequestBody Map<String, String> body) {
        String serial = body.get("serialNumber");
        String deviceType = body.get("deviceType");
        if (serial == null || deviceType == null) {
            return ResponseEntity.badRequest().body(Map.of("error", "serialNumber and deviceType required"));
        }
        if (preAssignRepo.findBySerialNumber(serial).isPresent()) {
            return ResponseEntity.status(HttpStatus.CONFLICT)
                    .body(Map.of("error", "Device already pre-assigned"));
        }
        Network network = networkRepo.findById(networkId).orElse(null);
        DevicePreAssignment pa = new DevicePreAssignment();
        pa.setSerialNumber(serial);
        pa.setDeviceType(deviceType);
        pa.setNetworkId(networkId);
        if (network != null) {
            pa.setOrganizationId(network.getOrganizationId());
            pa.setHierarchyId(network.getHierarchyId());
        }
        pa.setPreAssignedAt(Instant.now());
        return ResponseEntity.status(HttpStatus.CREATED).body(preAssignRepo.save(pa));
    }

    @GetMapping("/api/v1/networks/{networkId}/devices/pre-assign")
    public List<DevicePreAssignment> listPreAssignments(@PathVariable String networkId) {
        return preAssignRepo.findAll().stream()
                .filter(pa -> networkId.equals(pa.getNetworkId()))
                .toList();
    }
}
