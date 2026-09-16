package com.ubrnms.alarm.service;

import com.ubrnms.alarm.model.Alarm;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.stream.Collectors;

/**
 * WO-023: Southbound Security Alarm Service.
 *
 * Consumes audit events on {@code southbound.audit.events} and counts
 * {@code southbound.hmac.failure} and {@code southbound.mtls.failure} events
 * per device within a sliding time window. When failures from a single device
 * exceed {@code SOUTHBOUND_ALARM_FAILURE_THRESHOLD} within
 * {@code SOUTHBOUND_ALARM_WINDOW_SECS}, a CRITICAL alarm
 * ({@code SOUTHBOUND_AUTH_BRUTE_FORCE}) is raised via {@link AlarmService}.
 *
 * <p>The correlation group is {@code southbound-security-<deviceSerial>} to ensure
 * only one active brute-force alarm per device is raised at a time.
 *
 * <p>SECURITY: device serial number is used for correlation; HMAC keys, signatures,
 * and mTLS certificate data are never included in alarm payloads or logs.
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class SouthboundSecurityAlarmService {

    static final String ALARM_TYPE        = "SOUTHBOUND_AUTH_BRUTE_FORCE";
    static final String ALARM_SEVERITY    = "CRITICAL";
    static final String ALARM_SOURCE      = "SOUTHBOUND_SECURITY";

    /** Actions that count toward the brute-force threshold. */
    private static final Set<String> WATCHED_ACTIONS = Set.of(
            "southbound.hmac.failure",
            "southbound.mtls.failure"
    );

    @Value("${southbound.alarm.failure-threshold:5}")
    private int failureThreshold;

    @Value("${southbound.alarm.window-secs:600}")
    private int windowSecs;

    private final AlarmService alarmService;

    /**
     * Per-device failure timestamps within the current window.
     * Entries are pruned on each evaluation — no background sweeper required for
     * correctness (worst-case stale entries are cleared on the next event).
     */
    private final ConcurrentHashMap<String, Deque<Instant>> failureWindows =
            new ConcurrentHashMap<>();

    /**
     * Kafka listener for audit events published by auth/discovery services.
     * Only {@code southbound.hmac.failure} and {@code southbound.mtls.failure}
     * actions are processed; all others are ignored.
     *
     * @param event audit event map deserialized from the Kafka message
     */
    @KafkaListener(
            topics        = "${kafka.topics.southbound-audit-events:southbound.audit.events}",
            groupId       = "${kafka.consumer.group-id:alarm-service}",
            containerFactory = "auditEventListenerFactory"
    )
    public void onAuditEvent(Map<String, Object> event) {
        String action = getString(event, "action", "");

        if (!WATCHED_ACTIONS.contains(action)) {
            return;
        }

        // Extract device identifier — never log secrets, signatures, or HMAC values
        String deviceSerial = resolveDeviceSerial(event);
        if (deviceSerial == null || deviceSerial.isBlank()) {
            log.warn("southbound security event missing deviceSerial, cannot evaluate threshold");
            return;
        }

        Instant now = Instant.now();
        recordFailure(deviceSerial, now);

        int count = countWindowFailures(deviceSerial, now);
        log.debug("southbound security failure count for serial={} count={} threshold={}",
                deviceSerial, count, failureThreshold);

        if (count >= failureThreshold) {
            raiseAlarm(deviceSerial, action, count, now);
        }
    }

    /**
     * Records a new failure timestamp for the given device and prunes old entries
     * that fall outside the current window.
     */
    void recordFailure(String deviceSerial, Instant now) {
        failureWindows.compute(deviceSerial, (k, deque) -> {
            if (deque == null) {
                deque = new ArrayDeque<>();
            }
            deque.addLast(now);
            return deque;
        });
    }

    /**
     * Counts failures within the window and removes stale entries.
     * Thread-safe under ConcurrentHashMap's compute semantics.
     */
    int countWindowFailures(String deviceSerial, Instant now) {
        Instant windowStart = now.minus(windowSecs, ChronoUnit.SECONDS);
        Deque<Instant> deque = failureWindows.get(deviceSerial);
        if (deque == null) return 0;

        // Prune entries older than the window boundary
        synchronized (deque) {
            while (!deque.isEmpty() && deque.peekFirst().isBefore(windowStart)) {
                deque.pollFirst();
            }
            return deque.size();
        }
    }

    /**
     * Raises a CRITICAL brute-force alarm via AlarmService.
     * The correlation group ensures only one active alarm per device.
     * SECURITY: only the device serial and failure count are included — no secrets.
     */
    void raiseAlarm(String deviceSerial, String triggerAction, int failureCount, Instant detectedAt) {
        Map<String, Object> raw = new LinkedHashMap<>();
        raw.put("alarmId",          UUID.randomUUID().toString());
        raw.put("deviceId",         deviceSerial);
        raw.put("deviceType",       "UNKNOWN");
        raw.put("alarmType",        ALARM_TYPE);
        raw.put("alarmName",        "Southbound authentication brute-force detected");
        raw.put("severity",         ALARM_SEVERITY);
        raw.put("source",           ALARM_SOURCE);
        raw.put("correlationGroup", correlationGroup(deviceSerial));
        raw.put("description",      String.format(
                "Device serial=%s triggered %d southbound auth failures within %d seconds. " +
                "Last action: %s. Investigate for HMAC/mTLS credential abuse.",
                deviceSerial, failureCount, windowSecs, triggerAction));
        raw.put("raisedAt",         detectedAt.toString());
        raw.put("state",            "ACTIVE");
        raw.put("detectedFailureCount", failureCount);

        log.warn("SOUTHBOUND_AUTH_BRUTE_FORCE alarm raised for deviceSerial={} failureCount={} window={}s",
                deviceSerial, failureCount, windowSecs);

        alarmService.processRawAlarm(raw);
    }

    /**
     * Resets the failure window for a device (e.g., after a successful re-enrolment).
     * Exposed for use by provisioning workflows.
     */
    public void resetWindow(String deviceSerial) {
        failureWindows.remove(deviceSerial);
        log.info("Southbound security failure window reset for deviceSerial={}", deviceSerial);
    }

    /**
     * Returns the current failure count within the window without mutating state.
     * Used for health-check and metrics endpoints.
     */
    public int currentFailureCount(String deviceSerial) {
        return countWindowFailures(deviceSerial, Instant.now());
    }

    /**
     * Returns the correlation group key for a given device serial.
     * Downstream dedup logic uses this to suppress duplicate open alarms.
     */
    public static String correlationGroup(String deviceSerial) {
        return "southbound-security-" + deviceSerial;
    }

    // ── Private helpers ────────────────────────────────────────────────────────

    /**
     * Resolves the device serial from the audit event.
     * Auth events may carry the serial under different keys depending on the publisher.
     */
    private String resolveDeviceSerial(Map<String, Object> event) {
        // Primary key used by discovery-service audit events
        Object serial = event.get("deviceSerial");
        if (serial != null) return String.valueOf(serial);

        // Secondary: nested payload.deviceSerial
        if (event.get("payload") instanceof Map<?, ?> payload) {
            Object ps = payload.get("deviceSerial");
            if (ps != null) return String.valueOf(ps);
        }

        // Tertiary: resourceId (used by auth-service SSO/HMAC events)
        return getString(event, "resourceId", null);
    }

    private static String getString(Map<String, Object> map, String key, String defaultValue) {
        Object val = map.get(key);
        return (val instanceof String s) ? s : defaultValue;
    }
}
