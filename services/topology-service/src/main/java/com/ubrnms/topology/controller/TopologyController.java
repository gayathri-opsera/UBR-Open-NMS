package com.ubrnms.topology.controller;

import com.ubrnms.topology.model.TopologyGraph;
import com.ubrnms.topology.model.TopologyNode;
import com.ubrnms.topology.service.TopologyService;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;

@RestController
@RequestMapping("/api/v1/topology")
@RequiredArgsConstructor
public class TopologyController {

    private final TopologyService topologyService;

    @GetMapping
    public ResponseEntity<TopologyGraph> getTopology(
            @RequestParam(required = false) String networkId) {
        return ResponseEntity.ok(topologyService.getTopologyByNetwork(networkId));
    }

    @GetMapping("/search")
    public ResponseEntity<List<TopologyNode>> search(
            @RequestParam(required = false) String serial,
            @RequestParam(required = false) String mac,
            @RequestParam(required = false) String ip,
            @RequestParam(required = false) Double lat,
            @RequestParam(required = false) Double lon,
            @RequestParam(required = false) Double radiusKm) {
        return ResponseEntity.ok(topologyService.search(serial, mac, ip, lat, lon, radiusKm));
    }

    @GetMapping("/device/{id}/connections")
    public ResponseEntity<List<TopologyNode>> getConnections(@PathVariable String id) {
        return ResponseEntity.ok(topologyService.getConnections(id));
    }

    @GetMapping("/device/{id}")
    public ResponseEntity<TopologyNode> getNode(@PathVariable String id) {
        return topologyService.search(null, null, null, null, null, null).stream()
                .filter(n -> id.equals(n.getDeviceId()))
                .findFirst()
                .map(ResponseEntity::ok)
                .orElse(ResponseEntity.notFound().build());
    }
}
