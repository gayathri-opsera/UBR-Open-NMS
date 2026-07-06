package com.ubrnms.alarm.kafka;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.ubrnms.alarm.service.AlarmService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.apache.kafka.clients.consumer.ConsumerRecord;
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.kafka.support.Acknowledgment;
import org.springframework.stereotype.Component;

import java.util.Map;

@Slf4j
@Component
@RequiredArgsConstructor
public class RawAlarmConsumer {

    private final AlarmService alarmService;
    private final ObjectMapper objectMapper;

    @KafkaListener(
            topics = "${kafka.topics.raw-alarms}",
            groupId = "alarm-service",
            concurrency = "4"
    )
    public void consume(ConsumerRecord<String, String> record, Acknowledgment ack) {
        try {
            Map<String, Object> event = objectMapper.readValue(record.value(), new TypeReference<>() {});
            alarmService.processRawAlarm(event);
            ack.acknowledge();
        } catch (Exception e) {
            log.error("Failed to process raw alarm offset={}", record.offset(), e);
            // Still acknowledge to avoid poison-pill blocking; real deployments should use DLQ
            ack.acknowledge();
        }
    }
}
