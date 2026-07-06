package com.ubrnms.kpiquery;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;
import com.ubrnms.kpiquery.model.*;
import com.ubrnms.kpiquery.repository.*;
import com.ubrnms.kpiquery.service.KpiQueryService;
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
import java.util.*;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
@MockitoSettings(strictness = Strictness.LENIENT)
class KpiQueryServiceTest {

    @Mock private KpiAggregateRepository aggregateRepo;
    @Mock private KpiThresholdRepository thresholdRepo;
    @Mock private KafkaTemplate<String, String> kafkaTemplate;
    @InjectMocks private KpiQueryService service;

    private final ObjectMapper mapper = new ObjectMapper().registerModule(new JavaTimeModule());

    @BeforeEach
    void injectFields() throws Exception {
        var f = KpiQueryService.class.getDeclaredField("objectMapper");
        f.setAccessible(true); f.set(service, mapper);
        var t = KpiQueryService.class.getDeclaredField("rawAlarmsTopic");
        t.setAccessible(true); t.set(service, "raw-alarms");
        var h = KpiQueryService.class.getDeclaredField("hotDataDays");
        h.setAccessible(true); h.set(service, 7);
    }

    // ── Granularity resolution ─────────────────────────────────────

    @Test
    void queryDevice_resolvesDefaultGranularity() {
        when(aggregateRepo.findByDeviceIdAndGranularityAndBucketStartBetweenOrderByBucketStartAsc(
                eq("dev-1"), eq("15MIN"), any(), any())).thenReturn(List.of());
        service.queryDevice("dev-1", null, Instant.now().minusSeconds(3600), Instant.now(), null);
        verify(aggregateRepo).findByDeviceIdAndGranularityAndBucketStartBetweenOrderByBucketStartAsc(
                eq("dev-1"), eq("15MIN"), any(), any());
    }

    @Test
    void queryDevice_resolvesHourGranularity() {
        when(aggregateRepo.findByDeviceIdAndGranularityAndBucketStartBetweenOrderByBucketStartAsc(
                eq("dev-2"), eq("1HOUR"), any(), any())).thenReturn(List.of());
        service.queryDevice("dev-2", "HOUR", Instant.now().minusSeconds(3600), Instant.now(), null);
        verify(aggregateRepo).findByDeviceIdAndGranularityAndBucketStartBetweenOrderByBucketStartAsc(
                eq("dev-2"), eq("1HOUR"), any(), any());
    }

    // ── Metric filtering ───────────────────────────────────────────

    @Test
    void queryDevice_filtersRequestedMetrics() {
        KpiAggregate agg = makeAggregate("dev-3");
        agg.getMetrics().put("rssi", new MetricStats(-65, -60, -62.5, 4, -250));
        agg.getMetrics().put("snr", new MetricStats(20, 25, 22.5, 4, 90));
        agg.getMetrics().put("cpuUtilization", new MetricStats(40, 60, 50, 4, 200));

        when(aggregateRepo.findByDeviceIdAndGranularityAndBucketStartBetweenOrderByBucketStartAsc(
                any(), any(), any(), any())).thenReturn(List.of(agg));

        List<KpiAggregate> result = service.queryDevice(
                "dev-3", "15MIN", Instant.now().minusSeconds(3600), Instant.now(),
                List.of("rssi", "snr"));
        assertThat(result.get(0).getMetrics()).containsKeys("rssi", "snr");
        assertThat(result.get(0).getMetrics()).doesNotContainKey("cpuUtilization");
    }

    // ── Threshold evaluation ───────────────────────────────────────

    @Test
    void evaluateThresholds_publishesAlarmWhenBreached() {
        KpiThreshold t = new KpiThreshold();
        t.setDeviceId("dev-4"); t.setMetric("cpuUtilization");
        t.setRaiseThreshold(90.0); t.setSeverity("MAJOR");

        when(thresholdRepo.findByDeviceIdAndEnabledTrue("dev-4")).thenReturn(List.of(t));

        Map<String, MetricStats> latest = Map.of(
                "cpuUtilization", new MetricStats(85, 95, 92.0, 4, 368));
        List<String> triggered = service.evaluateThresholds("dev-4", latest);

        assertThat(triggered).contains("cpuUtilization");
        verify(kafkaTemplate).send(eq("raw-alarms"), eq("dev-4"), anyString());
    }

