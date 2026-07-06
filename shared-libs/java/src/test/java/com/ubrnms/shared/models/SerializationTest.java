package com.ubrnms.shared.models;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.Arrays;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

class SerializationTest {

    private ObjectMapper mapper;

    @BeforeEach
    void setUp() {
        mapper = new ObjectMapper();
        mapper.registerModule(new JavaTimeModule());
        mapper.disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS);
    }

    @Test
    void deviceEntity_roundTrip() throws Exception {
        DeviceEntity device = new DeviceEntity();
        device.setDeviceId("dev-001");
        device.setSerialNumber("SN-BTS-001");
        device.setMacAddress("AA:BB:CC:DD:EE:01");
        device.setIpAddress("192.168.1.10");
        device.setDeviceType(DeviceEntity.DeviceType.BTS);
        device.setModel("Senao ENH1750EXT");
        device.setFirmwareVersion("v3.2.1");
        device.setRegion("NORTH");
        device.setLatitude(28.6139);
        device.setLongitude(77.2090);
        device.setStatus(DeviceEntity.DeviceStatus.online);
        device.setUptimeSeconds(86400L);
        device.setTags(Arrays.asList(new DeviceTag("site", "SITE-01")));
        device.setCreatedAt(Instant.parse("2024-01-15T10:00:00Z"));

        String json = mapper.writeValueAsString(device);
        assertNotNull(json);
        assertTrue(json.contains("\"deviceId\":\"dev-001\""));
        assertTrue(json.contains("\"deviceType\":\"BTS\""));

        DeviceEntity restored = mapper.readValue(json, DeviceEntity.class);
        assertEquals("dev-001", restored.getDeviceId());
        assertEquals("SN-BTS-001", restored.getSerialNumber());
        assertEquals(DeviceEntity.DeviceType.BTS, restored.getDeviceType());
        assertEquals(DeviceEntity.DeviceStatus.online, restored.getStatus());
        assertEquals(1, restored.getTags().size());
        assertEquals("site", restored.getTags().get(0).getKey());
    }

    @Test
    void alarmRecord_roundTrip() throws Exception {
        AlarmRecord alarm = new AlarmRecord();
        alarm.setAlarmId("alarm-uuid-001");
        alarm.setDeviceId("dev-001");
        alarm.setDeviceType("BTS");
        alarm.setAlarmName("LINK_DOWN");
        alarm.setAlarmDescription("Ethernet link failure detected");
        alarm.setSeverity(AlarmRecord.Severity.CRITICAL);
        alarm.setState(AlarmRecord.State.RAISED);
        alarm.setCorrelationGroup("LINK-GROUP-1");
        alarm.setAcknowledged(false);
        alarm.setRaisedAt(Instant.parse("2024-01-15T14:30:00Z"));

        String json = mapper.writeValueAsString(alarm);
        assertTrue(json.contains("\"severity\":\"CRITICAL\""));
        assertTrue(json.contains("\"state\":\"RAISED\""));

        AlarmRecord restored = mapper.readValue(json, AlarmRecord.class);
        assertEquals("alarm-uuid-001", restored.getAlarmId());
        assertEquals(AlarmRecord.Severity.CRITICAL, restored.getSeverity());
        assertEquals(AlarmRecord.State.RAISED, restored.getState());
        assertFalse(restored.isAcknowledged());
    }

    @Test
    void kpiDataPoint_roundTrip() throws Exception {
        KPIDataPoint kpi = new KPIDataPoint();
        kpi.setDeviceId("dev-001");
        kpi.setSerialNumber("SN-BTS-001");
        kpi.setDeviceType("BTS");
        kpi.setKpiName("channelUtilizationPct");
        kpi.setValue(72.5);
        kpi.setUnit("percent");
        kpi.setPollInterval(300);
        kpi.setTimestamp(Instant.parse("2024-01-15T14:05:00Z"));
        kpi.setGranularity("raw");

        String json = mapper.writeValueAsString(kpi);
        assertTrue(json.contains("\"kpiName\":\"channelUtilizationPct\""));
        assertTrue(json.contains("\"value\":72.5"));

        KPIDataPoint restored = mapper.readValue(json, KPIDataPoint.class);
        assertEquals("dev-001", restored.getDeviceId());
        assertEquals(72.5, restored.getValue(), 0.001);
        assertEquals("raw", restored.getGranularity());
    }

    @Test
    void birthCertificate_roundTrip() throws Exception {
        BirthCertificate bc = new BirthCertificate();
        bc.setSerialNumber("SN-BTS-001");
        bc.setMacAddress("AA:BB:CC:DD:EE:01");
        bc.setModel("Senao ENH1750EXT");
        bc.setDeviceType("BTS");
        bc.setFirmware("v3.2.1");
        bc.setSystemName("BTS-NORTH-01");
        bc.setIpAddress("192.168.1.10");
        bc.setHmacSignature("abc123def456");
        bc.setRegisteredAt(Instant.parse("2024-01-15T09:00:00Z"));

        String json = mapper.writeValueAsString(bc);
        assertTrue(json.contains("\"serialNumber\":\"SN-BTS-001\""));
        assertTrue(json.contains("\"deviceType\":\"BTS\""));

        BirthCertificate restored = mapper.readValue(json, BirthCertificate.class);
        assertEquals("SN-BTS-001", restored.getSerialNumber());
        assertEquals("abc123def456", restored.getHmacSignature());
    }

    @Test
    void unknownFields_areIgnored() throws Exception {
        String json = "{\"deviceId\":\"x\",\"serialNumber\":\"y\",\"macAddress\":\"AA:BB:CC:DD:EE:FF\"," +
                "\"deviceType\":\"CPE\",\"status\":\"online\",\"unknownField\":\"should_be_ignored\"}";
        DeviceEntity device = mapper.readValue(json, DeviceEntity.class);
        assertEquals("x", device.getDeviceId());
        assertEquals(DeviceEntity.DeviceType.CPE, device.getDeviceType());
    }
}
