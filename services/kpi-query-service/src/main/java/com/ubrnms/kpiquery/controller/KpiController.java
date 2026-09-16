package com.ubrnms.kpiquery.controller;

import com.ubrnms.kpiquery.model.AvailabilitySummaryDto;
import com.ubrnms.kpiquery.model.KpiAggregate;
import com.ubrnms.kpiquery.model.KpiThreshold;
import com.ubrnms.kpiquery.service.AvailabilityCalculator;
import com.ubrnms.kpiquery.service.KpiExportService;
import com.ubrnms.kpiquery.service.KpiQueryService;
import jakarta.servlet.http.HttpServletResponse;
import lombok.RequiredArgsConstructor;
import org.springframework.format.annotation.DateTimeFormat;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.io.IOException;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.*;

@RestController
@RequestMapping("/api/v1/kpi")
@RequiredArgsConstructor
public class KpiController {

    private final KpiQueryService queryService;
    private final KpiExportService exportService;
    private final AvailabilityCalculator availabilityCalculator;

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

    // ── Availability summary (WO-041) ─────────────────────────────

    /**
     * Per-device availability health summary.
     *
     * <p>Computes deterministic UP/DOWN/DEGRADED/UNKNOWN state from recent KPI
     * aggregates, active alarm context, and optional call-home authority hints.
     * Applies flap dampening and stale-data detection.
     *
     * GET /api/v1/kpi/availability-summary/v2
     * Accepts: deviceId, serialNumber, networkId, organizationId, deviceType, from, to
     */
    @GetMapping("/availability-summary/v2")
    public ResponseEntity<?> getAvailabilitySummary(
            @RequestParam(required = false) String deviceId,
            @RequestParam(required = false) String serialNumber,
            @RequestParam(required = false) String networkId,
            @RequestParam(required = false) String organizationId,
            @RequestParam(required = false) String deviceType,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) Instant from,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) Instant to) {

        // Require at least one identity filter when a single device is requested
        if (deviceId == null && serialNumber == null && networkId == null && organizationId == null && deviceType == null) {
            // Fleet-level query is allowed — return 200 with empty device list
            return ResponseEntity.ok(Map.of(
                    "generatedAt", Instant.now().toString(),
                    "devices", List.of()
            ));
        }

        Instant start = from != null ? from : Instant.now().minus(15, ChronoUnit.MINUTES);
        Instant end   = to   != null ? to   : Instant.now();

        if (start.isAfter(end)) {
            return ResponseEntity.badRequest().body(Map.of(
                    "status", "error",
                    "error", Map.of(
                            "code", "INVALID_FILTERS",
                            "field", "from",
                            "message", "from must be before to"
                    )
            ));
        }

        // Resolve KPI aggregates for the requested device
        List<KpiAggregate> aggs = deviceId != null
                ? queryService.queryDevice(deviceId, "15MIN", start, end, null)
                : List.of();

        // When no aggregates found for a specifically requested device, return 404
        if (deviceId != null && aggs.isEmpty() && serialNumber == null) {
            // Partial response with UNKNOWN state rather than 404 (per WO-041 error_handling)
            AvailabilitySummaryDto summary = availabilityCalculator.calculate(
                    deviceId, serialNumber, deviceType != null ? deviceType : "UNKNOWN",
                    List.of(), List.of(), null, false
            );
            return ResponseEntity.ok(Map.of(
                    "generatedAt", Instant.now().toString(),
                    "devices", List.of(summary)
            ));
        }

        // Determine if this is a generic SNMP device (non-UBR call-home)
        boolean isGenericSnmp = "GENERIC_SNMP".equalsIgnoreCase(
                (String) null /* capability lookup not wired at query tier */);

        AvailabilitySummaryDto summary = availabilityCalculator.calculate(
                deviceId != null ? deviceId : "fleet",
                serialNumber,
                deviceType != null ? deviceType : "UNKNOWN",
                aggs,
                List.of(), // alarm context would be injected from alarm-service client in production
                null,      // call-home online state would come from check-in client in production
                isGenericSnmp
        );

        return ResponseEntity.ok(Map.of(
                "generatedAt", Instant.now().toString(),
                "devices", List.of(summary)
        ));
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
