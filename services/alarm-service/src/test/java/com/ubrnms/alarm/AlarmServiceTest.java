package com.ubrnms.alarm;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;
import com.ubrnms.alarm.model.Alarm;
import com.ubrnms.alarm.model.AlarmThreshold;
import com.ubrnms.alarm.model.FrameworkThresholdEvaluationRequest;
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

    // ── WO-051: Classification normalization tests ────────────────────────────

    @Test
    void normalization_setsSchemaVersion2_0() {
        when(alarmRepo.findTopByDeviceIdAndAlarmTypeAndStateAndDedupWindowStartAfterOrderByRaisedAtDesc(
                any(), any(), any(), any())).thenReturn(Optional.empty());
        when(alarmRepo.findByDeviceIdAndStateOrderByRaisedAtDesc(any(), any())).thenReturn(List.of());
        when(alarmRepo.save(any())).thenAnswer(inv -> inv.getArgument(0));

        Alarm result = service.processRawAlarm(rawEvent("dev-n1", "LINK_DOWN"));

        assertThat(result.getSchemaVersion()).isEqualTo("2.0");
    }

    @Test
    void normalization_snmpSourceMappedToFaultCategory() {
        when(alarmRepo.findTopByDeviceIdAndAlarmTypeAndStateAndDedupWindowStartAfterOrderByRaisedAtDesc(
                any(), any(), any(), any())).thenReturn(Optional.empty());
        when(alarmRepo.findByDeviceIdAndStateOrderByRaisedAtDesc(any(), any())).thenReturn(List.of());
        when(alarmRepo.save(any())).thenAnswer(inv -> inv.getArgument(0));

        Map<String, Object> raw = rawEvent("dev-n2", "INTERFACE_DOWN");
        raw.put("source", "SNMP");
        Alarm result = service.processRawAlarm(raw);

        assertThat(result.getCategory()).isEqualTo("FAULT");
        assertThat(result.getSourceSystem()).isEqualTo("SNMP_POLLER");
    }

    @Test
    void normalization_thresholdSourceMappedToThresholdCategory() {
        when(alarmRepo.findTopByDeviceIdAndAlarmTypeAndStateAndDedupWindowStartAfterOrderByRaisedAtDesc(
                any(), any(), any(), any())).thenReturn(Optional.empty());
        when(alarmRepo.findByDeviceIdAndStateOrderByRaisedAtDesc(any(), any())).thenReturn(List.of());
        when(alarmRepo.save(any())).thenAnswer(inv -> inv.getArgument(0));

        Map<String, Object> raw = rawEvent("dev-n3", "HIGH_CPU");
        raw.put("source", "THRESHOLD");
        Alarm result = service.processRawAlarm(raw);

        assertThat(result.getCategory()).isEqualTo("THRESHOLD");
        assertThat(result.getSourceSystem()).isEqualTo("THRESHOLD_ENGINE");
    }

    @Test
    void normalization_selfHealthSourceMappedToLifecycleCategory() {
        when(alarmRepo.findTopByDeviceIdAndAlarmTypeAndStateAndDedupWindowStartAfterOrderByRaisedAtDesc(
                any(), any(), any(), any())).thenReturn(Optional.empty());
        when(alarmRepo.findByDeviceIdAndStateOrderByRaisedAtDesc(any(), any())).thenReturn(List.of());
        when(alarmRepo.save(any())).thenAnswer(inv -> inv.getArgument(0));

        Map<String, Object> raw = rawEvent("dev-n4", "SERVICE_RESTART");
        raw.put("source", "SELF_HEALTH");
        Alarm result = service.processRawAlarm(raw);

        assertThat(result.getCategory()).isEqualTo("LIFECYCLE");
        assertThat(result.getSourceSystem()).isEqualTo("SELF_HEALTH_MONITOR");
    }

    @Test
    void normalization_southboundSourceMappedToSecurityCategory() {
        when(alarmRepo.findTopByDeviceIdAndAlarmTypeAndStateAndDedupWindowStartAfterOrderByRaisedAtDesc(
                any(), any(), any(), any())).thenReturn(Optional.empty());
        when(alarmRepo.findByDeviceIdAndStateOrderByRaisedAtDesc(any(), any())).thenReturn(List.of());
        when(alarmRepo.save(any())).thenAnswer(inv -> inv.getArgument(0));

        Map<String, Object> raw = rawEvent("dev-n5", "SOUTHBOUND_AUTH_FAILURE");
        raw.put("source", "SOUTHBOUND");
        raw.put("correlationId", "corr-sec-001");
        Alarm result = service.processRawAlarm(raw);

        assertThat(result.getCategory()).isEqualTo("SECURITY");
        assertThat(result.getSourceSystem()).isEqualTo("DISCOVERY_SERVICE");
        assertThat(result.getCorrelationId()).isEqualTo("corr-sec-001");
    }

    @Test
    void normalization_missingSourceFallsBackToFaultWithFallbackReason() {
        when(alarmRepo.findTopByDeviceIdAndAlarmTypeAndStateAndDedupWindowStartAfterOrderByRaisedAtDesc(
                any(), any(), any(), any())).thenReturn(Optional.empty());
        when(alarmRepo.findByDeviceIdAndStateOrderByRaisedAtDesc(any(), any())).thenReturn(List.of());
        when(alarmRepo.save(any())).thenAnswer(inv -> inv.getArgument(0));

        Map<String, Object> raw = new HashMap<>();
        raw.put("deviceId", "dev-n6");
        raw.put("alarmType", "GENERIC");
        raw.put("deviceType", "BTS");
        // No source field intentionally
        Alarm result = service.processRawAlarm(raw);

        assertThat(result.getCategory()).isEqualTo("FAULT");
        assertThat(result.getClassificationReason()).isEqualTo("FALLBACK_DEFAULT");
    }

    @Test
    void normalization_evidenceContextExcludesSensitiveFields() {
        when(alarmRepo.findTopByDeviceIdAndAlarmTypeAndStateAndDedupWindowStartAfterOrderByRaisedAtDesc(
                any(), any(), any(), any())).thenReturn(Optional.empty());
        when(alarmRepo.findByDeviceIdAndStateOrderByRaisedAtDesc(any(), any())).thenReturn(List.of());
        when(alarmRepo.save(any())).thenAnswer(inv -> inv.getArgument(0));

        Map<String, Object> raw = rawEvent("dev-n7", "SOUTHBOUND_AUTH_FAILURE");
        raw.put("source", "SOUTHBOUND");
        // Simulate raw event that might contain sensitive fields (should never appear in evidenceContext)
        raw.put("hmacSignature", "should-not-appear");
        raw.put("certificatePem", "should-not-appear");
        Alarm result = service.processRawAlarm(raw);

        assertThat(result.getEvidenceContext()).doesNotContainKey("hmacSignature");
        assertThat(result.getEvidenceContext()).doesNotContainKey("certificatePem");
    }

    @Test
    void normalization_idempotencyKeyIsCompositeOfDeviceTypeAndSource() {
        when(alarmRepo.findTopByDeviceIdAndAlarmTypeAndStateAndDedupWindowStartAfterOrderByRaisedAtDesc(
                any(), any(), any(), any())).thenReturn(Optional.empty());
        when(alarmRepo.findByDeviceIdAndStateOrderByRaisedAtDesc(any(), any())).thenReturn(List.of());
        when(alarmRepo.save(any())).thenAnswer(inv -> inv.getArgument(0));

        Alarm result = service.processRawAlarm(rawEvent("dev-n8", "HIGH_CPU"));

        assertThat(result.getIdempotencyKey()).isEqualTo("dev-n8:HIGH_CPU:SNMP_POLLER");
    }

    @Test
    void normalization_malformedSeverityProducesIndeterminate() {
        when(alarmRepo.findTopByDeviceIdAndAlarmTypeAndStateAndDedupWindowStartAfterOrderByRaisedAtDesc(
                any(), any(), any(), any())).thenReturn(Optional.empty());
        when(alarmRepo.findByDeviceIdAndStateOrderByRaisedAtDesc(any(), any())).thenReturn(List.of());
        when(alarmRepo.save(any())).thenAnswer(inv -> inv.getArgument(0));

        Map<String, Object> raw = rawEvent("dev-n9", "LINK_DOWN");
        raw.put("severity", "NOT_A_VALID_SEVERITY");
        Alarm result = service.processRawAlarm(raw);

        assertThat(result.getSeverity()).isEqualTo("INDETERMINATE");
    }

    @Test
    void normalization_deduplicationPreservesOriginalClassification() {
        Alarm existing = new Alarm();
        existing.setAlarmId("a-dup"); existing.setDeviceId("dev-dup");
        existing.setAlarmType("HIGH_CPU"); existing.setState("ACTIVE");
        existing.setDedupCount(2); existing.setDedupWindowStart(Instant.now());
        existing.setCategory("THRESHOLD");
        existing.setSchemaVersion("2.0");
        existing.setSourceSystem("THRESHOLD_ENGINE");

        when(alarmRepo.findTopByDeviceIdAndAlarmTypeAndStateAndDedupWindowStartAfterOrderByRaisedAtDesc(
                eq("dev-dup"), eq("HIGH_CPU"), eq("ACTIVE"), any()))
                .thenReturn(Optional.of(existing));
        when(alarmRepo.save(any())).thenAnswer(inv -> inv.getArgument(0));

        Map<String, Object> raw = rawEvent("dev-dup", "HIGH_CPU");
        Alarm result = service.processRawAlarm(raw);

        // Dedup should increment count and preserve the original classification metadata.
        assertThat(result.getDedupCount()).isEqualTo(3);
        assertThat(result.getCategory()).isEqualTo("THRESHOLD");
        assertThat(result.getSchemaVersion()).isEqualTo("2.0");
    }

    @Test
    void normalization_securityEventWithUnknownIdentityAcceptedAsPlatformAlarm() {
        when(alarmRepo.findTopByDeviceIdAndAlarmTypeAndStateAndDedupWindowStartAfterOrderByRaisedAtDesc(
                any(), any(), any(), any())).thenReturn(Optional.empty());
        when(alarmRepo.findByDeviceIdAndStateOrderByRaisedAtDesc(any(), any())).thenReturn(List.of());
        when(alarmRepo.save(any())).thenAnswer(inv -> inv.getArgument(0));

        Map<String, Object> raw = new HashMap<>();
        raw.put("alarmType", "SOUTHBOUND_AUTH_FAILURE");
        raw.put("source", "SOUTHBOUND");
        raw.put("deviceType", "UNKNOWN");
        // No deviceId — simulates a cert failure with no associated inventory record.
        raw.put("description", "mTLS cert invalid — device identity undetermined");
        Alarm result = service.processRawAlarm(raw);

        assertThat(result).isNotNull();
        assertThat(result.getCategory()).isEqualTo("SECURITY");
        // Device identity must be marked as unknown, not as a crash.
        assertThat(result.getDeviceId()).isEqualTo("unknown");
    }

    // ── WO-013: Framework metadata threshold evaluation ──────────────────────────

    /**
     * Helper to build a minimal FrameworkThresholdEvaluationRequest for threshold tests.
     */
    private FrameworkThresholdEvaluationRequest frameworkRequest(
            String deviceId, String parameterId, double value,
            Double thresholdHigh, Double thresholdLow) {
        return FrameworkThresholdEvaluationRequest.builder()
                .deviceId(deviceId)
                .deviceType("BTS")
                .productDefinitionId("pd-cisco-ios")
                .registryVersion("registry-v1")
                .groupId("grp-interface")
                .parameterId(parameterId)
                .valueNumeric(value)
                .collectedAt(Instant.now())
                .thresholdHigh(thresholdHigh)
                .thresholdLow(thresholdLow)
                .correlationId("corr-wo013-test")
                .build();
    }

    @Test
    void frameworkThreshold_highBreachRaisesActiveAlarm() {
        when(alarmRepo.findTopByDeviceIdAndAlarmTypeAndStateAndDedupWindowStartAfterOrderByRaisedAtDesc(
                any(), any(), any(), any())).thenReturn(Optional.empty());
        when(alarmRepo.findByDeviceIdAndStateOrderByRaisedAtDesc(any(), any())).thenReturn(List.of());
        when(alarmRepo.save(any())).thenAnswer(inv -> inv.getArgument(0));

        FrameworkThresholdEvaluationRequest req = frameworkRequest("dev-fw-001", "ifInOctets", 9000.0, 5000.0, null);
        Optional<Alarm> result = service.evaluateFrameworkThreshold(req);

        assertThat(result).isPresent();
        Alarm alarm = result.get();
        assertThat(alarm.getState()).isEqualTo("ACTIVE");
        assertThat(alarm.getSeverity()).isEqualTo("MAJOR");
        assertThat(alarm.getSource()).isEqualTo("THRESHOLD");
        assertThat(alarm.getCategory()).isEqualTo("THRESHOLD");
        assertThat(alarm.getThresholdCondition()).isEqualTo("HIGH");
        assertThat(alarm.getObservedValue()).isEqualTo(9000.0);
        assertThat(alarm.getThresholdValue()).isEqualTo(5000.0);
        assertThat(alarm.getParameterId()).isEqualTo("ifInOctets");
        assertThat(alarm.getProductDefinitionId()).isEqualTo("pd-cisco-ios");
        assertThat(alarm.getRegistryVersion()).isEqualTo("registry-v1");
        assertThat(alarm.getGroupId()).isEqualTo("grp-interface");
        assertThat(alarm.getCorrelationId()).isEqualTo("corr-wo013-test");
        assertThat(alarm.getAlarmType()).contains("THRESHOLD_HIGH");
        assertThat(alarm.getAlarmType()).contains("IFINOCTETS");
    }

    @Test
    void frameworkThreshold_lowBreachRaisesActiveAlarm() {
        when(alarmRepo.findTopByDeviceIdAndAlarmTypeAndStateAndDedupWindowStartAfterOrderByRaisedAtDesc(
                any(), any(), any(), any())).thenReturn(Optional.empty());
        when(alarmRepo.findByDeviceIdAndStateOrderByRaisedAtDesc(any(), any())).thenReturn(List.of());
        when(alarmRepo.save(any())).thenAnswer(inv -> inv.getArgument(0));

        FrameworkThresholdEvaluationRequest req = frameworkRequest("dev-fw-002", "rxPower", -45.0, null, -40.0);
        Optional<Alarm> result = service.evaluateFrameworkThreshold(req);

        assertThat(result).isPresent();
        Alarm alarm = result.get();
        assertThat(alarm.getThresholdCondition()).isEqualTo("LOW");
        assertThat(alarm.getObservedValue()).isEqualTo(-45.0);
        assertThat(alarm.getThresholdValue()).isEqualTo(-40.0);
        assertThat(alarm.getAlarmType()).contains("THRESHOLD_LOW");
    }

    @Test
    void frameworkThreshold_inRangeReturnsEmpty() {
        FrameworkThresholdEvaluationRequest req = frameworkRequest("dev-fw-003", "cpuLoad", 30.0, 90.0, 5.0);
        Optional<Alarm> result = service.evaluateFrameworkThreshold(req);
        assertThat(result).isEmpty();
        verify(alarmRepo, never()).save(any());
    }

    @Test
    void frameworkThreshold_noThresholdsConfiguredReturnsEmpty() {
        // Both thresholds null — parameter has no threshold metadata.
        FrameworkThresholdEvaluationRequest req = frameworkRequest("dev-fw-004", "ifDescr", 0.0, null, null);
        Optional<Alarm> result = service.evaluateFrameworkThreshold(req);
        assertThat(result).isEmpty();
        verify(alarmRepo, never()).save(any());
    }

    @Test
    void frameworkThreshold_nullRequestReturnsEmpty() {
        Optional<Alarm> result = service.evaluateFrameworkThreshold(null);
        assertThat(result).isEmpty();
        verify(alarmRepo, never()).save(any());
    }

    @Test
    void frameworkThreshold_deduplicatesRepeatedBreach() {
        // First call creates the alarm; second call deduplicates it.
        Alarm existing = new Alarm();
        existing.setAlarmId("fw-a1");
        existing.setDeviceId("dev-fw-005");
        existing.setAlarmType("FRAMEWORK_THRESHOLD_HIGH_IFINOCTETS");
        existing.setState("ACTIVE");
        existing.setDedupCount(0);
        existing.setDedupWindowStart(Instant.now());

        when(alarmRepo.findTopByDeviceIdAndAlarmTypeAndStateAndDedupWindowStartAfterOrderByRaisedAtDesc(
                eq("dev-fw-005"), eq("FRAMEWORK_THRESHOLD_HIGH_IFINOCTETS"), eq("ACTIVE"), any()))
                .thenReturn(Optional.of(existing));
        when(alarmRepo.save(any())).thenAnswer(inv -> inv.getArgument(0));

        FrameworkThresholdEvaluationRequest req = frameworkRequest("dev-fw-005", "ifInOctets", 9000.0, 5000.0, null);
        Optional<Alarm> result = service.evaluateFrameworkThreshold(req);

        assertThat(result).isPresent();
        assertThat(result.get().getDedupCount()).isEqualTo(1);
    }

    @Test
    void frameworkThreshold_alarmDescriptionContainsParameterAndThresholdContext() {
        when(alarmRepo.findTopByDeviceIdAndAlarmTypeAndStateAndDedupWindowStartAfterOrderByRaisedAtDesc(
                any(), any(), any(), any())).thenReturn(Optional.empty());
        when(alarmRepo.findByDeviceIdAndStateOrderByRaisedAtDesc(any(), any())).thenReturn(List.of());
        when(alarmRepo.save(any())).thenAnswer(inv -> inv.getArgument(0));

        FrameworkThresholdEvaluationRequest req = frameworkRequest("dev-fw-006", "memUtil", 95.0, 90.0, null);
        Optional<Alarm> result = service.evaluateFrameworkThreshold(req);

        assertThat(result).isPresent();
        String description = result.get().getDescription();
        assertThat(description).contains("memUtil");
        assertThat(description).contains("95.0000");
        assertThat(description).contains("90.0000");
        assertThat(description).contains("pd-cisco-ios");
    }

    @Test
    void frameworkThreshold_descriptionNeverContainsCredentialKeywords() {
        when(alarmRepo.findTopByDeviceIdAndAlarmTypeAndStateAndDedupWindowStartAfterOrderByRaisedAtDesc(
                any(), any(), any(), any())).thenReturn(Optional.empty());
        when(alarmRepo.findByDeviceIdAndStateOrderByRaisedAtDesc(any(), any())).thenReturn(List.of());
        when(alarmRepo.save(any())).thenAnswer(inv -> inv.getArgument(0));

        FrameworkThresholdEvaluationRequest req = frameworkRequest("dev-fw-007", "rxPower", -55.0, null, -50.0);
        Optional<Alarm> result = service.evaluateFrameworkThreshold(req);

        assertThat(result).isPresent();
        String desc = result.get().getDescription().toLowerCase();
        List<String> forbidden = List.of("password", "secret", "token", "api_key", "community", "private_key");
        for (String kw : forbidden) {
            assertThat(desc).as("Description must not contain " + kw).doesNotContain(kw);
        }
    }

    @Test
    void frameworkThreshold_highAtExactBoundaryIsBreached() {
        when(alarmRepo.findTopByDeviceIdAndAlarmTypeAndStateAndDedupWindowStartAfterOrderByRaisedAtDesc(
                any(), any(), any(), any())).thenReturn(Optional.empty());
        when(alarmRepo.findByDeviceIdAndStateOrderByRaisedAtDesc(any(), any())).thenReturn(List.of());
        when(alarmRepo.save(any())).thenAnswer(inv -> inv.getArgument(0));

        // Exact equality with threshold triggers alarm (>= semantics)
        FrameworkThresholdEvaluationRequest req = frameworkRequest("dev-fw-008", "cpuLoad", 90.0, 90.0, null);
        Optional<Alarm> result = service.evaluateFrameworkThreshold(req);
        assertThat(result).isPresent();
        assertThat(result.get().getThresholdCondition()).isEqualTo("HIGH");
    }

    @Test
    void frameworkThreshold_lowAtExactBoundaryIsBreached() {
        when(alarmRepo.findTopByDeviceIdAndAlarmTypeAndStateAndDedupWindowStartAfterOrderByRaisedAtDesc(
                any(), any(), any(), any())).thenReturn(Optional.empty());
        when(alarmRepo.findByDeviceIdAndStateOrderByRaisedAtDesc(any(), any())).thenReturn(List.of());
        when(alarmRepo.save(any())).thenAnswer(inv -> inv.getArgument(0));

        // Exact equality with low threshold triggers alarm (<= semantics)
        FrameworkThresholdEvaluationRequest req = frameworkRequest("dev-fw-009", "rxPower", -40.0, null, -40.0);
        Optional<Alarm> result = service.evaluateFrameworkThreshold(req);
        assertThat(result).isPresent();
        assertThat(result.get().getThresholdCondition()).isEqualTo("LOW");
    }
}
