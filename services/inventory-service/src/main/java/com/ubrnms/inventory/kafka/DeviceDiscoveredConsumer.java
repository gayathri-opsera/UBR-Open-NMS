package com.ubrnms.inventory.kafka;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.ubrnms.inventory.service.InventoryService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.stereotype.Component;

import java.util.Map;

@Slf4j
@Component
@RequiredArgsConstructor
public class DeviceDiscoveredConsumer {

    private final InventoryService inventoryService;
    private final ObjectMapper objectMapper;

    @KafkaListener(topics = "${kafka.topics.device-discovered}", groupId = "inventory-service")
    public void consume(String message) {
        try {
            Map<String, Object> event = objectMapper.readValue(message, new TypeReference<>() {});
            inventoryService.upsertFromDiscovery(event);
            log.info("Device upserted from discovery event: {}", event.get("serialNumber"));
        } catch (Exception e) {
            log.error("Failed to process device-discovered event", e);
        }
    }
}
