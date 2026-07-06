package com.ubrnms.topology.repository;

import com.ubrnms.topology.model.TopologyNode;
import org.springframework.data.mongodb.repository.MongoRepository;
import org.springframework.data.mongodb.repository.Query;

import java.util.List;
import java.util.Optional;

public interface TopologyNodeRepository extends MongoRepository<TopologyNode, String> {
    Optional<TopologyNode> findByDeviceId(String deviceId);
    Optional<TopologyNode> findBySerialNumber(String serialNumber);
    Optional<TopologyNode> findByMacAddress(String mac);
    Optional<TopologyNode> findByIpAddress(String ip);

    List<TopologyNode> findByNetworkId(String networkId);
    List<TopologyNode> findByParentDeviceId(String parentDeviceId);

    @Query("{ 'location': { $near: { $geometry: { type: 'Point', coordinates: [?0, ?1] }, $maxDistance: ?2 } } }")
    List<TopologyNode> findNearLocation(double lon, double lat, double maxMetres);
}
