package com.ubrnms.inventory.controller;

import com.ubrnms.inventory.model.hierarchy.DevicePreAssignment;
import com.ubrnms.inventory.model.hierarchy.HierarchyView;
import com.ubrnms.inventory.model.hierarchy.Network;
import com.ubrnms.inventory.model.hierarchy.Organization;
import com.ubrnms.inventory.service.HierarchyService;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

/**
 * REST controller for hierarchy management (organisations, networks, pre-assignments).
 *
 * <p>Refactored as part of WO-012 to eliminate the top critical architectural violation:
 * this controller previously injected four repositories directly. All data access is now
 * delegated to {@link HierarchyService}, restoring the correct three-tier boundary.
 */
@RestController
@RequiredArgsConstructor
public class HierarchyController {

    private final HierarchyService hierarchyService;

    // ── Organizations ────────────────────────────────────────────────────────

    @PostMapping("/api/v1/organizations")
    public ResponseEntity<Organization> createOrg(@RequestBody Organization org) {
        return ResponseEntity.status(HttpStatus.CREATED)
                .body(hierarchyService.createOrganization(org));
    }

    @GetMapping("/api/v1/organizations")
    public List<Organization> listOrgs() {
        return hierarchyService.listOrganizations();
    }

    @GetMapping("/api/v1/organizations/{id}")
    public ResponseEntity<Organization> getOrg(@PathVariable String id) {
        return hierarchyService.findOrganizationById(id)
                .map(ResponseEntity::ok)
                .orElse(ResponseEntity.notFound().build());
    }

    @PutMapping("/api/v1/organizations/{id}")
    public ResponseEntity<Organization> updateOrg(@PathVariable String id,
                                                   @RequestBody Organization updates) {
        return hierarchyService.updateOrganization(id, updates)
                .map(ResponseEntity::ok)
                .orElse(ResponseEntity.notFound().build());
    }

    @DeleteMapping("/api/v1/organizations/{id}")
    public ResponseEntity<Void> deleteOrg(@PathVariable String id) {
        hierarchyService.deleteOrganization(id);
        return ResponseEntity.noContent().build();
    }

    // ── Hierarchy Views ───────────────────────────────────────────────────────

    @PostMapping("/api/v1/organizations/{orgId}/hierarchies")
    public ResponseEntity<HierarchyView> createHierarchy(@PathVariable String orgId,
                                                          @RequestBody HierarchyView h) {
        return ResponseEntity.status(HttpStatus.CREATED)
                .body(hierarchyService.createHierarchy(orgId, h));
    }

    @GetMapping("/api/v1/organizations/{orgId}/hierarchies")
    public List<HierarchyView> listHierarchies(@PathVariable String orgId) {
        return hierarchyService.listHierarchies(orgId);
    }

    @GetMapping("/api/v1/organizations/{orgId}/hierarchies/{hid}")
    public ResponseEntity<HierarchyView> getHierarchy(@PathVariable String orgId,
                                                        @PathVariable String hid) {
        return hierarchyService.findHierarchyById(hid)
                .map(ResponseEntity::ok)
                .orElse(ResponseEntity.notFound().build());
    }

    @DeleteMapping("/api/v1/organizations/{orgId}/hierarchies/{hid}")
    public ResponseEntity<Void> deleteHierarchy(@PathVariable String orgId,
                                                 @PathVariable String hid) {
        hierarchyService.deleteHierarchy(hid);
        return ResponseEntity.noContent().build();
    }

    // ── Networks ──────────────────────────────────────────────────────────────

    @PostMapping("/api/v1/organizations/{orgId}/hierarchies/{hid}/networks")
    public ResponseEntity<Network> createNetwork(@PathVariable String orgId,
                                                  @PathVariable String hid,
                                                  @RequestBody Network n) {
        return ResponseEntity.status(HttpStatus.CREATED)
                .body(hierarchyService.createNetwork(orgId, hid, n));
    }

    @GetMapping("/api/v1/organizations/{orgId}/hierarchies/{hid}/networks")
    public List<Network> listNetworks(@PathVariable String orgId, @PathVariable String hid) {
        return hierarchyService.listNetworks(hid);
    }

    @DeleteMapping("/api/v1/organizations/{orgId}/hierarchies/{hid}/networks/{nid}")
    public ResponseEntity<Void> deleteNetwork(@PathVariable String nid) {
        hierarchyService.deleteNetwork(nid);
        return ResponseEntity.noContent().build();
    }

    // ── Pre-Assignments ───────────────────────────────────────────────────────

    @PostMapping("/api/v1/networks/{networkId}/devices/pre-assign")
    public ResponseEntity<?> preAssign(@PathVariable String networkId,
                                        @RequestBody Map<String, String> body) {
        String serial     = body.get("serialNumber");
        String deviceType = body.get("deviceType");
        try {
            DevicePreAssignment pa = hierarchyService.preAssignDevice(networkId, serial, deviceType);
            return ResponseEntity.status(HttpStatus.CREATED).body(pa);
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest().body(Map.of("error", e.getMessage()));
        } catch (HierarchyService.DuplicatePreAssignmentException e) {
            return ResponseEntity.status(HttpStatus.CONFLICT).body(Map.of("error", e.getMessage()));
        }
    }

    @GetMapping("/api/v1/networks/{networkId}/devices/pre-assign")
    public List<DevicePreAssignment> listPreAssignments(@PathVariable String networkId) {
        return hierarchyService.listPreAssignments(networkId);
    }
}
