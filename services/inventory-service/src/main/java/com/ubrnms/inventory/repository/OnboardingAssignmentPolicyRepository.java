package com.ubrnms.inventory.repository;

import com.ubrnms.inventory.model.OnboardingAssignmentPolicy;
import org.springframework.data.mongodb.repository.MongoRepository;

import java.util.Optional;

/** Repository for the onboarding assignment gate policy document (WO-033). */
public interface OnboardingAssignmentPolicyRepository
        extends MongoRepository<OnboardingAssignmentPolicy, String> {

    Optional<OnboardingAssignmentPolicy> findByPolicyKey(String policyKey);
}
