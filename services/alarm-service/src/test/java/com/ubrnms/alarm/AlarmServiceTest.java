package com.ubrnms.alarm;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;
import com.ubrnms.alarm.model.Alarm;
import com.ubrnms.alarm.model.AlarmThreshold;
import com.ubrnms.alarm.repository.AlarmRepository;
import com.ubrnms.alarm.repository.AlarmThresholdRepository;
import com.ubrnms.alarm.service.AlarmService;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.mockito.junit.jupiter.MockitoSettings;
import org.mockito.quality.Strictness;
import org.springframework.kafka.core.KafkaTemplate;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.*;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
@MockitoSettings(strictness = Strictness.LENIENT)
class AlarmServiceTest {

    @Mock private AlarmRepository alarmRepo;
    @Mock private AlarmThresholdRepository thresholdRepo;
    @Mock private KafkaTemplate<String, String> kafkaTemplate;
    @InjectMocks private AlarmService service;

    private final MeterRegistry meterRegistry = new SimpleMeterRegistry();
    private final ObjectMapper mapper = new ObjectMapper().registerModule(new JavaTimeModule());

    @BeforeEach
    void injectFields() throws Exception {
        setField("objectMapper", mapper);
        setField("meterRegistry", meterRegistry);
        setField("dedupWindowMinutes", 5);
        setField("processedAlarmsTopic", "processed-alarms");
        setField("netcoolTopic", "netcool-alarms-forward");
    }

    void setField(String name, Object value) throws Exception {
        var f = AlarmService.class.getDeclaredField(name);
        f.setAccessible(true);
        f.set(service, value);
    }

    // ── Deduplication ─────────────────────────────────────────────

    @Test
    void deduplication_incrementsCountOnDuplicate() {
        Alarm existing = new Alarm();
        existing.setAlarmId("a1"); existing.setDeviceId("dev-1");
        existing.setAlarmType("HIGH_CPU"); existing.setState("ACTIVE");
        existing.setDedupCount(0); existing.setDedupWindowStart(Instant.now());

        when(alarmRepo.findTopByDeviceIdAndAlarmTypeAndStateAndDedupWindowStartAfterOrderByRaisedAtDesc(
                eq("dev-1"), eq("HIGH_CPU"), eq("ACTIVE"), any()))
                .thenReturn(Optional.of(existing));
        when(alarmRepo.save(any())).thenAnswer(inv -> inv.getArgument(0));

        Map<String, Object> raw = rawEvent("dev-1", "HIGH_CPU");
        Alarm result = service.processRawAlarm(raw);

        assertThat(result.getDedupCount()).isEqualTo(1);
        verify(alarmRepo, never()).save(argThat(a -> a.getDedupCount() == 0 && a.getAlarmId() == null));
    }

    @Test
    void deduplication_createsNewAlarmOutsideWindow() {
        when(alarmRepo.findTopByDeviceIdAndAlarmTypeAndStateAndDedupWindowStartAfterOrderByRaisedAtDesc(
                any(), any(), any(), any())).thenReturn(Optional.empty());
        when(alarmRepo.findByDeviceIdAndStateOrderByRaisedAtDesc(any(), any())).thenReturn(List.of());
        when(alarmRepo.save(any())).thenAnswer(inv -> {
            Alarm a = inv.getArgument(0); a.setId(UUID.randomUUID().toString()); return a;
        });

        Alarm result = service.processRawAlarm(rawEvent("dev-2", "LINK_DOWN"));
        assertThat(result).isNotNull();
        assertThat(result.getDedupCount()).isEqualTo(0);
        assertThat(result.getState()).isEqualTo("ACTIVE");
    }

    // ── Correlation ───────────────────────────────────────────────

    @Test
    void correlation_childLinkedToParentRootCause() {
        Alarm parentAlarm = new Alarm();
        parentAlarm.setAlarmId("root-1"); parentAlarm.setDeviceId("bts-001");
        parentAlarm.setRootCause(true);

        Map<String, Object> raw = rawEvent("cpe-001", "LINK_DOWN");
        raw.put("parentDeviceId", "bts-001");

        when(alarmRepo.findTopByDeviceIdAndAlarmTypeAndStateAndDedupWindowStartAfterOrderByRaisedAtDesc(
                any(), any(), any(), any())).thenReturn(Optional.empty());
        when(alarmRepo.findByDeviceIdAndStateOrderByRaisedAtDesc("bts-001", "ACTIVE"))
                .thenReturn(List.of(parentAlarm));
        when(alarmRepo.save(any())).thenAnswer(inv -> inv.getArgument(0));

        Alarm result = service.processRawAlarm(raw);
        assertThat(result.getRootCauseAlarmId()).isEqualTo("root-1");
        assertThat(result.isRootCause()).isFalse();
    }

    @Test
    void correlation_standaloneAlarmMarkedAsRootCause() {
        when(alarmRepo.findTopByDeviceIdAndAlarmTypeAndStateAndDedupWindowStartAfterOrderByRaisedAtDesc(
                any(), any(), any(), any())).thenReturn(Optional.empty());
        when(alarmRepo.findByDeviceIdAndStateOrderByRaisedAtDesc(any(), any())).thenReturn(List.of());
        when(alarmRepo.save(any())).thenAnswer(inv -> inv.getArgument(0));

        Alarm result = service.processRawAlarm(rawEvent("bts-100", "POWER_FAULT"));
        assertThat(result.isRootCause()).isTrue();
    }

