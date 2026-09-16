package com.ubrnms.inventory.repository;

import com.ubrnms.inventory.model.DiscoveryModePolicy;
import org.springframework.data.mongodb.repository.MongoRepository;

import java.util.Optional;

/**
 * Repository for discovery mode policy persistence (WO-001).
 */
public interface DiscoveryModePolicyRepository extends MongoRepository<DiscoveryModePolicy, String> {

    Optional<DiscoveryModePolicy> findByMode(String mode);
}
