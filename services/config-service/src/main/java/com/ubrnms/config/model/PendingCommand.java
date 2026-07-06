package com.ubrnms.config.model;

import lombok.Data;
import lombok.NoArgsConstructor;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.index.CompoundIndex;
import org.springframework.data.mongodb.core.index.Indexed;
import org.springframework.data.mongodb.core.mapping.Document;

import java.time.Instant;
import java.util.Map;

/** Pending configuration command queued for an offline device. */
@Data
@NoArgsConstructor
@Document(collection = "pending_commands")
@CompoundIndex(def = "{'deviceId': 1, 'status': 1}")
public class PendingCommand {
    @Id
    private String id;
    private String deviceId;
    private String commandType;   // CONFIG_PUSH, FIRMWARE_UPGRADE, BULK_CONFIG
    private String templateId;
    private Map<String, Object> params;
    private String status;        // PENDING, DELIVERED, EXPIRED, FAILED
    private String jobId;         // set for bulk operations

    @Indexed(expireAfterSeconds = 259200) // 72-hour TTL
    private Instant expiresAt;
    private Instant createdAt;
    private Instant deliveredAt;
    private String actor;
}
