package com.ubrnms.alarm.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.ubrnms.alarm.model.Alarm;
import com.ubrnms.alarm.model.AlarmThreshold;
import com.ubrnms.alarm.model.FrameworkThresholdEvaluationRequest;
import com.ubrnms.alarm.repository.AlarmRepository;
import com.ubrnms.alarm.repository.AlarmThresholdRepository;
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
import java.util.stream.Collectors;

@Slf4j
@Service
@RequiredArgsConstructor
public class AlarmService {

    private final AlarmRepository alarmRepo;
    private final AlarmThresholdRepository thresholdRepo;
    private final KafkaTemplate<String, String> kafkaTemplate;
    private final ObjectMapper objectMapper;
    private final MeterRegistry meterRegistry;

    @Value("${alarm.dedup.window-minutes:5}")
    private int dedupWindowMinutes;

    @Value("${kafka.topics.processed-alarms:processed-alarms}")
    private String processedAlarmsTopic;

    @Value("${kafka.topics.netcool-alarms-forward:netcool-alarms-forward}")
    private String netcoolTopic;

    /**
     * Main pipeline: dedup → correlate → persist → publish.
     * Returns null if the event was deduplicated.
     */
    public Alarm processRawAlarm(Map<String, Object> raw) {
        Timer.Sample sample = Timer.start(meterRegistry);
        try {
            Alarm alarm = mapRawToAlarm(raw);

            // Handle CLEAR events: find and clear active alarm with same alarmId
            if ("CLEAR".equalsIgnoreCase((String) raw.get("state"))) {
                return handleClear(alarm);
            }

            // Deduplication
            Instant windowStart = Instant.now().minus(dedupWindowMinutes, ChronoUnit.MINUTES);
            Optional<Alarm> existing = alarmRepo
                    .findTopByDeviceIdAndAlarmTypeAndStateAndDedupWindowStartAfterOrderByRaisedAtDesc(
                            alarm.getDeviceId(), alarm.getAlarmType(), "ACTIVE", windowStart);

            if (existing.isPresent()) {
                Alarm dup = existing.get();
                dup.setDedupCount(dup.getDedupCount() + 1);
                log.debug("Deduplicated alarm for device={} type={}", alarm.getDeviceId(), alarm.getAlarmType());
                return alarmRepo.save(dup);
            }

            // Correlation: check if parent is also alarming
            alarm = correlate(alarm);

            // Persist
            alarm.setTtlExpiry(Instant.now().plus(7, ChronoUnit.DAYS));
            alarm = alarmRepo.save(alarm);

            // Publish to processed-alarms
            publish(processedAlarmsTopic, alarm.getAlarmType(), alarm);

            // Publish Netcool format
            publishNetcool(alarm);

            return alarm;
        } finally {
            sample.stop(meterRegistry.timer("alarm.processing.latency"));
        }
    }

    /**
     * Evaluate threshold rules against a metric value.
     */
    public Optional<Alarm> evaluateThreshold(String deviceId, String deviceType,
                                              String parameter, double value) {
        List<AlarmThreshold> rules = new ArrayList<>();
        rules.addAll(thresholdRepo.findByDeviceIdAndEnabledTrue(deviceId));
        rules.addAll(thresholdRepo.findByDeviceTypeAndDeviceIdIsNullAndEnabledTrue(deviceType));

        for (AlarmThreshold rule : rules) {
            if (!rule.getParameter().equalsIgnoreCase(parameter)) continue;

            if (value >= rule.getRaiseThreshold()) {
                Alarm alarm = new Alarm();
                alarm.setAlarmId(UUID.randomUUID().toString());
                alarm.setDeviceId(deviceId);
                alarm.setDeviceType(deviceType);
                alarm.setAlarmType(rule.getAlarmType());
                alarm.setAlarmName(parameter + " threshold breached");
                alarm.setSeverity(rule.getSeverity());
                alarm.setState("ACTIVE");
                alarm.setMetricValue(value);
                alarm.setThreshold(rule.getRaiseThreshold());
                alarm.setSource("THRESHOLD");
                alarm.setRaisedAt(Instant.now());
                alarm.setDedupWindowStart(Instant.now());
                alarm.setDescription(String.format("%s=%.2f exceeded threshold=%.2f",
                        parameter, value, rule.getRaiseThreshold()));
                return Optional.of(processRawAlarm(objectMapper.convertValue(alarm, Map.class)));
            }
        }
        return Optional.empty();
    }

