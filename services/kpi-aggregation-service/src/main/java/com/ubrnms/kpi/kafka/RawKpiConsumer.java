package com.ubrnms.kpi.kafka;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.ubrnms.kpi.model.RawKpiEvent;
import com.ubrnms.kpi.service.KpiAggregationService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.apache.kafka.clients.consumer.ConsumerRecord;
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.kafka.support.Acknowledgment;
import org.springframework.stereotype.Component;

@Slf4j
@Component
@RequiredArgsConstructor
public class RawKpiConsumer {

    private final KpiAggregationService aggregationService;
    private final ObjectMapper objectMapper;

    @KafkaListener(
            topics = "${kafka.topics.raw-kpi}",
            groupId = "kpi-aggregation-service",
            concurrency = "4"
    )
    public void consume(ConsumerRecord<String, String> record, Acknowledgment ack) {
        try {
            RawKpiEvent event = objectMapper.readValue(record.value(), RawKpiEvent.class);
            aggregationService.aggregate(event);
            ack.acknowledge();
        } catch (Exception e) {
            log.error("Failed to process raw KPI record offset={}", record.offset(), e);
            ack.acknowledge(); // avoid blocking on poison pill — real impl: DLQ
        }
    }
}
