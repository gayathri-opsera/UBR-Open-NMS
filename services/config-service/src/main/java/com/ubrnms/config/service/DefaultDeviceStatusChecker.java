package com.ubrnms.config.service;

import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.stereotype.Component;

import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Default implementation of DeviceStatusChecker backed by an in-memory set.
 * Replace with an inventory service HTTP client in production.
 */
@Component
@ConditionalOnMissingBean(value = DeviceStatusChecker.class, ignored = DefaultDeviceStatusChecker.class)
public class DefaultDeviceStatusChecker implements DeviceStatusChecker {

    private final Set<String> onlineDevices = ConcurrentHashMap.newKeySet();

    public void markOnline(String deviceId) { onlineDevices.add(deviceId); }
    public void markOffline(String deviceId) { onlineDevices.remove(deviceId); }

    @Override
    public boolean isOnline(String deviceId) {
        return onlineDevices.contains(deviceId);
    }
}
