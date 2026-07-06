package com.ubrnms.config.repository;

import com.ubrnms.config.model.ConfigJob;
import org.springframework.data.mongodb.repository.MongoRepository;

public interface ConfigJobRepository extends MongoRepository<ConfigJob, String> {
}
