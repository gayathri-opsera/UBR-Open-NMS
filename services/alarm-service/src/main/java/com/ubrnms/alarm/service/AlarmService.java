package com.ubrnms.alarm.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.ubrnms.alarm.model.Alarm;
import com.ubrnms.alarm.model.AlarmThreshold;
import com.ubrnms.alarm.repository.AlarmRepository;
import com.ubrnms.alarm.repository.AlarmThresholdRepository;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.*;
import java.util.stream.Collectors;

@Slf4j
@Service
@RequiredArgsConstructor
public class AlarmService {

    private final AlarmRepository alarmRepo;
    private final AlarmThresholdRepository thresholdRepo;
    private final KafkaTemplate<String, String> kafkaTemplate;
    private final ObjectMapper objectMapper;
    private final MeterRegistry meterRegistry;

    @Value("${alarm.dedup.window-minutes:5}")
    private int dedupWindowMinutes;

    @Value("${kafka.topics.processed-alarms:processed-alarms}")
    private String processedAlarmsTopic;

    @Value("${kafka.topics.netcool-alarms-forward:netcool-alarms-forward}")
    private String netcoolTopic;

    /**
     * Main pipeline: dedup → correlate → persist → publish.
     * Returns null if the event was deduplicated.
     */
    public Alarm processRawAlarm(Map<String, Object> raw) {
        Timer.Sample sample = Timer.start(meterRegistry);
        try {
            Alarm alarm = mapRawToAlarm(raw);

            // Handle CLEAR events: find and clear active alarm with same alarmId
            if ("CLEAR".equalsIgnoreCase((String) raw.get("state"))) {
                return handleClear(alarm);
            }

            // Deduplication
            Instant windowStart = Instant.now().minus(dedupWindowMinutes, ChronoUnit.MINUTES);
            Optional<Alarm> existing = alarmRepo
                    .findTopByDeviceIdAndAlarmTypeAndStateAndDedupWindowStartAfterOrderByRaisedAtDesc(
                            alarm.getDeviceId(), alarm.getAlarmType(), "ACTIVE", windowStart);

            if (existing.isPresent()) {
                Alarm dup = existing.get();
                dup.setDedupCount(dup.getDedupCount() + 1);
                log.debug("Deduplicated alarm for device={} type={}", alarm.getDeviceId(), alarm.getAlarmType());
                return alarmRepo.save(dup);
            }

            // Correlation: check if parent is also alarming
            alarm = correlate(alarm);

            // Persist
            alarm.setTtlExpiry(Instant.now().plus(7, ChronoUnit.DAYS));
            alarm = alarmRepo.save(alarm);

            // Publish to processed-alarms
            publish(processedAlarmsTopic, alarm.getAlarmType(), alarm);

            // Publish Netcool format
            publishNetcool(alarm);

            return alarm;
        } finally {
            sample.stop(meterRegistry.timer("alarm.processing.latency"));
        }
    }

    /**
     * Evaluate threshold rules against a metric value.
     */
    public Optional<Alarm> evaluateThreshold(String deviceId, String deviceType,
                                              String parameter, double value) {
        List<AlarmThreshold> rules = new ArrayList<>();
        rules.addAll(thresholdRepo.findByDeviceIdAndEnabledTrue(deviceId));
        rules.addAll(thresholdRepo.findByDeviceTypeAndDeviceIdIsNullAndEnabledTrue(deviceType));

        for (AlarmThreshold rule : rules) {
            if (!rule.getParameter().equalsIgnoreCase(parameter)) continue;

            if (value >= rule.getRaiseThreshold()) {
                Alarm alarm = new Alarm();
                alarm.setAlarmId(UUID.randomUUID().toString());
                alarm.setDeviceId(deviceId);
                alarm.setDeviceType(deviceType);
                alarm.setAlarmType(rule.getAlarmType());
                alarm.setAlarmName(parameter + " threshold breached");
                alarm.setSeverity(rule.getSeverity());
                alarm.setState("ACTIVE");
                alarm.setMetricValue(value);
                alarm.setThreshold(rule.getRaiseThreshold());
                alarm.setSource("THRESHOLD");
                alarm.setRaisedAt(Instant.now());
                alarm.setDedupWindowStart(Instant.now());
                alarm.setDescription(String.format("%s=%.2f exceeded threshold=%.2f",
                        parameter, value, rule.getRaiseThreshold()));
                return Optional.of(processRawAlarm(objectMapper.convertValue(alarm, Map.class)));
            }
        }
        return Optional.empty();
    }

    public Alarm acknowledge(String id, String actor) {
        return alarmRepo.findById(id).map(alarm -> {
            alarm.setState("ACKNOWLEDGED");
            alarm.setAcknowledgedBy(actor);
            alarm.setAcknowledgedAt(Instant.now());
            return alarmRepo.save(alarm);
        }).orElseThrow(() -> new NoSuchElementException("Alarm not found: " + id));
    }

    public List<Alarm> queryAlarms(String severity, String deviceId, String networkId,
                                    Instant from, Instant to) {
        if (from != null && to != null) return alarmRepo.findByTimeRange(from, to);
        if (deviceId != null) return alarmRepo.findByDeviceIdAndStateOrderByRaisedAtDesc(deviceId, "ACTIVE");
        if (networkId != null) return alarmRepo.findByNetworkIdOrderByRaisedAtDesc(networkId);
        if (severity != null) return alarmRepo.findBySeverityAndStateOrderByRaisedAtDesc(severity, "ACTIVE");
        return alarmRepo.findByStateOrderByRaisedAtDesc("ACTIVE");
    }

