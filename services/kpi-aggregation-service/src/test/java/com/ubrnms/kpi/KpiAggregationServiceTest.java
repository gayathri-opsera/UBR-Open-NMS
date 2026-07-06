package com.ubrnms.kpi;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;
import com.ubrnms.kpi.model.*;
import com.ubrnms.kpi.repository.KpiAggregateRepository;
import com.ubrnms.kpi.service.KpiAggregationService;
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
import java.util.List;
import java.util.Optional;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
@MockitoSettings(strictness = Strictness.LENIENT)
class KpiAggregationServiceTest {

    @Mock private KpiAggregateRepository aggregateRepo;
    @Mock private KafkaTemplate<String, String> kafkaTemplate;
    @InjectMocks private KpiAggregationService service;

    private final MeterRegistry meterRegistry = new SimpleMeterRegistry();
    private final ObjectMapper mapper = new ObjectMapper().registerModule(new JavaTimeModule());

    @BeforeEach
    void injectFields() throws Exception {
        setField("objectMapper", mapper);
        setField("meterRegistry", meterRegistry);
        setField("mycomTopic", "mycom-kpi-export");
    }

    void setField(String name, Object value) throws Exception {
        var f = KpiAggregationService.class.getDeclaredField(name);
        f.setAccessible(true); f.set(service, value);
    }

    // ── 15-minute aggregation ──────────────────────────────────────

    @Test
    void aggregate_creates15MinBucket() {
        when(aggregateRepo.findByDeviceIdAndBucketStartAndGranularity(any(), any(), any()))
                .thenReturn(Optional.empty());
        when(aggregateRepo.save(any())).thenAnswer(inv -> inv.getArgument(0));

        RawKpiEvent event = makeEvent("dev-1", -70.0, 25.0);
        service.aggregate(event);

        verify(aggregateRepo, times(3)).save(argThat(a ->
                a.getSampleCount() == 1 && a.getMetrics().containsKey("rssi")));
    }

    @Test
    void aggregate_upsertsMergesIntoExistingBucket() {
        KpiAggregate existing = new KpiAggregate();
        existing.setDeviceId("dev-2"); existing.setGranularity("15MIN");
        existing.setSampleCount(2);
        existing.setMetrics(new java.util.HashMap<>());
        MetricStats rssiStats = new MetricStats(-65, -60, -62.5, 2, -125.0);
        existing.getMetrics().put("rssi", rssiStats);

        when(aggregateRepo.findByDeviceIdAndBucketStartAndGranularity(eq("dev-2"), any(), eq("15MIN")))
                .thenReturn(Optional.of(existing));
        when(aggregateRepo.findByDeviceIdAndBucketStartAndGranularity(eq("dev-2"), any(), eq("1HOUR")))
                .thenReturn(Optional.empty());
        when(aggregateRepo.findByDeviceIdAndBucketStartAndGranularity(eq("dev-2"), any(), eq("DAILY")))
                .thenReturn(Optional.empty());
        when(aggregateRepo.save(any())).thenAnswer(inv -> inv.getArgument(0));

        RawKpiEvent event = makeEvent("dev-2", -80.0, 30.0);
        service.aggregate(event);

        assertThat(existing.getSampleCount()).isEqualTo(3);
        assertThat(existing.getMetrics().get("rssi").getMin()).isEqualTo(-80.0);
    }

    // ── 1-hour rollup ──────────────────────────────────────────────

    @Test
    void bucketStart_1hour_alignsToHour() {
        Instant ts = Instant.parse("2026-07-05T14:37:00Z");
        Instant bucket = KpiAggregationService.bucketStart(ts, "1HOUR");
        assertThat(bucket).isEqualTo(Instant.parse("2026-07-05T14:00:00Z"));
    }

    // ── Daily rollup ───────────────────────────────────────────────

    @Test
    void bucketStart_daily_alignsToMidnight() {
        Instant ts = Instant.parse("2026-07-05T14:37:00Z");
        Instant bucket = KpiAggregationService.bucketStart(ts, "DAILY");
        assertThat(bucket).isEqualTo(Instant.parse("2026-07-05T00:00:00Z"));
    }

    // ── MetricStats aggregation logic ──────────────────────────────

    @Test
    void computeStats_calculatesCorrectly() {
        MetricStats stats = service.computeStats(List.of(-70.0, -65.0, -60.0));
        assertThat(stats.getMin()).isEqualTo(-70.0);
        assertThat(stats.getMax()).isEqualTo(-60.0);
        assertThat(stats.getAvg()).isEqualTo((-70.0 - 65.0 - 60.0) / 3, within(0.001));
        assertThat(stats.getCount()).isEqualTo(3);
    }

    // ── Mycom JSON format ──────────────────────────────────────────

    @Test
    void buildMycomExport_containsAllRequiredFields() {
        RawKpiEvent event = makeEvent("dev-3", -75.0, 20.0);
        event.setSerialNumber("SN-001");
        event.setModelNo("A60");
        event.setCpuUtilization(45.0);
        event.setFreeMemory(512L);

        MycomKpiExport export = service.buildMycomExport(event);
        assertThat(export.getSerialNumber()).isEqualTo("SN-001");
        assertThat(export.getModelNo()).isEqualTo("A60");
        assertThat(export.getWireless5GhzRadio()).isNotNull();
        assertThat(export.getWireless5GhzRadio().getRssi()).isEqualTo(-75.0);
        assertThat(export.getWireless5GhzRadio().getSnr()).isEqualTo(20.0);
        assertThat(export.getCpuUtilization()).isEqualTo(45.0);
    }

    @Test
    void mycomExport_isValidJson() throws Exception {
        RawKpiEvent event = makeEvent("dev-4", -68.0, 22.0);
        event.setSerialNumber("SN-XYZ");
        MycomKpiExport export = service.buildMycomExport(event);
        String json = mapper.writeValueAsString(export);
        assertThat(json).contains("serialNumber");
        assertThat(json).contains("wireless5GhzRadio");
    }

    // ── TTL configuration ──────────────────────────────────────────

    @Test
    void aggregate_setsTtlExpiry() {
        when(aggregateRepo.findByDeviceIdAndBucketStartAndGranularity(any(), any(), any()))
                .thenReturn(Optional.empty());
        when(aggregateRepo.save(any())).thenAnswer(inv -> inv.getArgument(0));

        RawKpiEvent event = makeEvent("dev-5", -60.0, 18.0);
        service.aggregate(event);

        verify(aggregateRepo, atLeastOnce()).save(argThat(a ->
                a.getTtlExpiry() != null &&
                a.getTtlExpiry().isAfter(Instant.now().plus(89, ChronoUnit.DAYS))));
    }

    // ── helpers ───────────────────────────────────────────────────

    private RawKpiEvent makeEvent(String deviceId, double rssi, double snr) {
        RawKpiEvent e = new RawKpiEvent();
        e.setDeviceId(deviceId);
        e.setDeviceType("BTS");
        e.setNetworkId("net-1");
        e.setTimestamp(Instant.now());
        e.setRssi(rssi);
        e.setSnr(snr);
        e.setCpuUtilization(50.0);
        e.setThroughputUL(100.0);
        e.setThroughputDL(200.0);
        return e;
    }
}
