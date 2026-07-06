package com.ubrnms.kpi.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.ubrnms.kpi.model.*;
import com.ubrnms.kpi.repository.KpiAggregateRepository;
import io.micrometer.core.instrument.Counter;
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

@Slf4j
@Service
@RequiredArgsConstructor
public class KpiAggregationService {

    private final KpiAggregateRepository aggregateRepo;
    private final KafkaTemplate<String, String> kafkaTemplate;
    private final ObjectMapper objectMapper;
    private final MeterRegistry meterRegistry;

    @Value("${kafka.topics.mycom-kpi-export:mycom-kpi-export}")
    private String mycomTopic;

    // ── Public entry-point ─────────────────────────────────────────

    /**
     * Process a single raw KPI event: compute all three granularity rollups
     * and publish to Mycom export topic.
     */
    public void aggregate(RawKpiEvent event) {
        Timer.Sample sample = Timer.start(meterRegistry);
        try {
            Map<String, Double> kpiValues = extractDoubleValues(event);

            for (String gran : List.of("15MIN", "1HOUR", "DAILY")) {
                Instant bucketStart = bucketStart(event.getTimestamp(), gran);
                Instant bucketEnd = bucketStart.plus(bucketMinutes(gran), ChronoUnit.MINUTES);
                upsertAggregate(event, kpiValues, bucketStart, bucketEnd, gran);
            }

            // Publish Mycom export
            publishMycom(event);

            meterRegistry.counter("kpi_records_aggregated_total").increment();
        } finally {
            sample.stop(meterRegistry.timer("kpi_aggregation_latency_seconds"));
        }
    }

    /**
     * Compute aggregated stats for a list of raw values.
     */
    public MetricStats computeStats(List<Double> values) {
        MetricStats stats = new MetricStats();
        for (Double v : values) {
            if (v != null) stats.add(v);
        }
        return stats;
    }

    /**
     * Build a Mycom KPI export object from a raw event.
     */
    public MycomKpiExport buildMycomExport(RawKpiEvent event) {
        MycomKpiExport export = new MycomKpiExport();
        export.setSerialNumber(event.getSerialNumber());
        export.setDeviceType(event.getDeviceType());
        export.setModelNo(event.getModelNo());
        export.setCollectionTime(event.getTimestamp() != null ? event.getTimestamp().toString() : "");

        MycomKpiExport.WirelessRadio radio = new MycomKpiExport.WirelessRadio();
        radio.setRssi(event.getRssi());
        radio.setSnr(event.getSnr());
        radio.setOperatingChannel(event.getOperatingChannel());
        radio.setChannelUtilization(event.getChannelUtilization());
        radio.setBandwidth(event.getBandwidth());
        radio.setMcs(event.getMcs());
        radio.setTxPower(event.getTxPower());
        radio.setThroughputUL(event.getThroughputUL());
        radio.setThroughputDL(event.getThroughputDL());
        radio.setLatency(event.getLatency());
        radio.setPacketRetransmit(event.getPacketRetransmit());
        radio.setCrcErrors(event.getCrcErrors());
        export.setWireless5GhzRadio(radio);

        export.setCpuUtilization(event.getCpuUtilization());
        export.setFreeMemory(event.getFreeMemory());
        export.setRebootCount(event.getRebootCount());
        export.setDyingGaspCount(event.getDyingGaspCount());

        return export;
    }

    // ── Private helpers ────────────────────────────────────────────

    private void upsertAggregate(RawKpiEvent event, Map<String, Double> kpiValues,
                                  Instant bucketStart, Instant bucketEnd, String gran) {
        String id = event.getDeviceId() + ":" + bucketStart.toEpochMilli() + ":" + gran;
        KpiAggregate agg = aggregateRepo.findByDeviceIdAndBucketStartAndGranularity(
                event.getDeviceId(), bucketStart, gran)
                .orElseGet(() -> {
                    KpiAggregate a = new KpiAggregate();
                    a.setId(id);
                    a.setDeviceId(event.getDeviceId());
                    a.setDeviceType(event.getDeviceType());
                    a.setNetworkId(event.getNetworkId());
                    a.setGranularity(gran);
                    a.setBucketStart(bucketStart);
                    a.setBucketEnd(bucketEnd);
                    a.setMetrics(new HashMap<>());
                    a.setTtlExpiry(Instant.now().plus(90, ChronoUnit.DAYS));
                    return a;
                });

        for (Map.Entry<String, Double> entry : kpiValues.entrySet()) {
            agg.getMetrics().computeIfAbsent(entry.getKey(), k -> new MetricStats())
                    .add(entry.getValue());
        }
        agg.setSampleCount(agg.getSampleCount() + 1);
        aggregateRepo.save(agg);
    }

    private void publishMycom(RawKpiEvent event) {
        try {
            MycomKpiExport export = buildMycomExport(event);
            kafkaTemplate.send(mycomTopic, event.getDeviceId(),
                    objectMapper.writeValueAsString(export));
            meterRegistry.counter("mycom_exports_total").increment();
        } catch (Exception e) {
            log.error("Failed to publish Mycom KPI export", e);
        }
    }

    public static Instant bucketStart(Instant ts, String granularity) {
        if (ts == null) ts = Instant.now();
        long epochSec = ts.getEpochSecond();
        long bucketSec = bucketMinutes(granularity) * 60L;
        return Instant.ofEpochSecond(epochSec - (epochSec % bucketSec));
    }

    static int bucketMinutes(String granularity) {
        return switch (granularity) {
            case "15MIN" -> 15;
            case "1HOUR" -> 60;
            case "DAILY" -> 1440;
            default -> 15;
        };
    }

    private Map<String, Double> extractDoubleValues(RawKpiEvent e) {
        Map<String, Double> m = new LinkedHashMap<>();
        put(m, "rssi", e.getRssi());
        put(m, "snr", e.getSnr());
        put(m, "channelUtilization", e.getChannelUtilization());
        put(m, "txPower", e.getTxPower());
        put(m, "throughputUL", e.getThroughputUL());
        put(m, "throughputDL", e.getThroughputDL());
        put(m, "latency", e.getLatency());
        put(m, "cpuUtilization", e.getCpuUtilization());
        if (e.getTxBytes() != null) m.put("txBytes", e.getTxBytes().doubleValue());
        if (e.getRxBytes() != null) m.put("rxBytes", e.getRxBytes().doubleValue());
        if (e.getPacketsDropped() != null) m.put("packetsDropped", e.getPacketsDropped().doubleValue());
        if (e.getFreeMemory() != null) m.put("freeMemory", e.getFreeMemory().doubleValue());
        return m;
    }

    private void put(Map<String, Double> m, String k, Double v) {
        if (v != null) m.put(k, v);
    }
}
