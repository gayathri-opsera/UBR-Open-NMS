package com.ubrnms.config.repository;

import com.ubrnms.config.model.PendingCommand;
import org.springframework.data.mongodb.repository.MongoRepository;
import java.time.Instant;
import java.util.List;

public interface PendingCommandRepository extends MongoRepository<PendingCommand, String> {
    List<PendingCommand> findByDeviceIdAndStatusOrderByCreatedAtAsc(String deviceId, String status);
    List<PendingCommand> findByJobIdAndStatus(String jobId, String status);
    List<PendingCommand> findByStatusAndExpiresAtBefore(String status, Instant now);
    long countByDeviceIdAndStatus(String deviceId, String status);
}
