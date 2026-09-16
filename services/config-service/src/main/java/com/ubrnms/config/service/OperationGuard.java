package com.ubrnms.config.service;

import com.ubrnms.config.model.OperationClass;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Per-device operation concurrency guard (WO-018).
 *
 * Prevents conflicting exclusive device operations (firmware upgrade, config push,
 * reboot, factory reset) from executing simultaneously against the same device.
 * Read-only diagnostic operations are always compatible and are never blocked.
 *
 * In-flight markers are stored in-memory; in a multi-instance deployment these
 * should be backed by Redis or a distributed store. Markers expire automatically
 * after markerTtlSeconds to prevent permanent device lock on service restart.
 */
@Slf4j
@Service
public class OperationGuard {

    /** Marker TTL: releases stale locks if a service restart or crash occurs. */
    @Value("${operation.guard.marker-ttl-seconds:3600}")
    private int markerTtlSeconds;

    /** Tracks one active exclusive operation per device. */
    private final ConcurrentHashMap<String, InFlightMarker> markers = new ConcurrentHashMap<>();

    // ── Public API ──────────────────────────────────────────────────────────────

    /**
     * Attempt to acquire the exclusive operation lock for a device.
     *
     * @param deviceId       device to acquire the lock for
     * @param operationClass the type of operation being acquired
     * @param jobId          the caller's job ID (for idempotent duplicate detection)
     * @param actor          operator/system identity for logging
     * @return {@code Optional.empty()} when acquisition succeeded;
     *         {@code Optional.of(existing)} when an incompatible operation is already in flight
     * @throws IllegalArgumentException when deviceId or operationClass is null
     * @throws GuardUnavailableException when state cannot be verified safely
     */
    public Optional<InFlightMarker> acquire(String deviceId,
                                             OperationClass operationClass,
                                             String jobId,
                                             String actor) {
        if (deviceId == null || deviceId.isBlank()) {
            throw new IllegalArgumentException("deviceId must not be blank");
        }
        if (operationClass == null) {
            throw new IllegalArgumentException("operationClass must not be null");
        }

        // READ_ONLY_DIAGNOSTIC is always allowed; skip guard for compatible operations
        if (!operationClass.isExclusive()) {
            log.debug("Read-only diagnostic allowed without guard: device={}", deviceId);
            return Optional.empty();
        }

        // Reconcile any expired markers before making a guard decision
        reconcileExpired(deviceId);

        // Compute idempotency key so a duplicate submission returns the original marker
        String idempotencyKey = buildIdempotencyKey(deviceId, operationClass, jobId);

        InFlightMarker result = markers.compute(deviceId, (id, existing) -> {
            if (existing != null) {
                // Idempotent duplicate: same caller already holds the lock
                if (idempotencyKey.equals(existing.idempotencyKey)) {
                    log.debug("Idempotent duplicate acquire: device={} job={}", deviceId, jobId);
                    return existing;
                }
                // Compatible operation check
                if (existing.operationClass.isCompatibleWith(operationClass)) {
                    log.debug("Compatible operation allowed: device={} existing={} new={}",
                            deviceId, existing.operationClass, operationClass);
                    return existing; // allow, but caller does not hold exclusive lock
                }
                // Conflict: existing exclusive operation is in flight
                return existing; // reject — caller checks if returned marker != their job
            }
            // No existing marker — acquire the lock
            InFlightMarker marker = new InFlightMarker(
                    UUID.randomUUID().toString(), deviceId, operationClass,
                    jobId, actor, idempotencyKey, Instant.now(),
                    Instant.now().plusSeconds(markerTtlSeconds));
            log.info("Operation lock acquired: device={} class={} job={} actor={}",
                    deviceId, operationClass, jobId, actor);
            return marker;
        });

        // If the marker in the map belongs to this caller, lock was acquired (or idempotent)
        if (idempotencyKey.equals(result.idempotencyKey)) {
            return Optional.empty(); // success
        }
        // Another operation holds the lock
        log.warn("Operation blocked: device={} blocked by class={} job={}",
                deviceId, result.operationClass, result.jobId);
        return Optional.of(result);
    }

    /**
     * Release the operation lock for a device.
     * No-op when the caller's jobId does not match the current holder (safe to call on terminal state).
     */
    public void release(String deviceId, String jobId) {
        if (deviceId == null || jobId == null) return;
        markers.computeIfPresent(deviceId, (id, existing) -> {
            if (jobId.equals(existing.jobId)) {
                log.info("Operation lock released: device={} class={} job={}",
                        deviceId, existing.operationClass, jobId);
                return null; // removes the entry
            }
            return existing; // different holder; don't release
        });
    }

    /**
     * Returns the current in-flight marker for a device, if any.
     * Expired markers are removed before returning.
     */
    public Optional<InFlightMarker> getCurrent(String deviceId) {
        reconcileExpired(deviceId);
        return Optional.ofNullable(markers.get(deviceId));
    }

    // ── Private helpers ─────────────────────────────────────────────────────────

    private void reconcileExpired(String deviceId) {
        markers.computeIfPresent(deviceId, (id, existing) -> {
            if (Instant.now().isAfter(existing.expiresAt)) {
                log.warn("Releasing stale operation marker: device={} class={} job={} expiredAt={}",
                        deviceId, existing.operationClass, existing.jobId, existing.expiresAt);
                return null;
            }
            return existing;
        });
    }

    private static String buildIdempotencyKey(String deviceId, OperationClass cls, String jobId) {
        // Key is device + class + jobId; jobId provides caller identity
        return deviceId + ":" + cls.name() + ":" + (jobId != null ? jobId : "no-job");
    }

    // ── Domain model ────────────────────────────────────────────────────────────

    /**
     * An in-flight operation marker tracking the active exclusive operation on a device.
     */
    public static final class InFlightMarker {
        public final String markerId;
        public final String deviceId;
        public final OperationClass operationClass;
        public final String jobId;
        public final String actor;
        public final String idempotencyKey;
        public final Instant acquiredAt;
        public final Instant expiresAt;

        public InFlightMarker(String markerId, String deviceId, OperationClass operationClass,
                               String jobId, String actor, String idempotencyKey,
                               Instant acquiredAt, Instant expiresAt) {
            this.markerId       = markerId;
            this.deviceId       = deviceId;
            this.operationClass = operationClass;
            this.jobId          = jobId;
            this.actor          = actor;
            this.idempotencyKey = idempotencyKey;
            this.acquiredAt     = acquiredAt;
            this.expiresAt      = expiresAt;
        }
    }

    /**
     * Thrown when the operation guard cannot safely verify device state.
     * Callers must treat this as a 503 and must not proceed with dispatch.
     */
    public static class GuardUnavailableException extends RuntimeException {
        public GuardUnavailableException(String message) {
            super(message);
        }
    }

    /**
     * Thrown when a conflicting exclusive operation is already in flight.
     * Callers must return 409 OPERATION_IN_FLIGHT to the operator.
     */
    public static class OperationInFlightException extends RuntimeException {
        public final InFlightMarker existingMarker;

        public OperationInFlightException(InFlightMarker existingMarker) {
            super("Device " + existingMarker.deviceId + " already has an in-flight " +
                  existingMarker.operationClass + " operation (job=" + existingMarker.jobId + ")");
            this.existingMarker = existingMarker;
        }
    }
}
