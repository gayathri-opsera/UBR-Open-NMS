package com.ubrnms.config.service;

import org.springframework.stereotype.Service;

/**
 * Default implementation of DeviceEligibilityChecker (WO-033).
 * Always returns null (eligible) for local dev/test environments.
 * Production deployments should replace this with an HTTP client that queries the inventory service.
 */
@Service
public class DefaultDeviceEligibilityChecker implements DeviceEligibilityChecker {

    @Override
    public IneligibilityReason checkEligibility(String deviceId) {
        // Default: all devices are eligible (no assignment gate enforcement)
        // Production implementation would check inventory service for assignment status
        return null;
    }
}