    // ── WO-013: Framework metadata threshold evaluation ───────────────────────────

    /**
     * Evaluate a fresh, numeric framework parameter value against the high and low
     * thresholds declared in its Product Definition metadata.
     *
     * <p>This method is additive — it does not replace or affect the existing
     * repository-backed {@link #evaluateThreshold} path. Only callers that have
     * already coerced a numeric value and confirmed freshness should invoke this.
     *
     * <p>Behaviour:
     * <ul>
     *   <li>If {@code request.getThresholdHigh()} is non-null and
     *       {@code valueNumeric >= thresholdHigh}, a THRESHOLD_HIGH alarm is raised.</li>
     *   <li>If {@code request.getThresholdLow()} is non-null and
     *       {@code valueNumeric <= thresholdLow}, a THRESHOLD_LOW alarm is raised.</li>
     *   <li>If neither condition is met, or both thresholds are null, the method
     *       returns {@link Optional#empty()} — no alarm is raised.</li>
     *   <li>Deduplication is delegated to {@link #processRawAlarm} using the
     *       same window-based logic as existing alarm sources.</li>
     * </ul>
     *
     * <p>Security: this method must never log, store, or propagate credential
     * references. The {@code correlationId} from the request is the only
     * tracking identifier that flows into the alarm record.
     *
     * @param request fully-populated threshold evaluation request (non-null)
     * @return the raised or deduplicated alarm, or {@link Optional#empty()} if no threshold was breached
     */
    public Optional<Alarm> evaluateFrameworkThreshold(FrameworkThresholdEvaluationRequest request) {
        if (request == null) {
            log.warn("evaluateFrameworkThreshold called with null request — skipping");
            return Optional.empty();
        }

        double value = request.getValueNumeric();

        // High threshold evaluation
        if (request.getThresholdHigh() != null && value >= request.getThresholdHigh()) {
            return Optional.of(raiseFrameworkThresholdAlarm(request, "HIGH", request.getThresholdHigh()));
        }

        // Low threshold evaluation
        if (request.getThresholdLow() != null && value <= request.getThresholdLow()) {
            return Optional.of(raiseFrameworkThresholdAlarm(request, "LOW", request.getThresholdLow()));
        }

        // Value is within range — no alarm raised.
        log.debug("Framework threshold evaluation: in-range for deviceId={} parameterId={} value={}",
                request.getDeviceId(), request.getParameterId(), value);
        return Optional.empty();
    }

