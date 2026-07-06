import { useEffect, useRef, useState } from 'react';
import type { Alarm } from '../api/alarms.types';
import { createSseClient } from '../utils/sse';

export function useAlarmSse(onAlarm: (alarm: Alarm) => void): { connected: boolean } {
  const [connected, setConnected] = useState(false);
  const cbRef = useRef(onAlarm);
  cbRef.current = onAlarm;

  useEffect(() => {
    const sub = createSseClient(
      '/api/v1/notifications/stream',
      (event) => {
        try {
          const alarm: Alarm = JSON.parse(event.data);
          cbRef.current(alarm);
          setConnected(true);
        } catch {
          // malformed event — skip
        }
      },
      () => setConnected(false),
    );
    return () => sub.close();
  }, []);

  return { connected };
}
