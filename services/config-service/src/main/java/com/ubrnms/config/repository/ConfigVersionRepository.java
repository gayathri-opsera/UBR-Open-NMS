package com.ubrnms.config.repository;

import com.ubrnms.config.model.ConfigVersion;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.mongodb.repository.MongoRepository;

import java.util.List;
import java.util.Optional;

/** WO-050: Paginated configuration version history repository. */
public interface ConfigVersionRepository extends MongoRepository<ConfigVersion, String> {

    List<ConfigVersion> findByDeviceIdOrderByVersionNumberDesc(String deviceId);

    /** Paginated history for a device, newest first (WO-050). */
    Page<ConfigVersion> findByDeviceIdOrderByAppliedAtDesc(String deviceId, Pageable pageable);

    int countByDeviceId(String deviceId);

    /** Idempotency check — prevents duplicate versions for the same job result callback. */
    Optional<ConfigVersion> findByDeviceIdAndIdempotencyKey(String deviceId, String idempotencyKey);
}