    /**
     * Build and process a single framework threshold alarm.
     * Uses the same processRawAlarm lifecycle (dedup, correlate, persist, publish)
     * as all other alarm sources.
     */
    private Alarm raiseFrameworkThresholdAlarm(
            FrameworkThresholdEvaluationRequest request,
            String condition,      // "HIGH" or "LOW"
            double breachedThreshold) {

        String alarmType = "FRAMEWORK_THRESHOLD_" + condition + "_" + request.getParameterId().toUpperCase();

        Alarm alarm = new Alarm();
        alarm.setAlarmId(UUID.randomUUID().toString());
        alarm.setDeviceId(request.getDeviceId());
        alarm.setDeviceType(request.getDeviceType() != null ? request.getDeviceType() : "UNKNOWN");
        alarm.setAlarmType(alarmType);
        alarm.setAlarmName(request.getParameterId() + " threshold " + condition.toLowerCase() + " breached");
        // Framework threshold alarms default to MAJOR severity — a future story can
        // add per-parameter severity metadata to the Product Definition spec.
        alarm.setSeverity("MAJOR");
        alarm.setState("ACTIVE");
        alarm.setSource("THRESHOLD");
        alarm.setMetricValue(request.getValueNumeric());
        alarm.setThreshold(breachedThreshold);
        alarm.setRaisedAt(request.getCollectedAt() != null ? request.getCollectedAt() : Instant.now());
        alarm.setDedupWindowStart(Instant.now());
        alarm.setDescription(String.format(
                "Framework parameter %s=%s=%.4f breached %s threshold=%.4f (pd=%s registry=%s)",
                request.getGroupId(), request.getParameterId(),
                request.getValueNumeric(), condition, breachedThreshold,
                request.getProductDefinitionId(), request.getRegistryVersion()));
        alarm.setCorrelationId(request.getCorrelationId());
        alarm.setCategory("THRESHOLD");
        alarm.setSourceSystem("FRAMEWORK_POLLER");
        alarm.setSchemaVersion("2.0");

        // Framework-specific fields (WO-013 additions to Alarm model)
        alarm.setProductDefinitionId(request.getProductDefinitionId());
        alarm.setRegistryVersion(request.getRegistryVersion());
        alarm.setGroupId(request.getGroupId());
        alarm.setParameterId(request.getParameterId());
        alarm.setObservedValue(request.getValueNumeric());
        alarm.setThresholdValue(breachedThreshold);
        alarm.setThresholdCondition(condition);

        log.info("Raising framework threshold alarm: deviceId={} parameterId={} condition={} value={} threshold={} correlationId={}",
                request.getDeviceId(), request.getParameterId(), condition,
                request.getValueNumeric(), breachedThreshold, request.getCorrelationId());

        return processRawAlarm(objectMapper.convertValue(alarm, Map.class));
    }

    public Alarm acknowledge(String id, String actor) {
        return alarmRepo.findById(id).map(alarm -> {
            alarm.setState("ACKNOWLEDGED");
            alarm.setAcknowledgedBy(actor);
            alarm.setAcknowledgedAt(Instant.now());
            return alarmRepo.save(alarm);
        }).orElseThrow(() -> new NoSuchElementException("Alarm not found: " + id));
    }

    public List<Alarm> queryAlarms(String severity, String deviceId, String networkId,
                                    Instant from, Instant to) {
        if (from != null && to != null) return alarmRepo.findByTimeRange(from, to);
        if (deviceId != null) return alarmRepo.findByDeviceIdAndStateOrderByRaisedAtDesc(deviceId, "ACTIVE");
        if (networkId != null) return alarmRepo.findByNetworkIdOrderByRaisedAtDesc(networkId);
        if (severity != null) return alarmRepo.findBySeverityAndStateOrderByRaisedAtDesc(severity, "ACTIVE");
        return alarmRepo.findByStateOrderByRaisedAtDesc("ACTIVE");
    }

    public Map<String, Long> getAlarmTypeCounts(Instant from, Instant to) {
        return alarmRepo.findByRaisedAtBetween(from, to).stream()
                .collect(Collectors.groupingBy(Alarm::getAlarmType, Collectors.counting()));
    }

    public List<Map.Entry<String, Long>> getTopReported(Instant from, Instant to, int limit) {
        return alarmRepo.findByRaisedAtBetween(from, to).stream()
                .collect(Collectors.groupingBy(Alarm::getAlarmType, Collectors.counting()))
                .entrySet().stream()
                .sorted(Map.Entry.<String, Long>comparingByValue().reversed())
                .limit(limit)
                .collect(Collectors.toList());
    }

    public AlarmThreshold saveThreshold(AlarmThreshold threshold) {
        return thresholdRepo.save(threshold);
    }

    public List<AlarmThreshold> listThresholds() {
        return thresholdRepo.findByEnabledTrue();
    }

    // ── private helpers ──────────────────────────────────────────────

    private Alarm handleClear(Alarm clearEvent) {
        return alarmRepo.findByAlarmId(clearEvent.getAlarmId()).map(existing -> {
            existing.setState("CLEARED");
            existing.setClearedAt(Instant.now());
            Alarm saved = alarmRepo.save(existing);
            publish(processedAlarmsTopic, saved.getAlarmType(), saved);
            publishNetcool(saved);
            return saved;
        }).orElse(null);
    }

