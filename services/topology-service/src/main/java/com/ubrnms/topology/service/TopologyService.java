package com.ubrnms.topology.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.ubrnms.topology.model.TopologyEdge;
import com.ubrnms.topology.model.TopologyGraph;
import com.ubrnms.topology.model.TopologyNode;
import com.ubrnms.topology.repository.TopologyNodeRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.*;
import java.util.stream.Collectors;

@Slf4j
@Service
@RequiredArgsConstructor
public class TopologyService {

    private final TopologyNodeRepository nodeRepo;
    private final ObjectMapper objectMapper;

    @Value("${topology.search.default-radius-km:1.0}")
    private double defaultRadiusKm;

    @Value("${topology.max-cascade-hops:3}")
    private int maxCascadeHops;

    /**
     * Upsert a topology node from an inventory-sync event.
     */
    @SuppressWarnings("unchecked")
    public TopologyNode upsertFromInventory(Map<String, Object> event) {
        String deviceId = (String) event.getOrDefault("id", (String) event.get("serialNumber"));
        if (deviceId == null) return null;

        TopologyNode node = nodeRepo.findByDeviceId(deviceId).orElse(new TopologyNode());
        node.setDeviceId(deviceId);
        node.setSerialNumber((String) event.get("serialNumber"));
        node.setMacAddress((String) event.get("macAddress"));
        node.setIpAddress((String) event.get("ipAddress"));
        node.setType((String) event.getOrDefault("deviceType", "UNKNOWN"));
        node.setStatus((String) event.getOrDefault("status", "online"));

        Number lat = (Number) event.get("latitude");
        Number lon = (Number) event.get("longitude");
        if (lat != null && lon != null) {
            node.setLatitude(lat.doubleValue());
            node.setLongitude(lon.doubleValue());
            node.setLocation(new double[]{lon.doubleValue(), lat.doubleValue()});
        }

        String connectedBts = (String) event.get("connectedBtsSerial");
        if (connectedBts != null) {
            node.setParentDeviceId(connectedBts);
            // Update parent's child list
            nodeRepo.findByDeviceId(connectedBts).ifPresent(parent -> {
                if (!parent.getChildDeviceIds().contains(deviceId)) {
                    parent.getChildDeviceIds().add(deviceId);
                    nodeRepo.save(parent);
                }
            });
        }

        node.setNetworkId((String) event.get("networkId"));
        node.setOrganizationId((String) event.get("organizationId"));
        node.setLinkHealth("GOOD");
        node.setUpdatedAt(Instant.now());

        return nodeRepo.save(node);
    }

    /**
     * Get full topology graph for a network scope.
     */
    public TopologyGraph getTopologyByNetwork(String networkId) {
        List<TopologyNode> nodes = networkId != null
                ? nodeRepo.findByNetworkId(networkId)
                : nodeRepo.findAll();

        List<TopologyEdge> edges = buildEdges(nodes);
        TopologyGraph graph = new TopologyGraph();
        graph.setNodes(nodes);
        graph.setEdges(edges);
        graph.setNodeCount(nodes.size());
        graph.setEdgeCount(edges.size());
        return graph;
    }

    /**
     * Get all devices directly connected to a given device.
     */
    public List<TopologyNode> getConnections(String deviceId) {
        List<TopologyNode> result = new ArrayList<>();
        nodeRepo.findByDeviceId(deviceId).ifPresent(node -> {
            // Children (CPEs or cascaded BTSs)
            node.getChildDeviceIds().forEach(childId ->
                    nodeRepo.findByDeviceId(childId).ifPresent(result::add));
            // Parent (BTS for CPE)
            if (node.getParentDeviceId() != null) {
                nodeRepo.findByDeviceId(node.getParentDeviceId()).ifPresent(result::add);
            }
        });
        return result;
    }

    /**
     * Search by IP, MAC, serial or GPS location.
     */
    public List<TopologyNode> search(String serial, String mac, String ip, Double lat, Double lon, Double radiusKm) {
        if (serial != null) return nodeRepo.findBySerialNumber(serial).map(List::of).orElse(List.of());
        if (mac != null)    return nodeRepo.findByMacAddress(mac).map(List::of).orElse(List.of());
        if (ip != null)     return nodeRepo.findByIpAddress(ip).map(List::of).orElse(List.of());
        if (lat != null && lon != null) {
            double radius = (radiusKm != null ? radiusKm : defaultRadiusKm) * 1000;
            return nodeRepo.findNearLocation(lon, lat, radius);
        }
        return List.of();
    }

    private List<TopologyEdge> buildEdges(List<TopologyNode> nodes) {
        Set<String> nodeIds = nodes.stream().map(TopologyNode::getDeviceId).collect(Collectors.toSet());
        List<TopologyEdge> edges = new ArrayList<>();
        for (TopologyNode node : nodes) {
            if (node.getParentDeviceId() != null && nodeIds.contains(node.getParentDeviceId())) {
                String linkType = "BTS".equals(node.getType()) ? "BTS_CASCADE" : "BTS_TO_CPE";
                edges.add(new TopologyEdge(node.getParentDeviceId(), node.getDeviceId(), linkType, node.getLinkHealth()));
            }
            for (String childId : node.getChildDeviceIds()) {
                if (nodeIds.contains(childId)) {
                    edges.add(new TopologyEdge(node.getDeviceId(), childId, "BTS_TO_CPE", node.getLinkHealth()));
                }
            }
        }
        // Deduplicate edges
        return edges.stream().distinct().collect(Collectors.toList());
    }
}
