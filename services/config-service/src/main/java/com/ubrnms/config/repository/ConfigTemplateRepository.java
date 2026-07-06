package com.ubrnms.config.repository;

import com.ubrnms.config.model.ConfigTemplate;
import org.springframework.data.mongodb.repository.MongoRepository;
import java.util.List;
import java.util.Optional;

public interface ConfigTemplateRepository extends MongoRepository<ConfigTemplate, String> {
    Optional<ConfigTemplate> findByName(String name);
    Optional<ConfigTemplate> findByIsDefaultTrue();
    List<ConfigTemplate> findByDeviceType(String deviceType);
}