    private Alarm correlate(Alarm alarm) {
        // If the alarming device has a parent BTS also in ACTIVE alarm state,
        // mark child as correlated to parent's root-cause alarm.
        // Parent-child device IDs are resolved via deviceId naming convention or explicit field.
        String parentId = (String) alarm.getRawData().get("parentDeviceId");
        if (parentId != null) {
            alarmRepo.findByDeviceIdAndStateOrderByRaisedAtDesc(parentId, "ACTIVE").stream()
                    .findFirst()
                    .ifPresent(parentAlarm -> {
                        if (parentAlarm.isRootCause()) {
                            alarm.setRootCauseAlarmId(parentAlarm.getAlarmId());
                            alarm.setRootCause(false);
                            parentAlarm.setCorrelatedChildCount(parentAlarm.getCorrelatedChildCount() + 1);
                            alarmRepo.save(parentAlarm);
                        }
                    });
        }
        if (alarm.getRootCauseAlarmId() == null) {
            alarm.setRootCause(true);
        }
        return alarm;
    }

    private Alarm mapRawToAlarm(Map<String, Object> raw) {
        Alarm alarm = new Alarm();
        alarm.setAlarmId(getStr(raw, "alarmId", UUID.randomUUID().toString()));
        alarm.setDeviceId(getStr(raw, "deviceId", "unknown"));
        alarm.setDeviceType(getStr(raw, "deviceType", "UNKNOWN"));
        alarm.setAlarmType(getStr(raw, "alarmType", "GENERIC"));
        alarm.setAlarmName(getStr(raw, "alarmName", alarm.getAlarmType()));

        // Map severity — reject unrecognised values with INDETERMINATE to prevent partial records.
        String rawSeverity = getStr(raw, "severity", null);
        alarm.setSeverity(normalizeSeverity(rawSeverity));

        alarm.setState("ACTIVE");
        alarm.setDescription(getStr(raw, "description", ""));
        alarm.setSource(getStr(raw, "source", "SNMP"));
        alarm.setNetworkId(getStr(raw, "networkId", null));
        alarm.setOrganizationId(getStr(raw, "organizationId", null));
        alarm.setRaisedAt(Instant.now());
        alarm.setDedupWindowStart(Instant.now());
        alarm.setRawData(raw);

        // WO-051: Normalize classification metadata after basic fields are populated.
        normalizeClassification(alarm, raw);
        return alarm;
    }

    /**
     * Maps a raw severity string to one of the known severity values.
     * Malformed or unrecognised values produce INDETERMINATE so the record is still
     * persisted without crashing the pipeline.
     */
    private String normalizeSeverity(String raw) {
        if (raw == null || raw.isBlank()) return "WARNING";
        return switch (raw.toUpperCase()) {
            case "CRITICAL", "MAJOR", "MINOR", "WARNING", "INFO", "INDETERMINATE" -> raw.toUpperCase();
            default -> {
                log.warn("Unrecognised severity value — defaulting to INDETERMINATE");
                yield "INDETERMINATE";
            }
        };
    }

    /**
     * Derives and sets unified classification metadata on an already-mapped Alarm.
     *
     * <p>WO-051: Called from {@link #mapRawToAlarm} so that every persisted alarm
     * carries a stable category, sourceSystem, schemaVersion, eventId, idempotencyKey,
     * correlationId, classificationReason, and evidenceContext.
     *
     * <p>SECURITY: evidenceContext must never include certificate material, HMAC
     * signatures, nonces, per-device secrets, or raw request bodies.
     */
    private void normalizeClassification(Alarm alarm, Map<String, Object> raw) {
        alarm.setSchemaVersion("2.0");

        // eventId — prefer caller-supplied value; fall back to alarmId.
        String eventId = getStr(raw, "eventId", alarm.getAlarmId());
        alarm.setEventId(eventId);

        // sourceSystem — explicit field takes precedence over derived value.
        String sourceSystem = deriveSourceSystem(raw);
        alarm.setSourceSystem(sourceSystem);

        // idempotencyKey — stable composite key for cross-session dedup.
        alarm.setIdempotencyKey(alarm.getDeviceId() + ":" + alarm.getAlarmType() + ":" + sourceSystem);

        // correlationId — propagated from raw event for log tracing.
        alarm.setCorrelationId(getStr(raw, "correlationId", null));

        // category + classificationReason — derived from source and alarmType.
        ClassificationResult classification = deriveCategory(alarm, raw);
        alarm.setCategory(classification.category());
        alarm.setClassificationReason(classification.reason());

        // evidenceContext — non-sensitive diagnostic fields only.
        Map<String, Object> ctx = new LinkedHashMap<>();
        if (alarm.getCorrelationId() != null) ctx.put("correlationId", alarm.getCorrelationId());
        if (alarm.getDeviceType() != null)    ctx.put("deviceType", alarm.getDeviceType());
        if (alarm.getAlarmType() != null)     ctx.put("alarmType", alarm.getAlarmType());
        if (alarm.getNetworkId() != null)     ctx.put("networkId", alarm.getNetworkId());
        alarm.setEvidenceContext(ctx.isEmpty() ? null : ctx);
    }

