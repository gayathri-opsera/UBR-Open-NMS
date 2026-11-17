'use strict';
/**
 * DELETE /descriptors/:id — the real route handler, with the stores mocked.
 * A published screen is refused while a device uses it (or when that cannot be checked) and otherwise removed together
 * with the Node View layout it published.
 */
jest.mock('../../src/models/uiDescriptor.model', () => ({ findOne: jest.fn(), deleteOne: jest.fn() }));
jest.mock('../../src/models/nodeViewWireframe.model', () => ({ NodeViewWireframe: { deleteMany: jest.fn() }, invalidateCache: jest.fn().mockResolvedValue() }));
jest.mock('../../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const mongoose = require('mongoose');
const UiDescriptor = require('../../src/models/uiDescriptor.model');
const { NodeViewWireframe, invalidateCache } = require('../../src/models/nodeViewWireframe.model');
const router = require('../../src/routes/uiBuilder.routes');

const handler = router.stack.find((l) => l.route && l.route.path === '/descriptors/:id' && l.route.methods.delete).route.stack.slice(-1)[0].handle;

function call(role, id = 'd1') {
  return new Promise((resolve) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ status: this.statusCode, body: b }); return this; } };
    handler({ params: { id }, user: role ? { role, sub: 'u1' } : undefined, headers: {}, app: { get: () => null } }, res);
  });
}
const withDevices = (byDb) => {
  mongoose.connection.client = { db: (name) => ({ collection: () => ({ find: () => ({ limit: () => ({ toArray: async () => { if (byDb[name] instanceof Error) throw byDb[name]; return byDb[name] || []; } }) }) }) }) };
};

beforeEach(() => { jest.clearAllMocks(); });

test('a draft is deleted', async () => {
  UiDescriptor.findOne.mockResolvedValue({ descriptorId: 'd1', status: 'draft' });
  const r = await call('viewer');
  expect(r.status).toBe(200);
  expect(UiDescriptor.deleteOne).toHaveBeenCalledWith({ descriptorId: 'd1' });
  expect(NodeViewWireframe.deleteMany).not.toHaveBeenCalled();
});

test('a published screen used by a device is refused and nothing is removed', async () => {
  UiDescriptor.findOne.mockResolvedValue({ descriptorId: 'd1', status: 'published' });
  withDevices({ ubrnms: [{ _id: 'x', serialNumber: '2641XCT0026K', ipAddress: '192.168.6.1' }] });
  const r = await call('admin');
  expect(r.status).toBe(409);
  expect(r.body.error.code).toBe('IN_USE');
  expect(r.body.error.message).toContain('2641XCT0026K');
  expect(UiDescriptor.deleteOne).not.toHaveBeenCalled();
  expect(NodeViewWireframe.deleteMany).not.toHaveBeenCalled();
});

test('if the device stores cannot be asked, a published screen is NOT deleted', async () => {
  UiDescriptor.findOne.mockResolvedValue({ descriptorId: 'd1', status: 'published' });
  withDevices({ ubrnms_inventory: new Error('down'), ubrnms: new Error('down') });
  const r = await call('admin');
  expect(r.status).toBe(503);
  expect(UiDescriptor.deleteOne).not.toHaveBeenCalled();
});

test('a non-admin cannot delete a published screen', async () => {
  UiDescriptor.findOne.mockResolvedValue({ descriptorId: 'd1', status: 'published' });
  withDevices({});
  const r = await call('operator');
  expect(r.status).toBe(403);
  expect(UiDescriptor.deleteOne).not.toHaveBeenCalled();
});

test('an unused published screen is deleted by an admin, with its own Node View layout only', async () => {
  UiDescriptor.findOne.mockResolvedValue({ descriptorId: 'd1', status: 'published', productDefinitionId: 'prod-9' });
  withDevices({ ubrnms_inventory: [], ubrnms: [] });
  const r = await call('admin');
  expect(r.status).toBe(200);
  expect(NodeViewWireframe.deleteMany).toHaveBeenCalledWith({ versionId: 'ui-builder-d1' });   // never a product definition's wireframe
  expect(invalidateCache).toHaveBeenCalledWith(null, 'prod-9');
  expect(UiDescriptor.deleteOne).toHaveBeenCalledWith({ descriptorId: 'd1' });
});

