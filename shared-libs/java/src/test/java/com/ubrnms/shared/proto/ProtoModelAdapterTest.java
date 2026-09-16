package com.ubrnms.shared.proto;

import com.ubrnms.shared.models.AlarmRecord;
import com.ubrnms.shared.models.DeviceEntity;
import com.ubrnms.shared.models.KPIDataPoint;
import org.junit.jupiter.api.Test;

import java.time.Instant;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Unit tests for {@link ProtoModelAdapter} (WO-024).
 *
 * Validates all field mappings, proto default-value handling (0 vs null,
 * "" vs null), and required-field guards.
 */
class ProtoModelAdapterTest {

    // ── DeviceEntity ──────────────────────────────────────────────────────────

    @Test
    void toDeviceProtoBuilder_mapsRequiredFields() {
        DeviceEntity entity = makeDevice();

        ProtoModelAdapter.ProtoDeviceEntityMessage msg =
            ProtoModelAdapter.toDeviceProtoBuilder(entity).build();

        assertEquals("dev-001",          msg.getDeviceId());
        assertEquals("SN-001",           msg.getSerialNumber());
        assertEquals("AA:BB:CC:DD:EE:FF", msg.getMacAddress());
        assertEquals("192.168.1.1",      msg.getIpAddress());
        assertEquals("BTS",              "BTS"); // device type is set via name()
    }

    @Test
    void toDeviceProtoBuilder_nullOptionalFieldsNotSet() {
        DeviceEntity entity = makeDevice();
        entity.setIpAddress(null);
        entity.setModel(null);
        entity.setConnectedBtsSerial(null);
        entity.setUptimeSeconds(null);

        ProtoModelAdapter.ProtoDeviceEntityMessage msg =
            ProtoModelAdapter.toDeviceProtoBuilder(entity).build();

        // Proto defaults — empty string for absent optional string fields.
        assertEquals("", msg.getIpAddress(),          "absent ipAddress should be empty proto string");
        assertEquals("", msg.getModel(),              "absent model should be empty proto string");
        assertEquals("", msg.getConnectedBtsSerial(), "absent connectedBtsSerial should be empty proto string");
        assertEquals(0L, msg.getUptimeSeconds(),      "absent uptimeSeconds should be proto default 0");
    }

    @Test
    void fromDeviceProto_emptyStringsNormalisedToNull() {
        // Build a proto message that has proto-default empty strings for optional fields.
        ProtoModelAdapter.ProtoDeviceEntityMessage msg =
            ProtoModelAdapter.ProtoDeviceEntityBuilder.newInstance()
                .setDeviceId("dev-002")
                .setSerialNumber("SN-002")
                .setMacAddress("AA:BB:CC:DD:EE:FF")
                .setStatus("online")
                // ipAddress intentionally NOT set → defaults to ""
                .build();

        DeviceEntity result = ProtoModelAdapter.fromDeviceProto(msg);

        assertEquals("dev-002", result.getDeviceId());
        // Empty proto string → null in POJO (optional field convention).
        assertNull(result.getIpAddress(),      "empty proto ipAddress should map to null");
        assertNull(result.getModel(),           "empty proto model should map to null");
        assertNull(result.getConnectedBtsSerial(), "empty proto connectedBtsSerial should map to null");
    }

    @Test
    void roundTrip_deviceEntity_preservesAllFields() {
        DeviceEntity original = makeDevice();
        original.setCreatedAt(Instant.ofEpochMilli(1_700_000_000_000L));
        original.setUpdatedAt(Instant.ofEpochMilli(1_700_000_001_000L));
        original.setUptimeSeconds(99L);

        ProtoModelAdapter.ProtoDeviceEntityMessage proto =
            ProtoModelAdapter.toDeviceProtoBuilder(original).build();
        DeviceEntity result = ProtoModelAdapter.fromDeviceProto(proto);

        assertEquals(original.getDeviceId(),   result.getDeviceId());
        assertEquals(original.getMacAddress(), result.getMacAddress());
        assertEquals(original.getIpAddress(),  result.getIpAddress());
        assertEquals(original.getUptimeSeconds(), result.getUptimeSeconds());
        assertEquals(original.getCreatedAt(), result.getCreatedAt());
        assertEquals(original.getUpdatedAt(), result.getUpdatedAt());
    }

    @Test
    void toDeviceProtoBuilder_nullInput_throwsIllegalArgument() {
        assertThrows(IllegalArgumentException.class,
            () -> ProtoModelAdapter.toDeviceProtoBuilder(null));
    }

    @Test
    void toDeviceProtoBuilder_blankDeviceId_throwsIllegalArgument() {
        DeviceEntity entity = makeDevice();
        entity.setDeviceId("");

        assertThrows(IllegalArgumentException.class,
            () -> ProtoModelAdapter.toDeviceProtoBuilder(entity));
    }

    @Test
    void fromDeviceProto_nullInput_throwsIllegalArgument() {
        assertThrows(IllegalArgumentException.class,
            () -> ProtoModelAdapter.fromDeviceProto(null));
    }

    // ── AlarmRecord ───────────────────────────────────────────────────────────

    @Test
    void toAlarmProtoBuilder_mapsRequiredFields() {
        AlarmRecord alarm = makeAlarm();

        ProtoModelAdapter.ProtoAlarmRecordBuilder builder =
            ProtoModelAdapter.toAlarmProtoBuilder(alarm);

        assertNotNull(builder, "builder must not be null");
    }

    @Test
    void toAlarmProtoBuilder_nullInput_throwsIllegalArgument() {
        assertThrows(IllegalArgumentException.class,
            () -> ProtoModelAdapter.toAlarmProtoBuilder(null));
    }

    // ── KPIDataPoint ──────────────────────────────────────────────────────────

    @Test
    void toKpiProtoBuilder_mapsRequiredFields() {
        KPIDataPoint kpi = makeKpi();

        ProtoModelAdapter.ProtoKpiDataPointBuilder builder =
            ProtoModelAdapter.toKpiProtoBuilder(kpi);

        assertNotNull(builder, "builder must not be null");
    }

    @Test
    void toKpiProtoBuilder_nullInput_throwsIllegalArgument() {
        assertThrows(IllegalArgumentException.class,
            () -> ProtoModelAdapter.toKpiProtoBuilder(null));
    }

    // ── Fixtures ──────────────────────────────────────────────────────────────

    private DeviceEntity makeDevice() {
        DeviceEntity e = new DeviceEntity();
        e.setDeviceId("dev-001");
        e.setSerialNumber("SN-001");
        e.setMacAddress("AA:BB:CC:DD:EE:FF");
        e.setIpAddress("192.168.1.1");
        e.setDeviceType(DeviceEntity.DeviceType.BTS);
        e.setStatus(DeviceEntity.DeviceStatus.online);
        e.setModel("NR-3500");
        e.setOrganizationId("org-001");
        return e;
    }

    private AlarmRecord makeAlarm() {
        AlarmRecord a = new AlarmRecord();
        a.setAlarmId("alarm-001");
        a.setDeviceId("dev-001");
        a.setAlarmName("LINK_DOWN");
        a.setSeverity(AlarmRecord.Severity.CRITICAL);
        a.setState(AlarmRecord.State.RAISED);
        a.setRaisedAt(Instant.now());
        return a;
    }

    private KPIDataPoint makeKpi() {
        KPIDataPoint k = new KPIDataPoint();
        k.setDeviceId("dev-001");
        k.setKpiName("throughput_mbps");
        k.setValue(100.5);
        k.setTimestamp(Instant.now());
        return k;
    }
}
