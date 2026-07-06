package com.ubrnms.inventory.repository.hierarchy;

import com.ubrnms.inventory.model.hierarchy.HierarchyView;
import org.springframework.data.mongodb.repository.MongoRepository;
import java.util.List;
public interface HierarchyViewRepository extends MongoRepository<HierarchyView, String> {
    List<HierarchyView> findByOrganizationId(String organizationId);
}
