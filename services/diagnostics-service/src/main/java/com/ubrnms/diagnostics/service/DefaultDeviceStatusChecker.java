package com.ubrnms.diagnostics.service;

import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.stereotype.Component;

import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/** Default in-memory device status checker — replace with inventory HTTP client in production. */
@Component
@ConditionalOnMissingBean(value = DeviceStatusChecker.class, ignored = DefaultDeviceStatusChecker.class)
public class DefaultDeviceStatusChecker implements DeviceStatusChecker {

    private final Set<String> onlineDevices = ConcurrentHashMap.newKeySet();

    public void markOnline(String id)  { onlineDevices.add(id); }
    public void markOffline(String id) { onlineDevices.remove(id); }

    @Override
    public boolean isOnline(String deviceId) {
        return onlineDevices.contains(deviceId);
    }
}
