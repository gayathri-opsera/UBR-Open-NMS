package com.ubrnms.kpiquery.controller;

import com.ubrnms.kpiquery.model.KpiAggregate;
import com.ubrnms.kpiquery.model.KpiThreshold;
import com.ubrnms.kpiquery.service.KpiExportService;
import com.ubrnms.kpiquery.service.KpiQueryService;
import jakarta.servlet.http.HttpServletResponse;
import lombok.RequiredArgsConstructor;
import org.springframework.format.annotation.DateTimeFormat;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.io.IOException;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;

@RestController
@RequestMapping("/api/v1/kpi")
@RequiredArgsConstructor
public class KpiController {

    private final KpiQueryService queryService;
    private final KpiExportService exportService;

    // ── Device KPI ─────────────────────────────────────────────────

    @GetMapping("/devices/{deviceId}")
    public ResponseEntity<List<KpiAggregate>> getDeviceKpi(
            @PathVariable String deviceId,
            @RequestParam(defaultValue = "15MIN") String granularity,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) Instant from,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) Instant to,
            @RequestParam(required = false) List<String> metrics) {
        Instant start = from != null ? from : Instant.now().minus(24, ChronoUnit.HOURS);
        Instant end = to != null ? to : Instant.now();
        return ResponseEntity.ok(queryService.queryDevice(deviceId, granularity, start, end, metrics));
    }

    @GetMapping("/devices/{deviceId}/metrics")
    public ResponseEntity<List<KpiAggregate>> getDeviceMetrics(
            @PathVariable String deviceId,
            @RequestParam List<String> metrics,
            @RequestParam(defaultValue = "15MIN") String granularity,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) Instant from,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) Instant to) {
        Instant start = from != null ? from : Instant.now().minus(24, ChronoUnit.HOURS);
        Instant end = to != null ? to : Instant.now();
        return ResponseEntity.ok(queryService.queryDevice(deviceId, granularity, start, end, metrics));
    }

    @GetMapping("/network/{networkId}")
    public ResponseEntity<List<KpiAggregate>> getNetworkKpi(
            @PathVariable String networkId,
            @RequestParam(defaultValue = "1HOUR") String granularity,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) Instant from,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) Instant to) {
        Instant start = from != null ? from : Instant.now().minus(24, ChronoUnit.HOURS);
        Instant end = to != null ? to : Instant.now();
        return ResponseEntity.ok(queryService.queryByNetwork(networkId, granularity, start, end));
    }

    @GetMapping("/organization/{orgId}")
    public ResponseEntity<List<KpiAggregate>> getOrgKpi(
            @PathVariable String orgId,
            @RequestParam(defaultValue = "DAILY") String granularity,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) Instant from,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) Instant to) {
        Instant start = from != null ? from : Instant.now().minus(7, ChronoUnit.DAYS);
        Instant end = to != null ? to : Instant.now();
        return ResponseEntity.ok(queryService.queryByOrganization(orgId, granularity, start, end));
    }

    // ── Threshold management ───────────────────────────────────────

    @PostMapping("/thresholds")
    public ResponseEntity<KpiThreshold> createThreshold(@RequestBody KpiThreshold threshold) {
        return ResponseEntity.ok(queryService.createThreshold(threshold));
    }

    @GetMapping("/thresholds")
    public ResponseEntity<List<KpiThreshold>> listThresholds() {
        return ResponseEntity.ok(queryService.listThresholds());
    }

    @PutMapping("/thresholds/{id}")
    public ResponseEntity<KpiThreshold> updateThreshold(
            @PathVariable String id, @RequestBody KpiThreshold patch) {
        return ResponseEntity.ok(queryService.updateThreshold(id, patch));
    }

    @DeleteMapping("/thresholds/{id}")
    public ResponseEntity<Void> deleteThreshold(@PathVariable String id) {
        queryService.deleteThreshold(id);
        return ResponseEntity.noContent().build();
    }

    // ── Export ─────────────────────────────────────────────────────

    @GetMapping("/export")
    public void export(
            @RequestParam String deviceId,
            @RequestParam(defaultValue = "csv") String format,
            @RequestParam(defaultValue = "15MIN") String granularity,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) Instant from,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) Instant to,
            @RequestParam(required = false) List<String> metrics,
            HttpServletResponse response) throws IOException {
        Instant start = from != null ? from : Instant.now().minus(24, ChronoUnit.HOURS);
        Instant end = to != null ? to : Instant.now();
        List<KpiAggregate> data = queryService.queryDevice(deviceId, granularity, start, end, null);
        if ("xls".equalsIgnoreCase(format)) {
            exportService.exportXls(data, metrics, response);
        } else {
            exportService.exportCsv(data, metrics, response);
        }
    }
}