    /** Internal DTO carrying category name and reason for classificationReason field. */
    private record ClassificationResult(String category, String reason) {}

    /**
     * Derives the alarm category from source field and alarmType.
     * Safe defaults ensure every alarm gets a valid category even with incomplete source data.
     */
    private ClassificationResult deriveCategory(Alarm alarm, Map<String, Object> raw) {
        // Use the raw source field to distinguish "not provided" from the "SNMP" default
        // set in mapRawToAlarm. This ensures FALLBACK_DEFAULT fires when source is absent.
        String rawSource = getStr(raw, "source", null);
        String source    = rawSource != null ? rawSource : alarm.getSource();
        String alarmType = alarm.getAlarmType() != null ? alarm.getAlarmType() : "";

        if ("SOUTHBOUND".equalsIgnoreCase(source)
                || alarmType.startsWith("SOUTHBOUND_AUTH")
                || alarmType.startsWith("SOUTHBOUND_MTLS")) {
            return new ClassificationResult("SECURITY", "source=SOUTHBOUND mapped to SECURITY");
        }
        if ("THRESHOLD".equalsIgnoreCase(source)) {
            return new ClassificationResult("THRESHOLD", "source=THRESHOLD mapped to THRESHOLD");
        }
        if ("SELF_HEALTH".equalsIgnoreCase(source)) {
            return new ClassificationResult("LIFECYCLE", "source=SELF_HEALTH mapped to LIFECYCLE");
        }
        if (alarmType.contains("BOOTSTRAP") || alarmType.contains("DISCOVERY")
                || alarmType.contains("ONBOARD")) {
            return new ClassificationResult("DISCOVERY", "alarmType matches DISCOVERY pattern");
        }
        if (alarmType.contains("CONFIG")) {
            return new ClassificationResult("CONFIG", "alarmType matches CONFIG pattern");
        }
        if (rawSource == null || rawSource.isBlank()) {
            return new ClassificationResult("FAULT", "FALLBACK_DEFAULT");
        }
        return new ClassificationResult("FAULT", "source=" + source + " defaulted to FAULT");
    }

    /**
     * Derives the sourceSystem identifier from raw event fields.
     * Maps known source type strings to canonical source system names.
     */
    private String deriveSourceSystem(Map<String, Object> raw) {
        String explicit = getStr(raw, "sourceSystem", null);
        if (explicit != null && !explicit.isBlank()) return explicit;
        String source = getStr(raw, "source", "UNKNOWN");
        return switch (source.toUpperCase()) {
            case "SNMP"       -> "SNMP_POLLER";
            case "SYSLOG"     -> "SYSLOG_COLLECTOR";
            case "THRESHOLD"  -> "THRESHOLD_ENGINE";
            case "SELF_HEALTH"-> "SELF_HEALTH_MONITOR";
            case "SOUTHBOUND" -> "DISCOVERY_SERVICE";
            default           -> "UNKNOWN";
        };
    }

    @SuppressWarnings("unchecked")
    private void publish(String topic, String key, Alarm alarm) {
        try {
            kafkaTemplate.send(topic, key, objectMapper.writeValueAsString(alarm));
        } catch (Exception e) {
            log.error("Failed to publish alarm to {}", topic, e);
        }
    }

