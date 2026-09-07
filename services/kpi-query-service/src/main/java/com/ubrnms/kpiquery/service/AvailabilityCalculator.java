package com.ubrnms.kpiquery.service;

import com.ubrnms.kpiquery.model.AvailabilitySummaryDto;
import com.ubrnms.kpiquery.model.AvailabilitySummaryDto.HealthState;
import com.ubrnms.kpiquery.model.AvailabilitySummaryDto.Source;
import com.ubrnms.kpiquery.model.KpiAggregate;
import com.ubrnms.kpiquery.model.MetricStats;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Pure availability calculation component for WO-041.
 *
 * <p>Accepts recent KPI aggregates, alarm context, and inventory identity to produce
 * a deterministic {@link AvailabilitySummaryDto}. State precedence (highest wins):
 * <ol>
 *   <li>DOWN — explicit down signal or critical alarm</li>
 *   <li>DEGRADED — elevated alarm, metric threshold breach, or stale KPI data</li>
 *   <li>UNKNOWN — no KPI history or missing identity</li>
 *   <li>UP — all signals within normal thresholds</li>
 * </ol>
 *
 * <p>Flap dampening prevents repeated state changes within the configured window when
 * a device alternates rapidly between healthy and failed observations.
 *
 * <p>UBR call-home authoritative online state is never overwritten by generic SNMP
 * enrichment — this constraint is enforced in {@link #calculate}.
 */
@Slf4j
@Component
public class AvailabilityCalculator {

    /** Seconds before an observation is considered stale (configurable). */
    @Value("${availability.freshness-window-seconds:900}")
    private long freshnessWindowSeconds;

    /** Flap dampening window in seconds. */
    @Value("${availability.flap-dampening-seconds:300}")
    private long flapDampeningSeconds;

    /** Flap detection: transitions within this many minutes trigger dampening. */
    @Value("${availability.flap-threshold-transitions:3}")
    private int flapThresholdTransitions;

    /** Clock skew tolerance in seconds — observations within this window are treated as current. */
    @Value("${availability.clock-skew-tolerance-seconds:60}")
    private long clockSkewToleranceSeconds;

    /**
     * In-memory flap tracking keyed by deviceId.
     * Production would persist this in Redis; in-memory is sufficient for the service boundary.
     */
    private final Map<String, FlapTracker> flapTrackers = new ConcurrentHashMap<>();

    // ── Public API ─────────────────────────────────────────────────

    /**
     * Compute the availability summary for a device.
     *
     * @param deviceId       canonical device identifier
     * @param serialNumber   device serial number (may be null for newly onboarded)
     * @param deviceType     device class (BTS, CPE, IDU, GENERIC)
     * @param recentAggs     KPI aggregates from the last freshness window — may be empty
     * @param activeAlarms   list of active alarm severities for this device (e.g. ["CRITICAL", "MAJOR"])
     * @param callHomeOnline authoritative online indicator from check-in/realtime (null if unavailable)
     * @param isGenericSnmpDevice true when device is discovered via SNMP and NOT a UBR call-home device
     */
    public AvailabilitySummaryDto calculate(
            String deviceId,
            String serialNumber,
            String deviceType,
            List<KpiAggregate> recentAggs,
            List<String> activeAlarms,
            Boolean callHomeOnline,
            boolean isGenericSnmpDevice) {

        Instant now = Instant.now();

        // Newly onboarded device — no KPI history and no call-home state
        if (recentAggs.isEmpty() && callHomeOnline == null) {
            return AvailabilitySummaryDto.builder()
                    .deviceId(deviceId)
                    .serialNumber(serialNumber)
                    .deviceType(deviceType)
                    .healthState(HealthState.UNKNOWN)
                    .primaryReason("Newly onboarded device — no KPI history yet")
                    .secondaryReasons(Collections.emptyList())
                    .lastObservedAt(null)
                    .source(Source.UNKNOWN)
                    .confidence(0.0)
                    .stale(false)
                    .dampenedUntil(null)
                    .build();
        }

        // Determine latest observation timestamp
        Instant lastObservedAt = recentAggs.stream()
                .map(KpiAggregate::getBucketStart)
                .filter(Objects::nonNull)
                .max(Comparator.naturalOrder())
                .orElse(null);

        // Stale detection — tolerate clock skew within clockSkewToleranceSeconds
        boolean stale = false;
        if (lastObservedAt != null) {
            long ageSeconds = ChronoUnit.SECONDS.between(lastObservedAt, now) - clockSkewToleranceSeconds;
            stale = ageSeconds > freshnessWindowSeconds;
        }

        // ── State calculation with deterministic precedence ─────────────────

        HealthState state = HealthState.UP;
        String primaryReason = "All KPI metrics within normal thresholds";
        List<String> secondaryReasons = new ArrayList<>();
        Source source = Source.KPI;
        double confidence = 0.9;

        // UBR call-home authoritative state takes precedence over generic SNMP enrichment.
        // Never let generic SNMP mark a call-home device as DOWN/UP without explicit authority.
        if (callHomeOnline != null && !isGenericSnmpDevice) {
            if (Boolean.FALSE.equals(callHomeOnline)) {
                state = HealthState.DOWN;
                primaryReason = "UBR device not reporting to call-home service";
                source = Source.CALL_HOME;
                confidence = 0.99;
            } else {
                state = HealthState.UP;
                primaryReason = "Device reporting regularly via call-home";
                source = Source.CALL_HOME;
                confidence = 0.95;
            }
        } else {
            // Generic SNMP enrichment — check KPI signals
            if (stale) {
                state = HealthState.DEGRADED;
                primaryReason = String.format("KPI data stale — last observation %d minutes ago",
                        lastObservedAt != null ? ChronoUnit.MINUTES.between(lastObservedAt, now) : -1);
                source = Source.SNMP;
                confidence = 0.5;
                secondaryReasons.add("SNMP poll may be failing");
            }
        }

        // Alarm context overrides KPI-derived state where alarms are more severe
        if (activeAlarms != null && !activeAlarms.isEmpty()) {
            boolean hasCritical = activeAlarms.stream().anyMatch(a -> "CRITICAL".equalsIgnoreCase(a));
            boolean hasMajor    = activeAlarms.stream().anyMatch(a -> "MAJOR".equalsIgnoreCase(a));

            if (hasCritical && HealthState.DOWN.overrides(state)) {
                state = HealthState.DOWN;
                primaryReason = "Critical alarm active on device";
                source = Source.ALARM;
                confidence = 0.99;
            } else if (hasMajor && HealthState.DEGRADED.overrides(state)) {
                state = HealthState.DEGRADED;
                primaryReason = "Major alarm active on device";
                source = Source.ALARM;
                confidence = 0.85;
                secondaryReasons.add("Check alarm details for affected metrics");
            }
        }

        // KPI metric checks — identify degraded signals from recent aggregates
        if (!recentAggs.isEmpty() && state == HealthState.UP) {
            Optional<String> degradedMetric = detectDegradedMetric(recentAggs);
            if (degradedMetric.isPresent()) {
                if (HealthState.DEGRADED.overrides(state)) {
                    state = HealthState.DEGRADED;
                    primaryReason = "Metric exceeding threshold: " + degradedMetric.get();
                    source = Source.KPI;
                    confidence = 0.82;
                }
            }
        }

        // Multiple simultaneous signals — resolve to a deterministic single state
        // (already handled by the precedence chain above)

        // Flap dampening — if state keeps oscillating, hold in DEGRADED with reason
        FlapTracker tracker = flapTrackers.computeIfAbsent(deviceId, id -> new FlapTracker());
        tracker.record(state, now);

        Instant dampenedUntil = null;
        if (tracker.isFlapping(flapThresholdTransitions, flapDampeningSeconds)) {
            if (state == HealthState.UP || state == HealthState.DOWN) {
                dampenedUntil = now.plus(flapDampeningSeconds, ChronoUnit.SECONDS);
                secondaryReasons.add(0, "Flap dampening active: device alternating rapidly");
                if (HealthState.DEGRADED.overrides(state)) {
                    state = HealthState.DEGRADED;
                    primaryReason = "Flap dampening active: device alternating UP/DOWN faster than dampening window";
                    confidence = 0.6;
                }
            }
        }

        // Confidence adjustment for stale data
        if (stale) {
            confidence = Math.max(0.0, confidence - 0.3);
        }

        log.debug("Availability calc device={} state={} source={} confidence={} stale={}",
                deviceId, state, source, confidence, stale);

        return AvailabilitySummaryDto.builder()
                .deviceId(deviceId)
                .serialNumber(serialNumber)
                .deviceType(deviceType)
                .healthState(state)
                .primaryReason(primaryReason)
                .secondaryReasons(secondaryReasons)
                .lastObservedAt(lastObservedAt)
                .source(source)
                .confidence(confidence)
                .stale(stale)
                .dampenedUntil(dampenedUntil)
                .build();
    }

    // ── Private helpers ─────────────────────────────────────────────

    /**
     * Detect whether any recent aggregate shows a metric in a degraded band.
     * Uses heuristic thresholds appropriate for NMS monitoring:
     * CPU > 80%, memory > 85%, packet loss > 2%, latency > 100ms.
     */
    private Optional<String> detectDegradedMetric(List<KpiAggregate> aggs) {
        for (KpiAggregate agg : aggs) {
            if (agg.getMetrics() == null) continue;

            MetricStats cpu  = agg.getMetrics().get("cpuUtilization");
            MetricStats mem  = agg.getMetrics().get("memoryUtilization");
            MetricStats pkt  = agg.getMetrics().get("packetLossPct");
            MetricStats lat  = agg.getMetrics().get("latencyMs");

            if (cpu  != null && cpu.getAvg()  > 80.0) return Optional.of("cpuUtilization");
            if (mem  != null && mem.getAvg()  > 85.0) return Optional.of("memoryUtilization");
            if (pkt  != null && pkt.getAvg()  > 2.0)  return Optional.of("packetLossPct");
            if (lat  != null && lat.getAvg()  > 100.0) return Optional.of("latencyMs");
        }
        return Optional.empty();
    }

    // ── Flap tracking ───────────────────────────────────────────────

    private static class FlapTracker {
        private final List<StateRecord> history = new ArrayList<>();

        void record(HealthState state, Instant at) {
            history.add(new StateRecord(state, at));
            // Trim history to last 10 entries to prevent unbounded growth
            if (history.size() > 10) {
                history.remove(0);
            }
        }

        boolean isFlapping(int thresholdTransitions, long windowSeconds) {
            if (history.size() < 2) return false;

            Instant cutoff = Instant.now().minus(windowSeconds, ChronoUnit.SECONDS);
            List<StateRecord> recent = history.stream()
                    .filter(r -> r.at.isAfter(cutoff))
                    .toList();

            int transitions = 0;
            for (int i = 1; i < recent.size(); i++) {
                if (recent.get(i).state != recent.get(i - 1).state) {
                    transitions++;
                }
            }
            return transitions >= thresholdTransitions;
        }

        private record StateRecord(HealthState state, Instant at) {}
    }
}
