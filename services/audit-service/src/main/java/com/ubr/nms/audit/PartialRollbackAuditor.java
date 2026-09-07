// WO-057: Audit Operation Partial Rollbacks
package com.ubr.nms.audit;

import org.springframework.stereotype.Service;
import java.time.Instant;
import java.util.*;

@Service
public class PartialRollbackAuditor {

    public void auditPartialRollback(String operationId, String operationType,
                                     List<String> successDevices, List<String> failedDevices,
                                     Map<String, String> failureReasons) {
        PartialRollbackAuditEvent event = new PartialRollbackAuditEvent();
        event.setOperationId(operationId);
        event.setOperationType(operationType);
        event.setTimestamp(Instant.now());
        event.setTotalDevices(successDevices.size() + failedDevices.size());
        event.setSuccessCount(successDevices.size());
        event.setFailureCount(failedDevices.size());
        event.setSuccessDevices(successDevices);
        event.setFailedDevices(failedDevices);
        event.setFailureReasons(failureReasons);

        // Persist to audit collection
        // Emit audit event to Kafka
    }

    public List<PartialRollbackAuditEvent> queryPartialRollbacks(Instant start, Instant end) {
        // Query audit events by type and time range
        return new ArrayList<>();
    }
}

class PartialRollbackAuditEvent {
    private String operationId;
    private String operationType;
    private Instant timestamp;
    private int totalDevices;
    private int successCount;
    private int failureCount;
    private List<String> successDevices;
    private List<String> failedDevices;
    private Map<String, String> failureReasons;

    // Getters/setters
    public String getOperationId() { return operationId; }
    public void setOperationId(String operationId) { this.operationId = operationId; }
    public String getOperationType() { return operationType; }
    public void setOperationType(String operationType) { this.operationType = operationType; }
    public Instant getTimestamp() { return timestamp; }
    public void setTimestamp(Instant timestamp) { this.timestamp = timestamp; }
    public int getTotalDevices() { return totalDevices; }
    public void setTotalDevices(int totalDevices) { this.totalDevices = totalDevices; }
    public int getSuccessCount() { return successCount; }
    public void setSuccessCount(int successCount) { this.successCount = successCount; }
    public int getFailureCount() { return failureCount; }
    public void setFailureCount(int failureCount) { this.failureCount = failureCount; }
    public List<String> getSuccessDevices() { return successDevices; }
    public void setSuccessDevices(List<String> successDevices) { this.successDevices = successDevices; }
    public List<String> getFailedDevices() { return failedDevices; }
    public void setFailedDevices(List<String> failedDevices) { this.failedDevices = failedDevices; }
    public Map<String, String> getFailureReasons() { return failureReasons; }
    public void setFailureReasons(Map<String, String> failureReasons) { this.failureReasons = failureReasons; }
}