describe('publish validation: which fields need an OID', () => {
  const { validateBoundOids } = router;
  const sec = (fields) => ({ sections: [{ fields }] });
  const fl = (o) => ({ elementType: 'field-label', label: 'F', ...o });

  test('a MIB field without an OID is still refused', () => {
    expect(validateBoundOids(sec([fl({ mibObject: 'x' })]))).toEqual(['x']);
    expect(validateBoundOids(sec([fl({ mibObject: 'x', oid: '.1.2.3' })]))).toEqual([]);
  });
  test('fixed text needs no OID', () => {
    expect(validateBoundOids(sec([fl({ valueSource: 'static', staticValue: 'UBR660' })]))).toEqual([]);
  });
  test('a calculated field needs an expression and an OID on every input — not one of its own', () => {
    const ok = fl({ valueSource: 'calc', calc: { expr: '{t}/100', inputs: [{ name: 't', oid: '.1.3.6.1.2.1.1.3.0' }] } });
    expect(validateBoundOids(sec([ok]))).toEqual([]);
    expect(validateBoundOids(sec([fl({ label: 'Uptime', valueSource: 'calc', calc: { expr: '', inputs: [] } })]))[0]).toMatch(/no expression/);
    expect(validateBoundOids(sec([fl({ label: 'Uptime', valueSource: 'calc', calc: { expr: '{t}', inputs: [{ name: 't', oid: '' }] } })]))[0]).toMatch(/input "t" has no OID/);
  });
  test('headings and dividers are not checked', () => {
    expect(validateBoundOids(sec([{ elementType: 'divider' }, { elementType: 'heading', label: 'H' }]))).toEqual([]);
  });
});

describe('which published screens use the device look in Node View', () => {
  const { usesDeviceLayout, descriptorToWireframe } = router;
  test('a screen Builder v2 saved', () => { expect(usesDeviceLayout({ layoutMode: 'device' })).toBe(true); });
  test('a screen published before the flag existed, but with the v2 header config, is a v2 screen', () => {
    expect(usesDeviceLayout({ deviceUi: { productName: 'UBR660' } })).toBe(true);
  });
  test('a classic screen stays classic', () => {
    expect(usesDeviceLayout({})).toBe(false);
    expect(usesDeviceLayout({ deviceUi: {} })).toBe(false);
    expect(usesDeviceLayout({ layoutMode: 'classic', deviceUi: { productName: 'x' } })).toBe(false);
  });
  test('the wireframe of such a screen keeps empty tabs, like a v2 screen', () => {
    const d = { screenName: 'S', deviceUi: { productName: 'x' }, sections: [{ sectionId: 'a', title: 'Empty', uiPage: 'P', uiParent: 'Q', uiTab: 'T', fields: [] }] };
    expect(descriptorToWireframe(d).groupCount).toBe(1);
    expect(descriptorToWireframe({ ...d, deviceUi: null }).groupCount).toBe(0);
  });
});

describe('header sources in the stored wireframe and in publish validation', () => {
  const { descriptorToWireframe, validateBoundOids } = router;
  const dev = {
    screenName: 'S', layoutMode: 'device',
    deviceUi: { sources: { versionLine: { kind: 'template', template: '{fw} SNo. {sn}', inputs: [{ name: 'fw', oid: '.7' }, { name: 'sn', oid: '.1' }] } } },
    sections: [{ sectionId: 'a', title: 'T', uiPage: 'P', uiParent: 'Q', uiTab: 'T', fields: [] }],
  };
  test('the header inputs become hidden parameters of a synthetic group the poll reads', () => {
    const wf = descriptorToWireframe(dev);
    const g = wf.groups.find((x) => x.groupId === '__header');
    expect(g.parameters.map((p) => p.snmpOid).sort()).toEqual(['.1', '.7']);
    expect(g.parameters.every((p) => p.hidden)).toBe(true);
  });
  test('a screen with no header sources gets no synthetic group', () => {
    expect(descriptorToWireframe({ ...dev, deviceUi: { productName: 'x' } }).groups.find((x) => x.groupId === '__header')).toBeUndefined();
  });
  test('publish is refused when a header input has no OID', () => {
    const bad = { sections: [], deviceUi: { sources: { uptime: { kind: 'calc', expr: '{t}/100', inputs: [{ name: 't', oid: '' }] } } } };
    expect(validateBoundOids(bad)[0]).toMatch(/Header · uptime \(input "t" has no OID\)/);
    expect(validateBoundOids({ sections: [], deviceUi: dev.deviceUi })).toEqual([]);
  });
});
