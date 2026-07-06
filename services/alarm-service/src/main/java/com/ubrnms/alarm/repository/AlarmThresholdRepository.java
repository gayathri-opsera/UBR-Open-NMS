package com.ubrnms.alarm.repository;

import com.ubrnms.alarm.model.AlarmThreshold;
import org.springframework.data.mongodb.repository.MongoRepository;

import java.util.List;

public interface AlarmThresholdRepository extends MongoRepository<AlarmThreshold, String> {
    List<AlarmThreshold> findByEnabledTrue();
    List<AlarmThreshold> findByDeviceIdAndEnabledTrue(String deviceId);
    List<AlarmThreshold> findByDeviceTypeAndDeviceIdIsNullAndEnabledTrue(String deviceType);
}
