package com.ubrnms.config.controller;

import com.ubrnms.config.model.ConfigVersion;
import com.ubrnms.config.model.PendingCommand;
import com.ubrnms.config.service.ConfigService;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/v1/devices")
@RequiredArgsConstructor
public class DeviceConfigController {

    private final ConfigService configService;

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
}
