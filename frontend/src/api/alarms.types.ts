export type Severity = 'CRITICAL' | 'MAJOR' | 'MINOR' | 'WARNING' | 'CLEAR' | 'INDETERMINATE';
export type AlarmState = 'ACTIVE' | 'ACKNOWLEDGED' | 'CLEARED';

export interface Alarm {
  id: string;
  alarmId: string;
  deviceId: string;
  deviceType: string;
  alarmName: string;
  alarmType: string;
  severity: Severity;
  state: AlarmState;
  timestamp: string;       // ISO string
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
  severity: Severity;
}

export interface AlarmTypeStat {
  alarmType: string;
  count: number;
}