    private void publishNetcool(Alarm alarm) {
        try {
            Map<String, Object> netcool = new LinkedHashMap<>();
            netcool.put("alarmId", alarm.getAlarmId());
            netcool.put("alarmName", alarm.getAlarmName());
            netcool.put("severity", alarm.getSeverity());
            netcool.put("alarmDescription", alarm.getDescription());
            netcool.put("state", alarm.getState());
            netcool.put("Time", alarm.getRaisedAt() != null ? alarm.getRaisedAt().toString() : "");
            // WO-051: include schemaVersion and correlationId for northbound consumer compatibility.
            netcool.put("schemaVersion", alarm.getSchemaVersion() != null ? alarm.getSchemaVersion() : "1.0");
            if (alarm.getCorrelationId() != null) netcool.put("correlationId", alarm.getCorrelationId());
            netcool.put("data", Map.of(
                    "deviceType", alarm.getDeviceType(),
                    "deviceId", alarm.getDeviceId()
            ));
            kafkaTemplate.send(netcoolTopic, alarm.getAlarmType(),
                    objectMapper.writeValueAsString(netcool));
        } catch (Exception e) {
            log.error("Failed to publish Netcool alarm", e);
        }
    }

    private String getStr(Map<String, Object> m, String key, String def) {
        Object v = m.get(key);
        return v != null ? v.toString() : def;
    }

    /**
     * Handle southbound security alarm events published by the discovery service (WO-005).
     *
     * These events originate from the southbound error catalog (auth failures, HMAC failures,
     * mTLS errors) and must be stored as ACTIVE alarms for NOC visibility.
     *
     * SECURITY: device serial is the only identity field in the event; no credentials,
     * signatures, or keys are present in a well-formed SouthboundErrorEvent.
     *
     * Supported errorCategory values that are routed here:
     *   - auth_failure  → SOUTHBOUND_AUTH_FAILURE alarm type
     *   - retryable     → SOUTHBOUND_RETRYABLE_ERROR (info/warning only)
     *   - server_error  → SOUTHBOUND_SERVER_ERROR
     *
     * @param event map representation of a SouthboundErrorEvent Kafka message
     * @return the persisted Alarm, or null if deduplication suppressed it
     */
    public Alarm processSouthboundErrorEvent(Map<String, Object> event) {
        String errorCategory = getStr(event, "errorCategory", "server_error");
        String errorReason   = getStr(event, "errorReason", "UNKNOWN");
        String deviceSerial  = getStr(event, "deviceSerial", "unknown");
        String correlationId = getStr(event, "correlationId", UUID.randomUUID().toString());
        int    httpStatus    = event.get("httpStatus") instanceof Number
                               ? ((Number) event.get("httpStatus")).intValue() : 500;

        String alarmType;
        String severity;
        switch (errorCategory) {
            case "auth_failure":
                alarmType = "SOUTHBOUND_AUTH_FAILURE";
                severity  = "CRITICAL";
                break;
            case "retryable":
                alarmType = "SOUTHBOUND_RETRYABLE_ERROR";
                severity  = "WARNING";
                break;
            default:
                alarmType = "SOUTHBOUND_SERVER_ERROR";
                severity  = "MAJOR";
        }

        // Build a raw alarm map that routes through the standard pipeline
        Map<String, Object> raw = new LinkedHashMap<>();
        raw.put("alarmId",      correlationId);
        raw.put("deviceId",     deviceSerial);
        raw.put("deviceType",   "UNKNOWN");
        raw.put("alarmType",    alarmType);
        raw.put("alarmName",    errorReason + " on southbound interface");
        raw.put("severity",     severity);
        raw.put("description",  String.format(
                "Southbound error: reason=%s category=%s httpStatus=%d correlationId=%s",
                errorReason, errorCategory, httpStatus, correlationId));
        raw.put("source",       "SOUTHBOUND");
        // Propagate correlation ID for log tracing — no secret data
        raw.put("correlationId", correlationId);

        log.info("Processing southbound error event: reason={} category={} correlationId={}",
                 errorReason, errorCategory, correlationId);
        return processRawAlarm(raw);
    }
}
