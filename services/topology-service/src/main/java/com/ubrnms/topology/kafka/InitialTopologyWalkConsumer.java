package com.ubrnms.topology.kafka;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.ubrnms.topology.service.TopologyService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Kafka consumer for topology.initial.walk.trigger events (WO-031).
 *
 * <p>Listens for {@code InitialTopologyWalkTriggerEvent} messages published by
 * the discovery-service post-registration orchestrator after a new generic device
 * is registered in inventory. Schedules an immediate LLDP/CDP neighbour walk
 * for the device.
 *
 * <p>Idempotency: idempotencyKeys are tracked in a bounded in-memory set to
 * suppress duplicate walk requests from repeated rediscovery runs. Real
 * production deployments should use Redis SETNX with TTL.
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class InitialTopologyWalkConsumer {

    private final TopologyService topologyService;
    private final ObjectMapper objectMapper;

    /** Best-effort in-memory idempotency guard (WO-031). Bounded to prevent memory growth. */
    private final Set<String> seenIdempotencyKeys = ConcurrentHashMap.newKeySet();

    private static final int SEEN_KEY_MAX_SIZE = 10_000;

    @KafkaListener(
        topics = "${kafka.topics.topology-initial-walk-trigger:topology.initial.walk.trigger}",
        groupId = "topology-service-initial-walk"
    )
    public void consume(String message) {
        Map<String, Object> event;
        try {
            event = objectMapper.readValue(message, new TypeReference<>() {});
        } catch (Exception e) {
            log.error("WO-031: malformed initial-topology-walk trigger — skipping", e);
            return;
        }

        String idempotencyKey = (String) event.getOrDefault("idempotencyKey", "");
        String deviceId = (String) event.getOrDefault("inventoryDeviceId", "");
        String correlationId = (String) event.getOrDefault("correlationId", "n/a");

        // Idempotency check — suppress duplicate walk for same rediscovery run.
        if (!idempotencyKey.isBlank() && !seenIdempotencyKeys.add(idempotencyKey)) {
            log.debug("WO-031: duplicate topology walk trigger suppressed — deviceId={}, idempotencyKey={}",
                deviceId, idempotencyKey);
            return;
        }

        // Evict oldest entries when the map exceeds maximum size.
        if (seenIdempotencyKeys.size() > SEEN_KEY_MAX_SIZE) {
            seenIdempotencyKeys.stream()
                .limit(SEEN_KEY_MAX_SIZE / 2)
                .forEach(seenIdempotencyKeys::remove);
        }

        @SuppressWarnings("unchecked")
        List<String> supportedProtocols = (List<String>) event.getOrDefault("supportedProtocols", List.of());
        if (supportedProtocols.isEmpty()) {
            log.info("WO-031: topology walk skipped — no supported protocols — deviceId={}, correlationId={}",
                deviceId, correlationId);
            return;
        }

        try {
            topologyService.scheduleInitialWalk(deviceId, supportedProtocols, correlationId);
            log.info("WO-031: initial topology walk scheduled — deviceId={}, protocols={}, correlationId={}",
                deviceId, supportedProtocols, correlationId);
        } catch (Exception e) {
            // Walk scheduling failures must not propagate back to Kafka as unhandled exceptions,
            // as that would cause unnecessary consumer rebalancing. Log and continue.
            log.error("WO-031: initial topology walk scheduling failed — deviceId={}, correlationId={}",
                deviceId, correlationId, e);
        }
    }
}
