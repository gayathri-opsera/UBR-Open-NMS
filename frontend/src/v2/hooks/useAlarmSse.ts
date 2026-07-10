import { useAlarmSse as useV1AlarmSse } from '../../hooks/useAlarmSse';
import type { Alarm } from '../../api/alarms.types';

export function useAlarmSse(onAlarm: (alarm: Alarm) => void): { connected: boolean } {
  return useV1AlarmSse(onAlarm);
}
