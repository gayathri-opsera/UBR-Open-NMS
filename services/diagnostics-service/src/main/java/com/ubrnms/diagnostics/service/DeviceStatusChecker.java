package com.ubrnms.diagnostics.service;

/** Interface for checking device online status (injected from inventory cache). */
public interface DeviceStatusChecker {
    boolean isOnline(String deviceId);
}