    public Map<String, Long> getAlarmTypeCounts(Instant from, Instant to) {
        return alarmRepo.findByRaisedAtBetween(from, to).stream()
                .collect(Collectors.groupingBy(Alarm::getAlarmType, Collectors.counting()));
    }

    public List<Map.Entry<String, Long>> getTopReported(Instant from, Instant to, int limit) {
        return alarmRepo.findByRaisedAtBetween(from, to).stream()
                .collect(Collectors.groupingBy(Alarm::getAlarmType, Collectors.counting()))
                .entrySet().stream()
                .sorted(Map.Entry.<String, Long>comparingByValue().reversed())
                .limit(limit)
                .collect(Collectors.toList());
    }

    public AlarmThreshold saveThreshold(AlarmThreshold threshold) {
        return thresholdRepo.save(threshold);
    }

    public List<AlarmThreshold> listThresholds() {
        return thresholdRepo.findByEnabledTrue();
    }

    // ── private helpers ──────────────────────────────────────────────

    private Alarm handleClear(Alarm clearEvent) {
        return alarmRepo.findByAlarmId(clearEvent.getAlarmId()).map(existing -> {
            existing.setState("CLEARED");
            existing.setClearedAt(Instant.now());
            Alarm saved = alarmRepo.save(existing);
            publish(processedAlarmsTopic, saved.getAlarmType(), saved);
            publishNetcool(saved);
            return saved;
        }).orElse(null);
    }

    private Alarm correlate(Alarm alarm) {
        // If the alarming device has a parent BTS also in ACTIVE alarm state,
        // mark child as correlated to parent's root-cause alarm.
        // Parent-child device IDs are resolved via deviceId naming convention or explicit field.
        String parentId = (String) alarm.getRawData().get("parentDeviceId");
        if (parentId != null) {
            alarmRepo.findByDeviceIdAndStateOrderByRaisedAtDesc(parentId, "ACTIVE").stream()
                    .findFirst()
                    .ifPresent(parentAlarm -> {
                        if (parentAlarm.isRootCause()) {
                            alarm.setRootCauseAlarmId(parentAlarm.getAlarmId());
                            alarm.setRootCause(false);
                            parentAlarm.setCorrelatedChildCount(parentAlarm.getCorrelatedChildCount() + 1);
                            alarmRepo.save(parentAlarm);
                        }
                    });
        }
        if (alarm.getRootCauseAlarmId() == null) {
            alarm.setRootCause(true);
        }
        return alarm;
    }

    private Alarm mapRawToAlarm(Map<String, Object> raw) {
        Alarm alarm = new Alarm();
        alarm.setAlarmId(getStr(raw, "alarmId", UUID.randomUUID().toString()));
        alarm.setDeviceId(getStr(raw, "deviceId", "unknown"));
        alarm.setDeviceType(getStr(raw, "deviceType", "UNKNOWN"));
        alarm.setAlarmType(getStr(raw, "alarmType", "GENERIC"));
        alarm.setAlarmName(getStr(raw, "alarmName", alarm.getAlarmType()));
        alarm.setSeverity(getStr(raw, "severity", "WARNING"));
        alarm.setState("ACTIVE");
        alarm.setDescription(getStr(raw, "description", ""));
        alarm.setSource(getStr(raw, "source", "SNMP"));
        alarm.setNetworkId(getStr(raw, "networkId", null));
        alarm.setOrganizationId(getStr(raw, "organizationId", null));
        alarm.setRaisedAt(Instant.now());
        alarm.setDedupWindowStart(Instant.now());
        alarm.setRawData(raw);
        return alarm;
    }

    @SuppressWarnings("unchecked")
    private void publish(String topic, String key, Alarm alarm) {
        try {
            kafkaTemplate.send(topic, key, objectMapper.writeValueAsString(alarm));
        } catch (Exception e) {
            log.error("Failed to publish alarm to {}", topic, e);
        }
    }

    private void publishNetcool(Alarm alarm) {
        try {
            Map<String, Object> netcool = new LinkedHashMap<>();
            netcool.put("alarmId", alarm.getAlarmId());
            netcool.put("alarmName", alarm.getAlarmName());
            netcool.put("severity", alarm.getSeverity());
            netcool.put("alarmDescription", alarm.getDescription());
            netcool.put("state", alarm.getState());
            netcool.put("Time", alarm.getRaisedAt() != null ? alarm.getRaisedAt().toString() : "");
            netcool.put("data", Map.of(
                    "deviceType", alarm.getDeviceType(),
                    "deviceId", alarm.getDeviceId()
            ));
            kafkaTemplate.send(netcoolTopic, alarm.getAlarmType(),
                    objectMapper.writeValueAsString(netcool));
        } catch (Exception e) {
            log.error("Failed to publish Netcool alarm", e);
        }
    }

    private String getStr(Map<String, Object> m, String key, String def) {
        Object v = m.get(key);
        return v != null ? v.toString() : def;
    }
}
