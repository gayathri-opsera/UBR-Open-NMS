import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAlarmSse } from '../hooks/useAlarmSse';
import type { Alarm } from '../api/alarms.types';

// Mock sse utility
vi.mock('../utils/sse', () => ({
  createSseClient: vi.fn(),
}));

import { createSseClient } from '../utils/sse';

describe('useAlarmSse', () => {
  beforeEach(() => vi.clearAllMocks());

  it('calls onAlarm when SSE message received', async () => {
    let capturedHandler: ((event: MessageEvent) => void) | null = null;
    vi.mocked(createSseClient).mockImplementation((_url, onMessage) => {
      capturedHandler = onMessage;
      return { close: vi.fn() };
    });

    const onAlarm = vi.fn();
    renderHook(() => useAlarmSse(onAlarm));

    const alarm: Alarm = {
      id: 'a1', alarmId: 'AL-001', deviceId: 'dev-1', deviceType: 'CPE',
      alarmName: 'Link Down', alarmType: 'LINK_DOWN', severity: 'CRITICAL',
      state: 'ACTIVE', timestamp: new Date().toISOString(),
    };

    act(() => {
      capturedHandler!({ data: JSON.stringify(alarm) } as MessageEvent);
    });

    expect(onAlarm).toHaveBeenCalledWith(alarm);
  });

  it('ignores malformed SSE data', () => {
    let capturedHandler: ((event: MessageEvent) => void) | null = null;
    vi.mocked(createSseClient).mockImplementation((_url, onMessage) => {
      capturedHandler = onMessage;
      return { close: vi.fn() };
    });

    const onAlarm = vi.fn();
    renderHook(() => useAlarmSse(onAlarm));

    act(() => {
      capturedHandler!({ data: 'not-json' } as MessageEvent);
    });

    expect(onAlarm).not.toHaveBeenCalled();
  });

  it('closes SSE on unmount', () => {
    const closeSpy = vi.fn();
    vi.mocked(createSseClient).mockImplementation(() => ({ close: closeSpy }));
    const { unmount } = renderHook(() => useAlarmSse(vi.fn()));
    unmount();
    expect(closeSpy).toHaveBeenCalled();
  });
});
