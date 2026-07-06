'use strict';

const { validatePasswordComplexity, ROLES } = require('../../src/models/user.model');

describe('validatePasswordComplexity', () => {
  test('rejects password shorter than 12 chars', () => {
    expect(validatePasswordComplexity('Short1!')).not.toBeNull();
  });

  test('rejects password without uppercase', () => {
    expect(validatePasswordComplexity('alllowercase1!')).not.toBeNull();
  });

  test('rejects password without lowercase', () => {
    expect(validatePasswordComplexity('ALLUPPERCASE1!')).not.toBeNull();
  });

  test('rejects password without digit', () => {
    expect(validatePasswordComplexity('NoDigitsHere!!')).not.toBeNull();
  });

  test('rejects password without special character', () => {
    expect(validatePasswordComplexity('NoSpecialChar1A')).not.toBeNull();
  });

  test('rejects null/undefined', () => {
    expect(validatePasswordComplexity(null)).not.toBeNull();
    expect(validatePasswordComplexity(undefined)).not.toBeNull();
  });

  test('accepts a valid ITSAR-compliant password', () => {
    expect(validatePasswordComplexity('Airtel@NMS2024!')).toBeNull();
  });

  test('accepts password with exactly 12 characters meeting all criteria', () => {
    expect(validatePasswordComplexity('Passw0rd!XyZ')).toBeNull();
  });
});

describe('ROLES', () => {
  test('contains exactly admin, operator, user', () => {
    expect(ROLES).toContain('admin');
    expect(ROLES).toContain('operator');
    expect(ROLES).toContain('user');
    expect(ROLES.length).toBe(3);
  });
});
