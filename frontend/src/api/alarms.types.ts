export type Severity = 'CRITICAL' | 'MAJOR' | 'MINOR' | 'WARNING' | 'CLEAR' | 'INDETERMINATE';
export type AlarmState = 'ACTIVE' | 'ACKNOWLEDGED' | 'CLEARED';

export interface Alarm {
  id: string;
  alarmId: string;
  deviceId: string;
  deviceType: string;
  deviceName?: string;      // human-readable name from inventory (may not always be present)
  serialNumber?: string;    // device serial number (BTS-A60-XXXXXX / CPE-A61-XXXXXX)
  alarmName: string;
  alarmType: string;
  message?: string;         // human-readable alarm description from backend
  description?: string;     // alternate field name used by some backends
  severity: Severity;
  state: AlarmState;
  timestamp: string;        // ISO string — normalised from raisedAt by fetchAlarms
  raisedAt?: string;        // raw backend field (kept for reference)
  clearedAt?: string;
  duration?: string;
  acknowledgedBy?: string;
  networkId?: string;
  organizationId?: string;
  hierarchyId?: string;
  dedupCount?: number;
}

export interface AlarmFilter {
  severity?: Severity[];
  deviceType?: string;
  organizationId?: string;
  hierarchyId?: string;
  networkId?: string;
  from?: string;
  to?: string;
  state?: AlarmState;
}

export interface TopAlarm {
  alarmType: string;
  count: number;
  severity?: Severity;
}

export interface AlarmTypeStat {
  alarmType: string;
  count: number;
}
