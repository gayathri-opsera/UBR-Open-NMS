package com.ubrnms.alarm.controller;

import com.ubrnms.alarm.model.Alarm;
import com.ubrnms.alarm.model.AlarmThreshold;
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
}
