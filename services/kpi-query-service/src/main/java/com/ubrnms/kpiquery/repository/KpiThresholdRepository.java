package com.ubrnms.kpiquery.repository;

import com.ubrnms.kpiquery.model.KpiThreshold;
import org.springframework.data.mongodb.repository.MongoRepository;

import java.util.List;

public interface KpiThresholdRepository extends MongoRepository<KpiThreshold, String> {
    List<KpiThreshold> findByEnabledTrue();
    List<KpiThreshold> findByDeviceIdAndEnabledTrue(String deviceId);
    List<KpiThreshold> findByNetworkIdAndEnabledTrue(String networkId);
}
