// WO-060: Publish Versioned Northbound Kafka Streams
package com.ubr.nms.streams;

import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.stereotype.Service;
import java.time.Instant;

@Service
public class NorthboundEventPublisher {
    private final KafkaTemplate<String, String> kafkaTemplate;
    private static final String DEVICE_EVENTS_TOPIC = "device-events-v1";
    private static final String ALARM_EVENTS_TOPIC = "alarm-events-v1";
    private static final String KPI_EVENTS_TOPIC = "kpi-events-v1";

    public NorthboundEventPublisher(KafkaTemplate<String, String> kafkaTemplate) {
        this.kafkaTemplate = kafkaTemplate;
    }

    public void publishDeviceEvent(DeviceEvent event) {
        String payload = serializeEvent(event);
        kafkaTemplate.send(DEVICE_EVENTS_TOPIC, event.getDeviceId(), payload);
    }

    public void publishAlarmEvent(AlarmEvent event) {
        String payload = serializeEvent(event);
        kafkaTemplate.send(ALARM_EVENTS_TOPIC, event.getAlarmId(), payload);
    }

    public void publishKpiEvent(KpiEvent event) {
        String payload = serializeEvent(event);
        kafkaTemplate.send(KPI_EVENTS_TOPIC, event.getDeviceId(), payload);
    }

    private String serializeEvent(Object event) {
        // Serialize to Avro or JSON with schema version
        return "{}";
    }
}

class DeviceEvent {
    private String deviceId;
    private String eventType;
    private Instant timestamp;
    private String schemaVersion = "v1";
    public String getDeviceId() { return deviceId; }
}

class AlarmEvent {
    private String alarmId;
    private String eventType;
    private Instant timestamp;
    private String schemaVersion = "v1";
    public String getAlarmId() { return alarmId; }
}

class KpiEvent {
    private String deviceId;
    private String metricName;
    private double value;
    private Instant timestamp;
    private String schemaVersion = "v1";
    public String getDeviceId() { return deviceId; }
}
