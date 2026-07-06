package com.ubrnms.inventory.repository;

import com.ubrnms.inventory.model.Device;
import org.springframework.data.mongodb.repository.MongoRepository;
import org.springframework.data.mongodb.repository.Query;

import java.util.List;
import java.util.Optional;

public interface DeviceRepository extends MongoRepository<Device, String> {

    Optional<Device> findBySerialNumber(String serialNumber);
    Optional<Device> findByMacAddress(String macAddress);
    Optional<Device> findByIpAddress(String ipAddress);

    @Query("{ 'location': { $near: { $geometry: { type: 'Point', coordinates: [?0, ?1] }, $maxDistance: ?2 } } }")
    List<Device> findNearLocation(double longitude, double latitude, double maxDistanceMetres);
}
