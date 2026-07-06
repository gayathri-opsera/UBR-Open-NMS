package com.ubrnms.inventory.repository.hierarchy;

import com.ubrnms.inventory.model.hierarchy.Organization;
import org.springframework.data.mongodb.repository.MongoRepository;
public interface OrganizationRepository extends MongoRepository<Organization, String> {}