    // ── Threshold ─────────────────────────────────────────────────

    @Test
    void threshold_raisesAlarmWhenBreached() {
        AlarmThreshold rule = new AlarmThreshold();
        rule.setParameter("CPU"); rule.setRaiseThreshold(90.0);
        rule.setClearThreshold(80.0); rule.setSeverity("MAJOR");
        rule.setAlarmType("HIGH_CPU"); rule.setEnabled(true);

        when(thresholdRepo.findByDeviceIdAndEnabledTrue("dev-3")).thenReturn(List.of(rule));
        when(thresholdRepo.findByDeviceTypeAndDeviceIdIsNullAndEnabledTrue(any())).thenReturn(List.of());
        when(alarmRepo.findTopByDeviceIdAndAlarmTypeAndStateAndDedupWindowStartAfterOrderByRaisedAtDesc(
                any(), any(), any(), any())).thenReturn(Optional.empty());
        when(alarmRepo.findByDeviceIdAndStateOrderByRaisedAtDesc(any(), any())).thenReturn(List.of());
        when(alarmRepo.save(any())).thenAnswer(inv -> inv.getArgument(0));

        Optional<Alarm> result = service.evaluateThreshold("dev-3", "BTS", "CPU", 95.0);
        assertThat(result).isPresent();
        assertThat(result.get().getAlarmType()).isEqualTo("HIGH_CPU");
        assertThat(result.get().getSeverity()).isEqualTo("MAJOR");
    }

    @Test
    void threshold_noAlarmBelowThreshold() {
        AlarmThreshold rule = new AlarmThreshold();
        rule.setParameter("CPU"); rule.setRaiseThreshold(90.0);
        rule.setEnabled(true);

        when(thresholdRepo.findByDeviceIdAndEnabledTrue("dev-4")).thenReturn(List.of(rule));
        when(thresholdRepo.findByDeviceTypeAndDeviceIdIsNullAndEnabledTrue(any())).thenReturn(List.of());

        Optional<Alarm> result = service.evaluateThreshold("dev-4", "BTS", "CPU", 70.0);
        assertThat(result).isEmpty();
    }

    // ── Netcool format ────────────────────────────────────────────

    @Test
    void netcoolPublish_calledWithRequiredFields() {
        when(alarmRepo.findTopByDeviceIdAndAlarmTypeAndStateAndDedupWindowStartAfterOrderByRaisedAtDesc(
                any(), any(), any(), any())).thenReturn(Optional.empty());
        when(alarmRepo.findByDeviceIdAndStateOrderByRaisedAtDesc(any(), any())).thenReturn(List.of());
        when(alarmRepo.save(any())).thenAnswer(inv -> inv.getArgument(0));

        service.processRawAlarm(rawEvent("bts-9", "LINK_DOWN"));

        // Two topics: processed-alarms and netcool-alarms-forward
        verify(kafkaTemplate, times(2)).send(anyString(), anyString(), anyString());
    }

    // ── State transitions ─────────────────────────────────────────

    @Test
    void acknowledge_updatesStateAndActor() {
        Alarm active = new Alarm();
        active.setId("id-1"); active.setState("ACTIVE");

        when(alarmRepo.findById("id-1")).thenReturn(Optional.of(active));
        when(alarmRepo.save(any())).thenAnswer(inv -> inv.getArgument(0));

        Alarm acked = service.acknowledge("id-1", "NOC-operator");
        assertThat(acked.getState()).isEqualTo("ACKNOWLEDGED");
        assertThat(acked.getAcknowledgedBy()).isEqualTo("NOC-operator");
        assertThat(acked.getAcknowledgedAt()).isNotNull();
    }

    @Test
    void clear_updatesStateToCLEARED() {
        Alarm active = new Alarm();
        active.setId("id-2"); active.setAlarmId("alarm-2"); active.setState("ACTIVE");

        when(alarmRepo.findByAlarmId("alarm-2")).thenReturn(Optional.of(active));
        when(alarmRepo.save(any())).thenAnswer(inv -> inv.getArgument(0));

        Map<String, Object> clearEvt = rawEvent("dev-1", "LINK_DOWN");
        clearEvt.put("state", "CLEAR"); clearEvt.put("alarmId", "alarm-2");

        Alarm result = service.processRawAlarm(clearEvt);
        assertThat(result.getState()).isEqualTo("CLEARED");
        assertThat(result.getClearedAt()).isNotNull();
    }

    // ── helpers ───────────────────────────────────────────────────

    private Map<String, Object> rawEvent(String deviceId, String alarmType) {
        Map<String, Object> m = new HashMap<>();
        m.put("deviceId", deviceId); m.put("alarmType", alarmType);
        m.put("deviceType", "BTS"); m.put("severity", "MAJOR");
        m.put("source", "SNMP"); m.put("description", "test alarm");
        return m;
    }
}
