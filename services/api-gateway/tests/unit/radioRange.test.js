'use strict';
jest.mock('../../src/models/uiDescriptor.model', () => ({}), { virtual: true });
jest.mock('../../src/models/nodeViewWireframe.model', () => ({ NodeViewWireframe: {}, invalidateCache: jest.fn() }), { virtual: true });
jest.mock('uuid', () => ({ v4: () => 'x' }), { virtual: true });
jest.mock('../../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }), { virtual: true });
jest.mock('../../src/live/uiXmlGenerator', () => ({ generateUiXml: () => '' }), { virtual: true });
const { radioRange } = require('../../src/routes/uiBuilder.routes');

const sec = (uiParent, extra = {}, fields = [{}]) => ({ uiParent, fields, ...extra });
describe('radioRange', () => {
  test('no radio menu items -> null', () => expect(radioRange([sec('System')])).toBeNull());
  test('fixed Radio 1 only -> 1..1', () => expect(radioRange([sec('Radio 1')])).toEqual({ min: 1, max: 1 }));
  test('fixed Radio 1 + Radio 2 -> 2..2', () => expect(radioRange([sec('Radio 1'), sec('Radio 2')])).toEqual({ min: 2, max: 2 }));
  test('Radio 2 gated by a known mode -> 1..2 (adapts)', () => {
    const gated = [{ uiShowWhen: [{ field: 'm', in: ['ap', 'sta'], required: true }] }];
    expect(radioRange([sec('Radio 1'), sec('Radio 2', {}, gated), sec('Radio 2', {})])).toEqual({ min: 1, max: 2 });
  });
  test('Radio 2 hide-when-empty -> 1..2', () => expect(radioRange([sec('Radio 1'), sec('Radio 2', { uiHideWhenEmpty: true })])).toEqual({ min: 1, max: 2 }));
});
