package com.ubrnms.inventory.service;

import com.ubrnms.inventory.model.hierarchy.DevicePreAssignment;
import com.ubrnms.inventory.model.hierarchy.HierarchyView;
import com.ubrnms.inventory.model.hierarchy.Network;
import com.ubrnms.inventory.model.hierarchy.Organization;
import com.ubrnms.inventory.repository.hierarchy.HierarchyViewRepository;
import com.ubrnms.inventory.repository.hierarchy.NetworkRepository;
import com.ubrnms.inventory.repository.hierarchy.OrganizationRepository;
import com.ubrnms.inventory.repository.hierarchy.PreAssignmentRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.List;
import java.util.Optional;

/**
 * Service layer for hierarchy CRUD operations (WO-012).
 *
 * <p>Extracts all business logic and data access out of {@code HierarchyController},
 * eliminating the critical architectural violation where a controller directly injected
 * four repositories and performed data access without a service intermediary.
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class HierarchyService {

    private final OrganizationRepository    orgRepo;
    private final HierarchyViewRepository   hierarchyRepo;
    private final NetworkRepository         networkRepo;
    private final PreAssignmentRepository   preAssignRepo;

    // ── Organizations ────────────────────────────────────────────────────────

    public Organization createOrganization(Organization org) {
        Organization saved = orgRepo.save(org);
        log.info("hierarchy: organization created id={}", saved.getId());
        return saved;
    }

    public List<Organization> listOrganizations() {
        return orgRepo.findAll();
    }

    public Optional<Organization> findOrganizationById(String id) {
        return orgRepo.findById(id);
    }

    public Optional<Organization> updateOrganization(String id, Organization updates) {
        return orgRepo.findById(id).map(org -> {
            if (updates.getName()        != null) org.setName(updates.getName());
            if (updates.getDescription() != null) org.setDescription(updates.getDescription());
            return orgRepo.save(org);
        });
    }

    public void deleteOrganization(String id) {
        orgRepo.deleteById(id);
        log.info("hierarchy: organization deleted id={}", id);
    }

    // ── Hierarchy Views ───────────────────────────────────────────────────────

    public HierarchyView createHierarchy(String orgId, HierarchyView h) {
        h.setOrganizationId(orgId);
        HierarchyView saved = hierarchyRepo.save(h);
        log.info("hierarchy: hierarchy view created id={} orgId={}", saved.getId(), orgId);
        return saved;
    }

    public List<HierarchyView> listHierarchies(String orgId) {
        return hierarchyRepo.findByOrganizationId(orgId);
    }

    public Optional<HierarchyView> findHierarchyById(String hid) {
        return hierarchyRepo.findById(hid);
    }

    public void deleteHierarchy(String hid) {
        hierarchyRepo.deleteById(hid);
        log.info("hierarchy: hierarchy view deleted id={}", hid);
    }

    // ── Networks ──────────────────────────────────────────────────────────────

    public Network createNetwork(String orgId, String hid, Network n) {
        n.setOrganizationId(orgId);
        n.setHierarchyId(hid);
        Network saved = networkRepo.save(n);
        log.info("hierarchy: network created id={} hid={}", saved.getId(), hid);
        return saved;
    }

    public List<Network> listNetworks(String hid) {
        return networkRepo.findByHierarchyId(hid);
    }

    public void deleteNetwork(String nid) {
        networkRepo.deleteById(nid);
        log.info("hierarchy: network deleted id={}", nid);
    }

    // ── Pre-Assignments ───────────────────────────────────────────────────────

    /**
     * Pre-assigns a device serial to a network slot.
     *
     * @throws DuplicatePreAssignmentException if the serial is already pre-assigned
     * @throws IllegalArgumentException        if serial or deviceType is null/blank
     */
    public DevicePreAssignment preAssignDevice(String networkId, String serial, String deviceType) {
        if (serial == null || serial.isBlank()) {
            throw new IllegalArgumentException("serialNumber is required");
        }
        if (deviceType == null || deviceType.isBlank()) {
            throw new IllegalArgumentException("deviceType is required");
        }
        if (preAssignRepo.findBySerialNumber(serial).isPresent()) {
            throw new DuplicatePreAssignmentException("Device already pre-assigned: " + serial);
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
        DevicePreAssignment saved = preAssignRepo.save(pa);
        log.info("hierarchy: device pre-assigned serial={} networkId={}", serial, networkId);
        return saved;
    }

    public List<DevicePreAssignment> listPreAssignments(String networkId) {
        return preAssignRepo.findAll().stream()
                .filter(pa -> networkId.equals(pa.getNetworkId()))
                .toList();
    }

    /** Thrown when a pre-assignment already exists for the given serial number. */
    public static class DuplicatePreAssignmentException extends RuntimeException {
        public DuplicatePreAssignmentException(String message) { super(message); }
    }
}
