package com.ubrnms.diagnostics.repository;

import com.ubrnms.diagnostics.model.FirmwareJob;
import org.springframework.data.mongodb.repository.MongoRepository;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.Optional;

/**
 * Repository for firmware job persistence (WO-012).
 */
@Repository
public interface FirmwareJobRepository extends MongoRepository<FirmwareJob, String> {

    /**
     * Find all firmware jobs for a device, ordered by acceptance time descending.
     */
    List<FirmwareJob> findByDeviceIdOrderByAcceptedAtDesc(String deviceId);

    /**
     * Find a job by idempotency key (for duplicate prevention).
     */
    Optional<FirmwareJob> findByIdempotencyKey(String idempotencyKey);

    /**
     * Find in-flight jobs for a device (status IN_PROGRESS or PENDING).
     */
    List<FirmwareJob> findByDeviceIdAndStatusIn(String deviceId, List<String> statuses);
}
