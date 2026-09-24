package com.ubrnms.alarm.controller;

import com.ubrnms.alarm.model.Alarm;
import com.ubrnms.alarm.model.AlarmThreshold;
import com.ubrnms.alarm.model.FrameworkThresholdEvaluationRequest;
import com.ubrnms.alarm.model.FrameworkDriftEvaluationRequest;
import com.ubrnms.alarm.service.AlarmService;
import com.ubrnms.alarm.service.ExportService;
import jakarta.servlet.http.HttpServletResponse;
import lombok.RequiredArgsConstructor;
import org.springframework.format.annotation.DateTimeFormat;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.io.IOException;
import java.time.Instant;
import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/v1/alarms")
@RequiredArgsConstructor
public class AlarmController {

    private final AlarmService alarmService;
    private final ExportService exportService;

    @GetMapping
    public ResponseEntity<List<Alarm>> getAlarms(
            @RequestParam(required = false) String severity,
            @RequestParam(required = false) String deviceId,
            @RequestParam(required = false) String networkId,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) Instant from,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) Instant to) {
        return ResponseEntity.ok(alarmService.queryAlarms(severity, deviceId, networkId, from, to));
    }

    @GetMapping("/top-reported")
    public ResponseEntity<List<Map.Entry<String, Long>>> topReported(
            @RequestParam @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) Instant from,
            @RequestParam @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) Instant to,
            @RequestParam(defaultValue = "10") int limit) {
        return ResponseEntity.ok(alarmService.getTopReported(from, to, limit));
    }

    @GetMapping("/type-counts")
    public ResponseEntity<Map<String, Long>> typeCounts(
            @RequestParam @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) Instant from,
            @RequestParam @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) Instant to) {
        return ResponseEntity.ok(alarmService.getAlarmTypeCounts(from, to));
    }

    @PutMapping("/{id}/acknowledge")
    public ResponseEntity<Alarm> acknowledge(
            @PathVariable String id,
            @RequestParam String actor) {
        return ResponseEntity.ok(alarmService.acknowledge(id, actor));
    }

    @GetMapping("/export")
    public void export(
            @RequestParam(defaultValue = "csv") String format,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) Instant from,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) Instant to,
            HttpServletResponse response) throws IOException {
        Instant start = from != null ? from : Instant.now().minusSeconds(86400);
        Instant end = to != null ? to : Instant.now();
        List<Alarm> alarms = alarmService.queryAlarms(null, null, null, start, end);
        if ("xls".equalsIgnoreCase(format)) {
            exportService.exportXls(alarms, response);
        } else {
            exportService.exportCsv(alarms, response);
        }
    }

    @PostMapping("/thresholds")
    public ResponseEntity<AlarmThreshold> createThreshold(@RequestBody AlarmThreshold threshold) {
        return ResponseEntity.ok(alarmService.saveThreshold(threshold));
    }

    @GetMapping("/thresholds")
    public ResponseEntity<List<AlarmThreshold>> listThresholds() {
        return ResponseEntity.ok(alarmService.listThresholds());
    }

    @PostMapping("/ingest")
    public ResponseEntity<Alarm> ingest(@RequestBody Map<String, Object> raw) {
        Alarm result = alarmService.processRawAlarm(raw);
        return result != null ? ResponseEntity.ok(result) : ResponseEntity.noContent().build();
    }

    /**
     * Framework parameter threshold evaluation endpoint.
     *
     * <p>Called by the parameter poller after each poll cycle when a parameter value
     * crosses a threshold defined in the active Product Definition.  The alarm service
     * evaluates the breach, deduplicates within the configured window, and raises a
     * FRAMEWORK_THRESHOLD alarm when required.
     *
     * <p>Returns 200 with the raised alarm when a new alarm was created, or 204 when
     * the event was deduplicated (no new alarm raised).
     */
    @PostMapping("/framework-threshold/evaluate")
    public ResponseEntity<Alarm> evaluateFrameworkThreshold(
            @RequestBody FrameworkThresholdEvaluationRequest request) {
        return alarmService.evaluateFrameworkThreshold(request)
                .map(ResponseEntity::ok)
                .orElseGet(() -> ResponseEntity.noContent().build());
    }

    /**
     * POST /api/v1/alarms/framework-drift/evaluate
     *
     * <p>Evaluates whether a polled parameter value violates the schema-declared
     * min/max bounds from the active Product Definition registry. Raises a
     * FRAMEWORK_DRIFT alarm when the value is out of range, and clears it when
     * the value returns within bounds.
     *
     * <p>Called by the parameter-poller service after each successful poll cycle
     * for parameters with schema-declared min/max constraints and no operational
     * threshold configured.
     *
     * @return 200 with the raised/updated alarm, or 204 when no alarm action was taken.
     */
    @PostMapping("/framework-drift/evaluate")
    public ResponseEntity<Alarm> evaluateFrameworkDrift(
            @RequestBody FrameworkDriftEvaluationRequest request) {
        return alarmService.evaluateFrameworkDrift(request)
                .map(ResponseEntity::ok)
                .orElseGet(() -> ResponseEntity.noContent().build());
    }
}
