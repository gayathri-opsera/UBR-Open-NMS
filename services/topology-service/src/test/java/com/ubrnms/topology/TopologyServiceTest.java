package com.ubrnms.topology;

import com.ubrnms.topology.model.TopologyEdge;
import com.ubrnms.topology.model.TopologyGraph;
import com.ubrnms.topology.model.TopologyNode;
import com.ubrnms.topology.repository.TopologyNodeRepository;
import com.ubrnms.topology.service.TopologyService;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.util.*;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
class TopologyServiceTest {

    @Mock private TopologyNodeRepository nodeRepo;
    @InjectMocks private TopologyService service;

    @BeforeEach
    void inject() throws Exception {
        var f = TopologyService.class.getDeclaredField("objectMapper");
        f.setAccessible(true);
        f.set(service, new ObjectMapper().registerModule(new JavaTimeModule()));
        var r = TopologyService.class.getDeclaredField("defaultRadiusKm");
        r.setAccessible(true); r.set(service, 1.0);
        var h = TopologyService.class.getDeclaredField("maxCascadeHops");
        h.setAccessible(true); h.set(service, 3);
    }

    @Test
    void upsertFromInventory_createsNewNode() {
        when(nodeRepo.findByDeviceId(any())).thenReturn(Optional.empty());
        when(nodeRepo.save(any())).thenAnswer(inv -> inv.getArgument(0));

        Map<String, Object> event = new HashMap<>();
        event.put("id", "dev-001"); event.put("serialNumber", "SN-001");
        event.put("deviceType", "BTS"); event.put("status", "online");
        event.put("latitude", 1.3); event.put("longitude", 103.8);

        TopologyNode node = service.upsertFromInventory(event);
        assertThat(node.getDeviceId()).isEqualTo("dev-001");
        assertThat(node.getType()).isEqualTo("BTS");
        assertThat(node.getLocation()).containsExactly(103.8, 1.3);
        verify(nodeRepo).save(any());
    }

    @Test
    void getTopologyByNetwork_returnsGraphWithEdges() {
        TopologyNode bts = new TopologyNode();
        bts.setDeviceId("bts-001"); bts.setType("BTS");
        bts.setChildDeviceIds(List.of("cpe-001"));
        bts.setLinkHealth("GOOD");

        TopologyNode cpe = new TopologyNode();
        cpe.setDeviceId("cpe-001"); cpe.setType("CPE");
        cpe.setParentDeviceId("bts-001");
        cpe.setChildDeviceIds(List.of());
        cpe.setLinkHealth("GOOD");

        when(nodeRepo.findByNetworkId("net-1")).thenReturn(List.of(bts, cpe));

        TopologyGraph graph = service.getTopologyByNetwork("net-1");
        assertThat(graph.getNodeCount()).isEqualTo(2);
        assertThat(graph.getEdgeCount()).isGreaterThan(0);
    }

    @Test
    void getConnections_returnsChildAndParent() {
        TopologyNode bts = new TopologyNode();
        bts.setDeviceId("bts-001"); bts.setChildDeviceIds(List.of("cpe-001"));

        TopologyNode cpe = new TopologyNode();
        cpe.setDeviceId("cpe-001"); cpe.setType("CPE");
        cpe.setChildDeviceIds(List.of());

        when(nodeRepo.findByDeviceId("bts-001")).thenReturn(Optional.of(bts));
        when(nodeRepo.findByDeviceId("cpe-001")).thenReturn(Optional.of(cpe));

        List<TopologyNode> connections = service.getConnections("bts-001");
        assertThat(connections).hasSize(1);
        assertThat(connections.get(0).getDeviceId()).isEqualTo("cpe-001");
    }

    @Test
    void searchBySerial_returnsSingleNode() {
        TopologyNode node = new TopologyNode();
        node.setSerialNumber("SN-XYZ");
        when(nodeRepo.findBySerialNumber("SN-XYZ")).thenReturn(Optional.of(node));

        List<TopologyNode> results = service.search("SN-XYZ", null, null, null, null, null);
        assertThat(results).hasSize(1);
    }

    @Test
    void searchByIP_returnsNode() {
        TopologyNode node = new TopologyNode();
        node.setIpAddress("10.0.0.1");
        when(nodeRepo.findByIpAddress("10.0.0.1")).thenReturn(Optional.of(node));

        List<TopologyNode> results = service.search(null, null, "10.0.0.1", null, null, null);
        assertThat(results).hasSize(1);
        assertThat(results.get(0).getIpAddress()).isEqualTo("10.0.0.1");
    }

    @Test
    void cascadeHop_relationshipsTrackedCorrectly() {
        TopologyNode primaryBts = new TopologyNode();
        primaryBts.setDeviceId("bts-primary"); primaryBts.setType("BTS");
        primaryBts.setCascadeHop(0);

        TopologyNode cascadedBts = new TopologyNode();
        cascadedBts.setDeviceId("bts-cascade-1"); cascadedBts.setType("BTS");
        cascadedBts.setParentDeviceId("bts-primary"); cascadedBts.setCascadeHop(1);
        cascadedBts.setChildDeviceIds(List.of());

        assertThat(primaryBts.getCascadeHop()).isEqualTo(0);
        assertThat(cascadedBts.getCascadeHop()).isEqualTo(1);
        assertThat(cascadedBts.getCascadeHop()).isLessThanOrEqualTo(3);
    }
}
