// WO-055: Add Alarm Escalation Rules
package com.ubr.nms.alarm.escalation;

import org.springframework.stereotype.Service;
import org.springframework.scheduling.annotation.Scheduled;
import java.time.Duration;
import java.time.Instant;
import java.util.*;

@Service
public class EscalationService {
    private final List<EscalationRule> rules = new ArrayList<>();

    public EscalationService() {
        // Initialize default rules
        rules.add(new EscalationRule("CRITICAL_UNACKED_15MIN", "CRITICAL",
                                      Duration.ofMinutes(15), false, "MAJOR_TO_CRITICAL"));
        rules.add(new EscalationRule("MAJOR_UNACKED_30MIN", "MAJOR",
                                      Duration.ofMinutes(30), false, "MINOR_TO_MAJOR"));
    }

    @Scheduled(fixedRate = 60000) // Run every minute
    public void evaluateEscalations() {
        // Query unacknowledged alarms
        // Check against escalation rules
        // Escalate if conditions met
    }

    public boolean shouldEscalate(Alarm alarm) {
        for (EscalationRule rule : rules) {
            if (matchesRule(alarm, rule)) {
                return true;
            }
        }
        return false;
    }

    private boolean matchesRule(Alarm alarm, EscalationRule rule) {
        if (!alarm.getSeverity().equals(rule.getSeverity())) {
            return false;
        }
        if (rule.isRequiresUnacknowledged() && alarm.isAcknowledged()) {
            return false;
        }
        Duration alarmAge = Duration.between(alarm.getRaisedAt(), Instant.now());
        return alarmAge.compareTo(rule.getAgeThreshold()) >= 0;
    }

    public void escalateAlarm(String alarmId, String newSeverity, String reason) {
        // Update alarm severity
        // Record escalation in history
        // Trigger notifications
    }
}

class EscalationRule {
    private String ruleId;
    private String severity;
    private Duration ageThreshold;
    private boolean requiresUnacknowledged;
    private String escalationAction;

    public EscalationRule(String ruleId, String severity, Duration ageThreshold,
                         boolean requiresUnacknowledged, String escalationAction) {
        this.ruleId = ruleId;
        this.severity = severity;
        this.ageThreshold = ageThreshold;
        this.requiresUnacknowledged = requiresUnacknowledged;
        this.escalationAction = escalationAction;
    }

    // Getters
    public String getRuleId() { return ruleId; }
    public String getSeverity() { return severity; }
    public Duration getAgeThreshold() { return ageThreshold; }
    public boolean isRequiresUnacknowledged() { return requiresUnacknowledged; }
    public String getEscalationAction() { return escalationAction; }
}

class Alarm {
    private String alarmId;
    private String severity;
    private Instant raisedAt;
    private boolean acknowledged;

    // Getters
    public String getAlarmId() { return alarmId; }
    public String getSeverity() { return severity; }
    public Instant getRaisedAt() { return raisedAt; }
    public boolean isAcknowledged() { return acknowledged; }
}
