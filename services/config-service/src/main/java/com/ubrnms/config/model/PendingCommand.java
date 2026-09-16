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

    // ── WO-049: Delivery routing metadata ─────────────────────────────────────
    /**
     * Delivery channel that selected this pending command for UBR call-home delivery.
     * UBR_REALTIME | UBR_CHECKIN
     */
    private String deliveryChannel;

    /** Config version snapshot identifier used when queuing for diff / audit purposes. */
    private String configVersion;

    /** Idempotency key forwarded from the confirmed job for dedup during delivery. */
    private String idempotencyKey;

    /** Whether a realtime force-check-in nudge was sent alongside queuing (WO-049). */
    private boolean realtimeNudgeSent;
}
