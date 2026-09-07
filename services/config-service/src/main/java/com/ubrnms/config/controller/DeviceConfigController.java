package com.ubrnms.config.controller;

import com.ubrnms.config.model.ConfigVersion;
import com.ubrnms.config.model.PendingCommand;
import com.ubrnms.config.service.ConfigService;
import com.ubrnms.config.service.DeviceEligibilityChecker;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/v1/devices")
@RequiredArgsConstructor
public class DeviceConfigController {

    private final ConfigService configService;
    private final DeviceEligibilityChecker deviceEligibilityChecker;

    @GetMapping("/{id}/pending-commands")
    public ResponseEntity<Map<String, Object>> getPendingCommands(@PathVariable String id) {
        List<PendingCommand> commands = configService.getPendingCommands(id);
        return ResponseEntity.ok(Map.of(
                "count", commands.size(),
                "commands", commands
        ));
    }

    @GetMapping("/{id}/config-history")
    public ResponseEntity<List<ConfigVersion>> getConfigHistory(@PathVariable String id) {
        return ResponseEntity.ok(configService.getVersionHistory(id));
    }

    /**
     * Returns the config delivery eligibility state for a device (WO-033).
     * Operators and NOC can use this endpoint to determine whether a device is
     * eligible for config push, or whether delivery is withheld and why.
     */
    @GetMapping("/{id}/onboarding-gate")
    public ResponseEntity<Map<String, Object>> getOnboardingGateState(@PathVariable String id) {
        DeviceEligibilityChecker.IneligibilityReason ineligible =
                deviceEligibilityChecker.checkEligibility(id);

        Map<String, Object> body = new LinkedHashMap<>();
        body.put("deviceId", id);
        body.put("eligible", ineligible == null);
        body.put("withheldReason", ineligible != null ? ineligible.name() : null);
        return ResponseEntity.ok(body);
    }
}
