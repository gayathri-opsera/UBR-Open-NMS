'use strict';
const { deletePolicy } = require('../../src/live/descriptorDelete');

describe('deletePolicy', () => {
  test('a draft can always be deleted', () => {
    expect(deletePolicy({ status: 'draft', role: 'viewer', linkedDevices: [{ _id: 1 }] })).toEqual({ ok: true });
  });
  test('a published screen that no device uses can be deleted by an admin', () => {
    expect(deletePolicy({ status: 'published', role: 'admin', linkedDevices: [] }).ok).toBe(true);
    expect(deletePolicy({ status: 'published', role: 'Admin' }).ok).toBe(true);
  });
  test('a non-admin cannot delete a published screen', () => {
    const r = deletePolicy({ status: 'published', role: 'operator', linkedDevices: [] });
    expect(r).toMatchObject({ ok: false, http: 403, code: 'FORBIDDEN' });
    expect(deletePolicy({ status: 'published' }).ok).toBe(false);
  });
  test('a published screen still used by a device is refused, and names the devices', () => {
    const r = deletePolicy({ status: 'published', role: 'admin', linkedDevices: [{ _id: 'a', serialNumber: '2641XCT0026K' }, { _id: 'b', ipAddress: '10.0.0.9' }] });
    expect(r).toMatchObject({ ok: false, http: 409, code: 'IN_USE' });
    expect(r.message).toContain('2641XCT0026K');
    expect(r.message).toContain('10.0.0.9');
    expect(r.devices).toHaveLength(2);
  });
});
