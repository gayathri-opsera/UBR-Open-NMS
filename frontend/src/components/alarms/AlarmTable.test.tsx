import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AlarmTable } from '../../components/alarms/AlarmTable';
import { MOCK_ALARMS } from '../../mocks/alarms.mock';

describe('AlarmTable', () => {
  const onAck = vi.fn();

  beforeEach(() => vi.clearAllMocks());

  it('renders alarm rows', () => {
    render(<AlarmTable alarms={MOCK_ALARMS} onAcknowledge={onAck} />);
    expect(screen.getByText('Link Down')).toBeInTheDocument();
    expect(screen.getByText('CPE-001')).toBeInTheDocument();
  });

  it('shows empty state when no alarms', () => {
    render(<AlarmTable alarms={[]} onAcknowledge={onAck} />);
    expect(screen.getByText(/no alarms matching/i)).toBeInTheDocument();
  });

  it('color-codes severity badge', () => {
    render(<AlarmTable alarms={MOCK_ALARMS} onAcknowledge={onAck} />);
    expect(screen.getByText('CRITICAL')).toBeInTheDocument();
    expect(screen.getByText('MAJOR')).toBeInTheDocument();
    expect(screen.getByText('WARNING')).toBeInTheDocument();
    expect(screen.getByText('CLEAR')).toBeInTheDocument();
  });

  it('calls onAcknowledge with alarm id when Ack clicked', () => {
    render(<AlarmTable alarms={MOCK_ALARMS} onAcknowledge={onAck} />);
    // Only ACTIVE alarms have Ack button
    const ackBtns = screen.getAllByText('Ack');
    expect(ackBtns.length).toBe(2); // a1 and a2 are ACTIVE
    fireEvent.click(ackBtns[0]);
    expect(onAck).toHaveBeenCalledWith('a1');
  });

  it('does not show Ack button for acknowledged alarm', () => {
    render(<AlarmTable alarms={MOCK_ALARMS} onAcknowledge={onAck} />);
    // a3 is ACKNOWLEDGED — no Ack button for it
    const ackBtns = screen.getAllByText('Ack');
    expect(ackBtns.length).toBe(2);
  });
});
