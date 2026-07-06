package com.ubrnms.kpiquery.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.ubrnms.kpiquery.model.*;
import com.ubrnms.kpiquery.repository.*;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.cache.annotation.Cacheable;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.*;
import java.util.stream.Collectors;

@Slf4j
@Service
@RequiredArgsConstructor
public class KpiQueryService {

    private final KpiAggregateRepository aggregateRepo;
    private final KpiThresholdRepository thresholdRepo;
    private final KafkaTemplate<String, String> kafkaTemplate;
    private final ObjectMapper objectMapper;

    @Value("${kafka.topics.raw-alarms:raw-alarms}")
    private String rawAlarmsTopic;

    @Value("${kpi.hot-data-days:7}")
    private int hotDataDays;

    // ── KPI Query ──────────────────────────────────────────────────

    /**
     * Query aggregated KPI data for a device. Uses MongoDB warm storage.
     * For hot data (≤7 days), same collection is queried (ScyllaDB fallback
     * would be wired here in production).
     */
    @Cacheable(value = "kpi-device", key = "#deviceId + ':' + #granularity + ':' + #from + ':' + #to")
    public List<KpiAggregate> queryDevice(String deviceId, String granularity,
                                           Instant from, Instant to,
                                           List<String> metrics) {
        List<KpiAggregate> results = aggregateRepo
                .findByDeviceIdAndGranularityAndBucketStartBetweenOrderByBucketStartAsc(
                        deviceId, resolveGranularity(granularity), from, to);
        return filterMetrics(results, metrics);
    }

    @Cacheable(value = "kpi-network", key = "#networkId + ':' + #granularity + ':' + #from + ':' + #to")
    public List<KpiAggregate> queryByNetwork(String networkId, String granularity,
                                              Instant from, Instant to) {
        return aggregateRepo.findByNetworkIdAndGranularityAndBucketStartBetween(
                networkId, resolveGranularity(granularity), from, to);
    }

    @Cacheable(value = "kpi-org", key = "#organizationId + ':' + #granularity + ':' + #from + ':' + #to")
    public List<KpiAggregate> queryByOrganization(String organizationId, String granularity,
                                                    Instant from, Instant to) {
        return aggregateRepo.findByOrganizationIdAndGranularityAndBucketStartBetween(
                organizationId, resolveGranularity(granularity), from, to);
    }

    // ── Threshold CRUD ─────────────────────────────────────────────

    public KpiThreshold createThreshold(KpiThreshold threshold) {
        return thresholdRepo.save(threshold);
    }

    public List<KpiThreshold> listThresholds() {
        return thresholdRepo.findByEnabledTrue();
    }

    public KpiThreshold updateThreshold(String id, KpiThreshold patch) {
        KpiThreshold existing = thresholdRepo.findById(id)
                .orElseThrow(() -> new NoSuchElementException("Threshold not found: " + id));
        if (patch.getRaiseThreshold() != 0) existing.setRaiseThreshold(patch.getRaiseThreshold());
        if (patch.getClearThreshold() != 0) existing.setClearThreshold(patch.getClearThreshold());
        if (patch.getSeverity() != null)     existing.setSeverity(patch.getSeverity());
        return thresholdRepo.save(existing);
    }

    public void deleteThreshold(String id) {
        thresholdRepo.deleteById(id);
    }

    /**
     * Evaluate all enabled thresholds against the latest KPI aggregate.
     * Publishes alarm events to raw-alarms for any breach.
     */
    public List<String> evaluateThresholds(String deviceId, Map<String, MetricStats> latestMetrics) {
        List<KpiThreshold> thresholds = thresholdRepo.findByDeviceIdAndEnabledTrue(deviceId);
        List<String> triggered = new ArrayList<>();

        for (KpiThreshold t : thresholds) {
            MetricStats stats = latestMetrics.get(t.getMetric());
            if (stats == null) continue;

            double value = stats.getAvg();
            boolean above = !"BELOW".equalsIgnoreCase(t.getDirection());
            boolean breached = above ? value >= t.getRaiseThreshold()
                                     : value <= t.getRaiseThreshold();
            if (breached) {
                publishThresholdAlarm(deviceId, t, value);
                triggered.add(t.getMetric());
            }
        }
        return triggered;
    }

    // ── Export ─────────────────────────────────────────────────────

    public List<Map<String, Object>> buildExportRows(List<KpiAggregate> aggregates,
                                                      List<String> metrics) {
        List<Map<String, Object>> rows = new ArrayList<>();
        for (KpiAggregate agg : aggregates) {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("deviceId", agg.getDeviceId());
            row.put("granularity", agg.getGranularity());
            row.put("bucketStart", agg.getBucketStart() != null ? agg.getBucketStart().toString() : "");
            row.put("sampleCount", agg.getSampleCount());
            if (agg.getMetrics() != null) {
                Set<String> keep = (metrics != null && !metrics.isEmpty())
                        ? new HashSet<>(metrics) : agg.getMetrics().keySet();
                for (String m : keep) {
                    MetricStats s = agg.getMetrics().get(m);
                    if (s != null) {
                        row.put(m + "_avg", s.getAvg());
                        row.put(m + "_min", s.getMin());
                        row.put(m + "_max", s.getMax());
                    }
                }
            }
            rows.add(row);
        }
        return rows;
    }

    // ── Private helpers ────────────────────────────────────────────

    private String resolveGranularity(String gran) {
        if (gran == null) return "15MIN";
        return switch (gran.toUpperCase()) {
            case "1HOUR", "HOUR", "1H" -> "1HOUR";
            case "DAILY", "DAY", "1D"  -> "DAILY";
            default -> "15MIN";
        };
    }

    private List<KpiAggregate> filterMetrics(List<KpiAggregate> aggs, List<String> metrics) {
        if (metrics == null || metrics.isEmpty()) return aggs;
        for (KpiAggregate agg : aggs) {
            if (agg.getMetrics() != null) {
                agg.getMetrics().keySet().retainAll(metrics);
            }
        }
        return aggs;
    }

    private void publishThresholdAlarm(String deviceId, KpiThreshold threshold, double value) {
        try {
            Map<String, Object> alarm = new LinkedHashMap<>();
            alarm.put("deviceId", deviceId);
            alarm.put("alarmType", "KPI_THRESHOLD_" + threshold.getMetric().toUpperCase());
            alarm.put("alarmName", threshold.getMetric() + " threshold breached");
            alarm.put("severity", threshold.getSeverity());
            alarm.put("description", String.format("%s=%.2f exceeded threshold=%.2f",
                    threshold.getMetric(), value, threshold.getRaiseThreshold()));
            alarm.put("source", "KPI_QUERY");
            alarm.put("deviceType", threshold.getDeviceType());
            alarm.put("networkId", threshold.getNetworkId());
            kafkaTemplate.send(rawAlarmsTopic, deviceId, objectMapper.writeValueAsString(alarm));
        } catch (Exception e) {
            log.error("Failed to publish threshold alarm", e);
        }
    }
}
