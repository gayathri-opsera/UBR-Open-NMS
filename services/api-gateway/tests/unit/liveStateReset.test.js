'use strict';
/**
 * A device re-provisioned at a new address must not keep reporting the poll outcome of its old
 * address ("UNREACHABLE") while its first poll runs; a healthy document for the same address stays.
 */

const mockStore = new Map(); // _id → live-values doc
const mockCol = {
  findOne: jest.fn(async (f) => mockStore.get(f._id) || null),
  deleteOne: jest.fn(async (f) => { mockStore.delete(f._id); }),
};

jest.mock('mongoose', () => ({
  ...jest.requireActual('mongoose'),
  connection: { readyState: 1, db: { collection: () => mockCol }, client: { db: () => ({ collection: () => mockCol }) } },
}));

const { resetStaleLiveState } = require('../../src/live/liveParameters');

describe('resetStaleLiveState', () => {
  beforeEach(() => { mockStore.clear(); jest.clearAllMocks(); });

  test('removes an UNREACHABLE outcome left by the previous address', async () => {
    mockStore.set('SN-1', { _id: 'SN-1', ipAddress: '10.0.150.88', pollStatus: 'UNREACHABLE' });
    expect(await resetStaleLiveState({ _id: 'SN-1', ipAddress: '10.0.150.6' })).toBe(true);
    expect(mockStore.has('SN-1')).toBe(false);
  });

  test('removes an OK document that was collected from a different address', async () => {
    mockStore.set('SN-1', { _id: 'SN-1', ipAddress: '10.0.150.88', pollStatus: 'OK' });
    expect(await resetStaleLiveState({ _id: 'SN-1', ipAddress: '10.0.150.6' })).toBe(true);
  });

  test('removes a failed outcome even for the same address (the next poll decides)', async () => {
    mockStore.set('SN-1', { _id: 'SN-1', ipAddress: '10.0.150.6', pollStatus: 'ERROR' });
    expect(await resetStaleLiveState({ _id: 'SN-1', ipAddress: '10.0.150.6' })).toBe(true);
  });

  test('keeps a healthy document for the same address so its values stay visible', async () => {
    mockStore.set('SN-1', { _id: 'SN-1', ipAddress: '10.0.150.6', pollStatus: 'OK' });
    expect(await resetStaleLiveState({ _id: 'SN-1', ipAddress: '10.0.150.6' })).toBe(false);
    expect(mockStore.has('SN-1')).toBe(true);
  });

  test('nothing to reset when the device was never polled', async () => {
    expect(await resetStaleLiveState({ _id: 'SN-1', ipAddress: '10.0.150.6' })).toBe(false);
    expect(mockCol.deleteOne).not.toHaveBeenCalled();
  });
});
