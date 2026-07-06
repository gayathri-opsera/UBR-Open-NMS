import { describe, it, expect, beforeEach } from 'vitest';
import { setTokens, clearTokens, getAccessToken, isTokenExpired } from '../auth/tokens';

describe('token management', () => {
  beforeEach(() => clearTokens());

  it('stores and retrieves access token', () => {
    setTokens({ accessToken: 'token-abc', refreshToken: 'refresh-xyz', expiresAt: Date.now() + 900_000 });
    expect(getAccessToken()).toBe('token-abc');
  });

  it('returns null after clearTokens', () => {
    setTokens({ accessToken: 'tok', refreshToken: 'ref', expiresAt: Date.now() + 900_000 });
    clearTokens();
    expect(getAccessToken()).toBeNull();
  });

  it('reports token as NOT expired when well within TTL', () => {
    setTokens({ accessToken: 'tok', refreshToken: 'ref', expiresAt: Date.now() + 900_000 });
    expect(isTokenExpired()).toBe(false);
  });

  it('reports token as expired when expiresAt is in the past', () => {
    setTokens({ accessToken: 'tok', refreshToken: 'ref', expiresAt: Date.now() - 1000 });
    expect(isTokenExpired()).toBe(true);
  });

  it('reports token as expired within 30-second buffer', () => {
    setTokens({ accessToken: 'tok', refreshToken: 'ref', expiresAt: Date.now() + 20_000 });
    expect(isTokenExpired()).toBe(true);
  });
});
