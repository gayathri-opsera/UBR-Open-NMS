package com.ubrnms.inventory.repository.hierarchy;

import com.ubrnms.inventory.model.hierarchy.DevicePreAssignment;
import org.springframework.data.mongodb.repository.MongoRepository;
import java.util.Optional;
public interface PreAssignmentRepository extends MongoRepository<DevicePreAssignment, String> {
    Optional<DevicePreAssignment> findBySerialNumber(String serialNumber);
}
