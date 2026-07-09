import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AlarmFilterPanel } from '../../components/alarms/AlarmFilterPanel';

describe('AlarmFilterPanel', () => {
  const onChange = vi.fn();

  beforeEach(() => vi.clearAllMocks());

  it('renders severity buttons', () => {
    render(<AlarmFilterPanel filter={{}} onChange={onChange} />);
    expect(screen.getByText('CRITICAL')).toBeInTheDocument();
    expect(screen.getByText('MAJOR')).toBeInTheDocument();
  });

  it('calls onChange with severity when button clicked', () => {
    render(<AlarmFilterPanel filter={{}} onChange={onChange} />);
    fireEvent.click(screen.getByText('CRITICAL'));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ severity: ['CRITICAL'] }),
    );
  });

  it('removes severity when already selected and clicked again', () => {
    render(<AlarmFilterPanel filter={{ severity: ['CRITICAL'] }} onChange={onChange} />);
    fireEvent.click(screen.getByText('CRITICAL'));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ severity: undefined }),
    );
  });

  it('clears all filters when Clear clicked', () => {
    render(<AlarmFilterPanel filter={{ severity: ['MAJOR'], networkId: 'net-1' }} onChange={onChange} />);
    fireEvent.click(screen.getByText('✕ Clear'));
    expect(onChange).toHaveBeenCalledWith({});
  });
});
