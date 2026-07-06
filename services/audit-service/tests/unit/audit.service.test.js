'use strict';

// Isolate mongoose model from real DB
jest.mock('../../src/models/audit-entry.model');

const AuditEntry = require('../../src/models/audit-entry.model');
const { ingestEvent, queryLogs, exportLogs } = require('../../src/services/audit.service');

const mockEntry = {
  _id: 'mock-id-001',
  actor: 'user1',
  action: 'LOGIN',
  resource: 'auth',
  result: 'SUCCESS',
  timestamp: new Date(),
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('ingestEvent', () => {
  it('persists a valid audit event', async () => {
    const saveMock = jest.fn().mockResolvedValue(mockEntry);
    AuditEntry.mockImplementation(() => ({ save: saveMock, ...mockEntry }));

    const result = await ingestEvent({ actor: 'user1', action: 'LOGIN', resource: 'auth', result: 'SUCCESS' });
    expect(saveMock).toHaveBeenCalledTimes(1);
    expect(result.actor).toBe('user1');
  });

  it('throws when required fields are missing', async () => {
    await expect(ingestEvent({ actor: 'user1' })).rejects.toThrow('Missing required audit event fields');
  });
});

describe('queryLogs', () => {
  it('queries with filters', async () => {
    const mockFind = {
      sort: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([mockEntry]),
    };
    AuditEntry.find = jest.fn().mockReturnValue(mockFind);
    AuditEntry.countDocuments = jest.fn().mockResolvedValue(1);

    const result = await queryLogs({ actor: 'user1', offset: 0, limit: 10 });
    expect(result.data).toHaveLength(1);
    expect(result.pagination.total).toBe(1);
    expect(AuditEntry.find).toHaveBeenCalledWith(expect.objectContaining({ actor: 'user1' }));
  });

  it('applies time range filter when provided', async () => {
    const mockFind = {
      sort: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([]),
    };
    AuditEntry.find = jest.fn().mockReturnValue(mockFind);
    AuditEntry.countDocuments = jest.fn().mockResolvedValue(0);

    await queryLogs({ startTime: '2024-01-01', endTime: '2024-12-31' });
    expect(AuditEntry.find).toHaveBeenCalledWith(
      expect.objectContaining({ timestamp: expect.objectContaining({ $gte: expect.any(Date) }) })
    );
  });
});

describe('exportLogs', () => {
  it('returns records for export', async () => {
    const mockFind = {
      sort: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([mockEntry]),
    };
    AuditEntry.find = jest.fn().mockReturnValue(mockFind);

    const records = await exportLogs({ actor: 'user1' }, 100);
    expect(records).toHaveLength(1);
    expect(records[0].actor).toBe('user1');
  });
});
