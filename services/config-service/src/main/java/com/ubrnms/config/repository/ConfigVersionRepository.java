package com.ubrnms.config.repository;

import com.ubrnms.config.model.ConfigVersion;
import org.springframework.data.mongodb.repository.MongoRepository;
import java.util.List;

public interface ConfigVersionRepository extends MongoRepository<ConfigVersion, String> {
    List<ConfigVersion> findByDeviceIdOrderByVersionNumberDesc(String deviceId);
    int countByDeviceId(String deviceId);
}
