package com.ubrnms.inventory.repository.hierarchy;

import com.ubrnms.inventory.model.hierarchy.Network;
import org.springframework.data.mongodb.repository.MongoRepository;
import java.util.List;
public interface NetworkRepository extends MongoRepository<Network, String> {
    List<Network> findByHierarchyId(String hierarchyId);
    List<Network> findByOrganizationId(String organizationId);
}
