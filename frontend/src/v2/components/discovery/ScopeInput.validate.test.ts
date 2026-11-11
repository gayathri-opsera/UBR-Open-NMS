import { describe, it, expect } from 'vitest';
import { validateScopeToken } from './ScopeInput';

describe('validateScopeToken', () => {
  it.each([
    '10.0.150.*', '10.0.*.*', '10.0.*', '10.*', '10.0.150.100-120', '10.0.140-150.*',
    '10.0.150.1-10.0.150.50', '10.0.150.112', '10.0.150.0/24', 'my-host.lab',
  ])('accepts %s', (t) => expect(validateScopeToken(t)).toBeNull());

  it.each([
    '10.0.150.256', '10.0.150.*.*', '10.0.150', '10.0.150.200-100', '10.0.150.1-10.0.150.0',
    '10.0.150.*/24', '10.0.150.5-300',
  ])('rejects %s', (t) => expect(validateScopeToken(t)).not.toBeNull());
});
