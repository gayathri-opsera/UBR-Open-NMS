package com.ubrnms.config.model;

import lombok.Data;
import lombok.NoArgsConstructor;
import org.springframework.data.annotation.Id;
import org.springframework.data.annotation.LastModifiedDate;
import org.springframework.data.mongodb.core.index.Indexed;
import org.springframework.data.mongodb.core.mapping.Document;

import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * A named configuration template supporting all 12 NMS-CF-01 parameter categories.
 * customFields holds admin-defined extra fields; hiddenFields holds keys of built-in
 * fields the admin has hidden for this template.
 */
@Data
@NoArgsConstructor
@Document(collection = "config_templates")
public class ConfigTemplate {
    @Id
    private String id;

    @Indexed(unique = true)
    private String name;
    private String description;
    private String deviceType;   // BTS, CPE, IDU, ALL
    private boolean isDefault;

    // 12 parameter categories (NMS-CF-01)
    private String managementIpType;    // DHCP, STATIC, SLAAC
    private String staticIp;
    private String staticSubnet;
    private String staticGateway;

    private String ssid24;
    private String wpaKey24;
    private String ssid5;
    private String wpaKey5;
    private Integer channel24;
    private Integer channel5;
    private Integer txPower24;
    private Integer txPower5;

    private String speedDuplex;         // Auto, 100Mbps Full, 1000Mbps Full, etc.
    private Boolean ethernetPort0;      // port 0 enabled/disabled
    private Boolean ethernetPort1;      // port 1 enabled/disabled
    private Boolean wifiRestart;
    private Boolean deviceReboot;

    private String firmwareVersion;
    private String firmwareUrl;

    private String vlanMode;            // None, Single, Double
    private Integer vlanId;
    private Integer outerVlanId;
    private Integer vlanPriority;
    private String qosProfile;

    private String snmpCommunity;
    private String ntpServer;
    private String timezone;
    private String logLevel;

    /** Admin-defined custom fields attached to this template schema */
    private List<Map<String, Object>> customFields = new ArrayList<>();

    /** Keys of built-in fields hidden by admin for this template */
    private List<String> hiddenFields = new ArrayList<>();

    /** Free-form additional parameters (catch-all for forward compatibility) */
    private Map<String, Object> additionalParams = new HashMap<>();

    private String createdBy;
    private Instant createdAt;

    @LastModifiedDate
    private Instant updatedAt;
}
