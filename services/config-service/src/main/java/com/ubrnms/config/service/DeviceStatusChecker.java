package com.ubrnms.config.service;

/**
 * Interface for checking whether a device is currently online.
 * In production this queries the Inventory Service or a device-status cache.
 */
public interface DeviceStatusChecker {
    boolean isOnline(String deviceId);
}
