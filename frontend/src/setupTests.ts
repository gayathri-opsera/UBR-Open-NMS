import '@testing-library/jest-dom';

// ── localStorage polyfill for jsdom ──────────────────────────────────────────
// jsdom's localStorage may be restricted in some worker environments;
// a simple in-memory map guarantees predictable behaviour in all test runners.
const _store: Record<string, string> = {};
const localStorageMock: Storage = {
  getItem: (key) => Object.prototype.hasOwnProperty.call(_store, key) ? _store[key] : null,
  setItem: (key, value) => { _store[key] = String(value); },
  removeItem: (key) => { delete _store[key]; },
  clear: () => { Object.keys(_store).forEach((k) => delete _store[k]); },
  get length() { return Object.keys(_store).length; },
  key: (index) => Object.keys(_store)[index] ?? null,
};
Object.defineProperty(globalThis, 'localStorage', {
  value: localStorageMock,
  writable: true,
  configurable: true,
});
