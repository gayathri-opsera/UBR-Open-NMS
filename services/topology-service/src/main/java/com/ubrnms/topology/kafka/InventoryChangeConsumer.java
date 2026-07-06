package com.ubrnms.topology.kafka;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.ubrnms.topology.service.TopologyService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.stereotype.Component;

import java.util.Map;

@Slf4j
@Component
@RequiredArgsConstructor
public class InventoryChangeConsumer {

    private final TopologyService topologyService;
    private final ObjectMapper objectMapper;

    @KafkaListener(topics = "${kafka.topics.device-inventory-changes}", groupId = "topology-service")
    public void consume(String message) {
        try {
            Map<String, Object> event = objectMapper.readValue(message, new TypeReference<>() {});
            topologyService.upsertFromInventory(event);
            log.info("Topology updated from inventory event: {}", event.get("serialNumber"));
        } catch (Exception e) {
            log.error("Failed to process inventory change event", e);
        }
    }
}
