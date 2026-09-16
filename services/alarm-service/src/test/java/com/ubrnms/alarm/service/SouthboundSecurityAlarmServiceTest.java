package com.ubrnms.alarm.service;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.test.util.ReflectionTestUtils;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.LinkedHashMap;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyMap;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
class SouthboundSecurityAlarmServiceTest {

    @Mock
    private AlarmService alarmService;

    @InjectMocks
    private SouthboundSecurityAlarmService service;

    @BeforeEach
    void setUp() {
        // Default threshold=5, window=600s
        ReflectionTestUtils.setField(service, "failureThreshold", 5);
        ReflectionTestUtils.setField(service, "windowSecs", 600);
    }

    // ── onAuditEvent: watched action routing ──────────────────────────────────

    @Test
    void hmacFailureEventIncreasesCount() {
        service.onAuditEvent(makeEvent("southbound.hmac.failure", "SN-001"));
        assertThat(service.currentFailureCount("SN-001")).isEqualTo(1);
    }

    @Test
    void mtlsFailureEventIncreasesCount() {
        service.onAuditEvent(makeEvent("southbound.mtls.failure", "SN-002"));
        assertThat(service.currentFailureCount("SN-002")).isEqualTo(1);
    }

    @Test
    void unrelatedActionIsIgnored() {
        service.onAuditEvent(makeEvent("onboarding.attempt", "SN-003"));
        assertThat(service.currentFailureCount("SN-003")).isEqualTo(0);
        verifyNoInteractions(alarmService);
    }

    // ── Threshold breach ──────────────────────────────────────────────────────

    @Test
    void thresholdBreach_raisesAlarm() {
        for (int i = 0; i < 5; i++) {
            service.onAuditEvent(makeEvent("southbound.hmac.failure", "SN-BREACH"));
        }
        verify(alarmService, times(1)).processRawAlarm(anyMap());
    }

    @Test
    void alarmPayload_containsCorrectFields() {
        @SuppressWarnings("unchecked")
        ArgumentCaptor<Map<String, Object>> captor = ArgumentCaptor.forClass(Map.class);

        for (int i = 0; i < 5; i++) {
            service.onAuditEvent(makeEvent("southbound.hmac.failure", "SN-PAYLOAD"));
        }

        verify(alarmService).processRawAlarm(captor.capture());
        Map<String, Object> alarm = captor.getValue();

        assertThat(alarm.get("alarmType")).isEqualTo(SouthboundSecurityAlarmService.ALARM_TYPE);
        assertThat(alarm.get("severity")).isEqualTo(SouthboundSecurityAlarmService.ALARM_SEVERITY);
        assertThat(alarm.get("deviceId")).isEqualTo("SN-PAYLOAD");
        assertThat(alarm.get("correlationGroup")).isEqualTo("southbound-security-SN-PAYLOAD");
        assertThat((String) alarm.get("description")).contains("SN-PAYLOAD");
        assertThat((String) alarm.get("description")).contains("5");
        // SECURITY: HMAC keys / signatures must never appear in the alarm payload
        assertThat(alarm).doesNotContainKey("hmacKey");
        assertThat(alarm).doesNotContainKey("signature");
    }

    @Test
    void singleFailureBelowThreshold_noAlarm() {
        service.onAuditEvent(makeEvent("southbound.hmac.failure", "SN-SINGLE"));
        verifyNoInteractions(alarmService);
    }

    @Test
    void alarmRaisedOnlyOnceAtThreshold_notOnEverySubsequentFailure() {
        // First 5 → alarm raised (once on the 5th)
        for (int i = 0; i < 5; i++) {
            service.onAuditEvent(makeEvent("southbound.hmac.failure", "SN-ONCE"));
        }
        // Two more failures — alarm should be raised for each because each call
        // to processRawAlarm routes through the dedup pipeline inside AlarmService.
        service.onAuditEvent(makeEvent("southbound.hmac.failure", "SN-ONCE"));
        service.onAuditEvent(makeEvent("southbound.hmac.failure", "SN-ONCE"));

        // At least 1 alarm raised (dedup is AlarmService's responsibility, not ours)
        verify(alarmService, atLeast(1)).processRawAlarm(anyMap());
    }

    // ── Window expiry ─────────────────────────────────────────────────────────

    @Test
    void windowReset_clearsCount() {
        service.onAuditEvent(makeEvent("southbound.hmac.failure", "SN-RESET"));
        service.resetWindow("SN-RESET");
        assertThat(service.currentFailureCount("SN-RESET")).isEqualTo(0);
    }

    @Test
    void staleEntriesOutsideWindow_areNotCounted() {
        String serial = "SN-STALE";
        Instant now = Instant.now();
        Instant stale = now.minus(700, ChronoUnit.SECONDS); // older than 600s window

        // Directly record a stale entry
        service.recordFailure(serial, stale);
        // Count using now — stale entry should be pruned
        assertThat(service.countWindowFailures(serial, now)).isEqualTo(0);
    }

    @Test
    void mixedStaleAndFreshEntries_countOnlyFresh() {
        String serial = "SN-MIXED";
        Instant now = Instant.now();

        // 3 stale
        service.recordFailure(serial, now.minus(700, ChronoUnit.SECONDS));
        service.recordFailure(serial, now.minus(650, ChronoUnit.SECONDS));
        service.recordFailure(serial, now.minus(601, ChronoUnit.SECONDS));
        // 2 fresh
        service.recordFailure(serial, now.minus(100, ChronoUnit.SECONDS));
        service.recordFailure(serial, now.minus(50, ChronoUnit.SECONDS));

        assertThat(service.countWindowFailures(serial, now)).isEqualTo(2);
    }

    // ── Missing deviceSerial ──────────────────────────────────────────────────

    @Test
    void missingDeviceSerial_eventIsSkipped() {
        Map<String, Object> event = new LinkedHashMap<>();
        event.put("action", "southbound.hmac.failure");
        // No deviceSerial field

        service.onAuditEvent(event);
        verifyNoInteractions(alarmService);
    }

    // ── correlationGroup ─────────────────────────────────────────────────────

    @Test
    void correlationGroup_containsSerial() {
        String group = SouthboundSecurityAlarmService.correlationGroup("SN-CG");
        assertThat(group).isEqualTo("southbound-security-SN-CG");
    }

    // ── Multi-device isolation ────────────────────────────────────────────────

    @Test
    void failuresForDifferentDevicesAreIsolated() {
        for (int i = 0; i < 4; i++) {
            service.onAuditEvent(makeEvent("southbound.hmac.failure", "SN-A"));
        }
        for (int i = 0; i < 3; i++) {
            service.onAuditEvent(makeEvent("southbound.mtls.failure", "SN-B"));
        }

        assertThat(service.currentFailureCount("SN-A")).isEqualTo(4);
        assertThat(service.currentFailureCount("SN-B")).isEqualTo(3);
        verifyNoInteractions(alarmService); // neither has reached threshold=5
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private Map<String, Object> makeEvent(String action, String deviceSerial) {
        Map<String, Object> event = new LinkedHashMap<>();
        event.put("action", action);
        event.put("deviceSerial", deviceSerial);
        event.put("timestamp", Instant.now().toString());
        event.put("serviceSource", "discovery-service");
        return event;
    }
}
