package com.ubrnms.inventory.repository;

import com.ubrnms.inventory.model.CapabilityProfile;
import org.springframework.data.mongodb.repository.MongoRepository;

import java.util.List;
import java.util.Optional;

/**
 * Repository for capability profile lookup and seeding (WO-003).
 */
public interface CapabilityProfileRepository extends MongoRepository<CapabilityProfile, String> {

    Optional<CapabilityProfile> findByProfileId(String profileId);

    Optional<CapabilityProfile> findByDeviceTypeAndDiscoveryParadigm(String deviceType, String discoveryParadigm);

    Optional<CapabilityProfile> findByDiscoveryParadigm(String discoveryParadigm);

    List<CapabilityProfile> findByDiscoveryParadigmIn(List<String> paradigms);
}
