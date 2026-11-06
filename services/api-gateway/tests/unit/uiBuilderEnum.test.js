'use strict';

// Route-level deps are not needed for the pure conversion; stub them so this runs without a DB.
jest.mock('../../src/models/uiDescriptor.model', () => ({}), { virtual: true });
jest.mock('../../src/models/nodeViewWireframe.model', () => ({ NodeViewWireframe: {}, invalidateCache: jest.fn() }), { virtual: true });
jest.mock('uuid', () => ({ v4: () => 'x' }), { virtual: true });
jest.mock('../../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }), { virtual: true });
jest.mock('../../src/live/uiXmlGenerator', () => ({ generateUiXml: () => '' }), { virtual: true });

const { descriptorToWireframe } = require('../../src/routes/uiBuilder.routes');
const { resolveDisplay } = (() => {
  jest.mock('net-snmp', () => ({ Version2c: 1, createSession: jest.fn(), isVarbindError: () => false }), { virtual: true });
  return require('../../src/live/liveParameters');
})();

const field = (over) => ({ fieldId: 'f', elementType: 'field-label', mibObject: 'x', oid: '.1.2.3', access: 'read-write', order: 0, ...over });
const wf = (fields) => descriptorToWireframe({ screenName: 'S', sections: [{ sectionId: 's1', title: 'T', order: 0, fields }] });
const param = (w, id) => w.groups[0].parameters.find((p) => p.parameterId === id);

describe('descriptorToWireframe enum handling', () => {
  const doc = wf([
    field({ mibObject: 'httpStatus', enumMap: { 0: 'disable', 1: 'enable' } }),
    field({ mibObject: 'plain' }),
    field({ mibObject: 'tbl', elementType: 'table-block', enumMap: { 0: 'off', 1: 'on', columns: 'auto' } }),
  ]);

  it('marks an enum field ENUM and carries label(n) values plus dropdown options', () => {
    const p = param(doc, 'httpStatus');
    expect(p.dataType).toBe('ENUM');
    expect(p.enumValues).toEqual(['disable(0)', 'enable(1)']);
    expect(p.options).toEqual([{ value: '0', label: 'disable' }, { value: '1', label: 'enable' }]);
  });

  it('leaves non-enum fields alone', () => {
    const p = param(doc, 'plain');
    expect(p.dataType).toBe('STRING');
    expect(p.enumValues).toEqual([]);
  });

  it('never turns a table block\'s `columns` setting into an option', () => {
    const p = param(doc, 'tbl');
    expect(p.options.map((o) => o.value)).toEqual(['0', '1']);
    expect(p.enumValues).toEqual(['off(0)', 'on(1)']);
    expect(p.columns).toBe('auto');
  });

  it('the live reader resolves a raw value to the label from those values', () => {
    const p = param(doc, 'httpStatus');
    expect(resolveDisplay({ enumValues: p.enumValues }, '1')).toBe('enable(1)');
    expect(resolveDisplay({ enumValues: p.enumValues }, '0')).toBe('disable(0)');
  });
});
