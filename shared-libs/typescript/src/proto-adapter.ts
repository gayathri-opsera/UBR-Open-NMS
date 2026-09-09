/**
 * proto-adapter.ts — TypeScript bridge between existing hand-written interfaces
 * and proto-generated types (WO-024).
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * ts-proto generates types with `useOptionals=all`, meaning all optional fields
 * are typed as `T | undefined` (proto3 absent). The existing hand-written
 * interfaces use `T | null` for some fields. This adapter normalises the
 * differences so consuming services can migrate incrementally.
 *
 * EDGE CASES
 * ----------
 * - `connectedBtsSerial`: proto nullable → TypeScript `string | undefined`;
 *   hand-written model uses `string | null`. Adapter converts undefined ↔ null.
 * - Timestamp fields: proto uses epoch millis (number); hand-written types use
 *   ISO-8601 string. Adapter converts between both representations.
 * - Enum types: ts-proto with `stringEnums=true` generates string-literal union
 *   types identical to the hand-written types — no conversion required.
 *
 * USAGE
 * -----
 * ```typescript
 * import { deviceToProtoJson, deviceFromProtoJson } from '@ubr-nms/shared-models/proto-adapter';
 *
 * // Publish to Kafka (proto-json format)
 * const wire = deviceToProtoJson(device);
 * kafka.publish('device-events', JSON.stringify(wire));
 *
 * // Consume from Kafka
 * const msg: DeviceProtoJson = JSON.parse(kafkaMessage.value);
 * const device = deviceFromProtoJson(msg);
 * ```
 */

import type { DeviceEntity, AlarmRecord, KPIDataPoint, DeviceType, DeviceStatus } from './types/models';

// ── Proto-JSON wire shapes ────────────────────────────────────────────────────
// These mirror the JSON output produced by the Protobuf JSON serialiser.
// ts-proto `onlyTypes=true` will generate these automatically after `npm run proto:generate`.

/** Proto-JSON representation of a DeviceEntity (field names match proto snake_case → camelCase). */
export interface DeviceProtoJson {
  deviceId: string;
  serialNumber: string;
  macAddress: string;
  /** Absent (proto optional string) when not set. */
  ipAddress?: string;
  deviceType?: string;
  model?: string;
  firmwareVersion?: string;
  region?: string;
  status: string;
  uptimeSeconds?: number;
  /** Proto absent when null. */
  connectedBtsSerial?: string;
  connectedCpeCount?: number;
  connectedIduCount?: number;
  organizationId?: string;
  networkId?: string;
  latitude?: number;
  longitude?: number;
  /** Epoch milliseconds; 0 or absent means unset. */
  createdAtMilli?: number;
  updatedAtMilli?: number;
}

export interface AlarmProtoJson {
  alarmId: string;
  deviceId: string;
  alarmName: string;
  alarmDescription?: string;
  severity: string;
  state: string;
  correlationGroup?: string;
  rootCause?: string;
  acknowledged: boolean;
  acknowledgedBy?: string;
  raisedAtMilli: number;
  clearedAtMilli?: number;
}

export interface KpiProtoJson {
  deviceId: string;
  kpiName: string;
  value: number;
  unit?: string;
  granularity?: string;
  timestampMilli: number;
}

// ── DeviceEntity adapters ─────────────────────────────────────────────────────

/**
 * Converts a hand-written {@link DeviceEntity} to the proto-json wire format.
 *
 * - `null` values are converted to `undefined` (proto absent)
 * - ISO-8601 string timestamps are converted to epoch milliseconds
 */
export function deviceToProtoJson(d: DeviceEntity): DeviceProtoJson {
  return {
    deviceId:           d.deviceId,
    serialNumber:       d.serialNumber,
    macAddress:         d.macAddress,
    ipAddress:          d.ipAddress ?? undefined,
    deviceType:         d.deviceType,
    model:              d.model,
    firmwareVersion:    d.firmwareVersion,
    region:             d.region,
    status:             d.status,
    uptimeSeconds:      d.uptimeSeconds,
    // null → undefined (proto absent sentinel)
    connectedBtsSerial: d.connectedBtsSerial ?? undefined,
    connectedCpeCount:  d.connectedCpeCount,
    connectedIduCount:  d.connectedIduCount,
    organizationId:     d.organizationId,
    networkId:          d.networkId,
    latitude:           d.latitude,
    longitude:          d.longitude,
    // ISO string → epoch millis (absent when falsy)
    createdAtMilli:     d.createdAt ? new Date(d.createdAt).getTime() : undefined,
    updatedAtMilli:     d.updatedAt ? new Date(d.updatedAt).getTime() : undefined,
  };
}

/**
 * Converts a proto-json wire message back to the hand-written {@link DeviceEntity}.
 *
 * - `undefined` optional fields are converted to `undefined`/`null` per field convention
 * - Epoch milliseconds are converted to ISO-8601 strings
 */
export function deviceFromProtoJson(m: DeviceProtoJson): DeviceEntity {
  return {
    deviceId:       m.deviceId,
    serialNumber:   m.serialNumber,
    macAddress:     m.macAddress,
    ipAddress:      m.ipAddress,
    deviceType:     (m.deviceType ?? 'BTS') as DeviceType,
    status:         (m.status) as DeviceStatus,
    model:          m.model,
    firmwareVersion: m.firmwareVersion,
    region:         m.region,
    uptimeSeconds:  m.uptimeSeconds,
    // proto absent (undefined) → null (hand-written model convention)
    connectedBtsSerial: m.connectedBtsSerial ?? null,
    connectedCpeCount:  m.connectedCpeCount,
    connectedIduCount:  m.connectedIduCount,
    organizationId:     m.organizationId,
    networkId:          m.networkId,
    latitude:           m.latitude,
    longitude:          m.longitude,
    // epoch millis → ISO string; 0/absent → undefined
    createdAt: m.createdAtMilli ? new Date(m.createdAtMilli).toISOString() : undefined,
    updatedAt: m.updatedAtMilli ? new Date(m.updatedAtMilli).toISOString() : undefined,
  };
}

// ── AlarmRecord adapters ──────────────────────────────────────────────────────

export function alarmToProtoJson(a: AlarmRecord): AlarmProtoJson {
  return {
    alarmId:          a.alarmId,
    deviceId:         a.deviceId,
    alarmName:        a.alarmName,
    alarmDescription: a.alarmDescription,
    severity:         a.severity,
    state:            a.state,
    correlationGroup: a.correlationGroup,
    rootCause:        a.rootCause,
    acknowledged:     a.acknowledged ?? false,
    acknowledgedBy:   a.acknowledgedBy ?? undefined,
    raisedAtMilli:    new Date(a.raisedAt).getTime(),
    clearedAtMilli:   a.clearedAt ? new Date(a.clearedAt).getTime() : undefined,
  };
}