    @Test
    void evaluateThresholds_noAlarmBelowThreshold() {
        KpiThreshold t = new KpiThreshold();
        t.setDeviceId("dev-5"); t.setMetric("cpuUtilization");
        t.setRaiseThreshold(90.0); t.setSeverity("MAJOR");

        when(thresholdRepo.findByDeviceIdAndEnabledTrue("dev-5")).thenReturn(List.of(t));

        Map<String, MetricStats> latest = Map.of(
                "cpuUtilization", new MetricStats(40, 60, 50.0, 4, 200));
        List<String> triggered = service.evaluateThresholds("dev-5", latest);

        assertThat(triggered).isEmpty();
        verify(kafkaTemplate, never()).send(any(), any(), any());
    }

    @Test
    void evaluateThresholds_belowDirectionTriggersCorrectly() {
        KpiThreshold t = new KpiThreshold();
        t.setDeviceId("dev-6"); t.setMetric("rssi");
        t.setRaiseThreshold(-80.0); t.setSeverity("WARNING");
        t.setDirection("BELOW");

        when(thresholdRepo.findByDeviceIdAndEnabledTrue("dev-6")).thenReturn(List.of(t));

        Map<String, MetricStats> latest = Map.of(
                "rssi", new MetricStats(-90, -85, -87.0, 4, -348));
        List<String> triggered = service.evaluateThresholds("dev-6", latest);

        assertThat(triggered).contains("rssi");
    }

    // ── Export rows ────────────────────────────────────────────────

    @Test
    void buildExportRows_containsMetricColumns() {
        KpiAggregate agg = makeAggregate("dev-7");
        agg.getMetrics().put("throughputUL", new MetricStats(50, 100, 75, 2, 150));
        List<Map<String, Object>> rows = service.buildExportRows(List.of(agg), null);
        assertThat(rows).hasSize(1);
        assertThat(rows.get(0)).containsKey("throughputUL_avg");
        assertThat(rows.get(0).get("deviceId")).isEqualTo("dev-7");
    }

    @Test
    void buildExportRows_respectsMetricFilter() {
        KpiAggregate agg = makeAggregate("dev-8");
        agg.getMetrics().put("rssi", new MetricStats(-70, -60, -65, 2, -130));
        agg.getMetrics().put("snr", new MetricStats(20, 28, 24, 2, 48));
        List<Map<String, Object>> rows = service.buildExportRows(List.of(agg), List.of("rssi"));
        assertThat(rows.get(0)).containsKey("rssi_avg");
        assertThat(rows.get(0)).doesNotContainKey("snr_avg");
    }

    // ── MongoDB fallback (warm data) ───────────────────────────────

    @Test
    void queryByNetwork_delegatesToRepository() {
        when(aggregateRepo.findByNetworkIdAndGranularityAndBucketStartBetween(
                eq("net-1"), eq("1HOUR"), any(), any())).thenReturn(List.of());
        service.queryByNetwork("net-1", "1HOUR", Instant.now().minusSeconds(3600), Instant.now());
        verify(aggregateRepo).findByNetworkIdAndGranularityAndBucketStartBetween(
                eq("net-1"), eq("1HOUR"), any(), any());
    }

    // ── helpers ───────────────────────────────────────────────────

    private KpiAggregate makeAggregate(String deviceId) {
        KpiAggregate a = new KpiAggregate();
        a.setDeviceId(deviceId); a.setGranularity("15MIN");
        a.setBucketStart(Instant.now().minusSeconds(900));
        a.setSampleCount(4); a.setMetrics(new HashMap<>());
        return a;
    }
}
