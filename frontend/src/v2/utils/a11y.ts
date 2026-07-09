/**
 * VisualForge V2 Accessibility Utilities (WO-011)
 * =============================================================================
 * WCAG 2.1 AA helpers: screen-reader utilities, focus management,
 * ARIA live region helpers, keyboard navigation, and contrast checkers.
 * All public APIs are pure functions — no React dependencies.
 * =============================================================================
 */

// ── Screen-reader-only (visually hidden) ──────────────────────────────────────

export const srOnlyStyle: React.CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: 'hidden',
  clip: 'rect(0,0,0,0)',
  whiteSpace: 'nowrap',
  border: 0,
};

// Needed for the type above without importing React
import type React from 'react';

// ── Focus management ──────────────────────────────────────────────────────────

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(', ');

export function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE));
}

export function trapFocus(container: HTMLElement, e: KeyboardEvent): void {
  const elements = getFocusableElements(container);
  if (elements.length === 0) return;
  const first = elements[0];
  const last = elements[elements.length - 1];
  if (e.key === 'Tab') {
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }
}

export function focusFirstIn(container: HTMLElement | null): void {
  if (!container) return;
  const first = getFocusableElements(container)[0];
  first?.focus();
}

export function restoreFocus(element: HTMLElement | null): void {
  if (element && typeof element.focus === 'function') {
    // Defer to allow DOM to settle
    requestAnimationFrame(() => element.focus());
  }
}

// ── ARIA live region ──────────────────────────────────────────────────────────

let _liveRegion: HTMLElement | null = null;

function getLiveRegion(): HTMLElement {
  if (_liveRegion) return _liveRegion;
  const el = document.createElement('div');
  el.setAttribute('aria-live', 'polite');
  el.setAttribute('aria-atomic', 'true');
  el.setAttribute('aria-relevant', 'additions text');
  Object.assign(el.style, {
    position: 'absolute',
    width: '1px',
    height: '1px',
    padding: '0',
    margin: '-1px',
    overflow: 'hidden',
    clip: 'rect(0,0,0,0)',
    whiteSpace: 'nowrap',
    border: '0',
  });
  document.body.appendChild(el);
  _liveRegion = el;
  return el;
}

/**
 * Announce a message to screen readers via a polite ARIA live region.
 * Clears after 1 second to allow re-announcement of the same message.
 */
export function announce(message: string, _urgency: 'polite' | 'assertive' = 'polite'): void {
  const region = getLiveRegion();
  region.setAttribute('aria-live', _urgency);
  region.textContent = '';
  requestAnimationFrame(() => {
    region.textContent = message;
    setTimeout(() => { region.textContent = ''; }, 1000);
  });
}

// ── Keyboard navigation helpers ───────────────────────────────────────────────

export function isArrowKey(key: string): boolean {
  return ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(key);
}

export function handleListKeyDown(
  e: KeyboardEvent,
  items: HTMLElement[],
  currentIndex: number,
  orientation: 'vertical' | 'horizontal' = 'vertical'
): number {
  const prev = orientation === 'vertical' ? 'ArrowUp' : 'ArrowLeft';
  const next = orientation === 'vertical' ? 'ArrowDown' : 'ArrowRight';

  if (e.key === prev) {
    e.preventDefault();
    const idx = currentIndex <= 0 ? items.length - 1 : currentIndex - 1;
    items[idx]?.focus();
    return idx;
  }
  if (e.key === next) {
    e.preventDefault();
    const idx = currentIndex >= items.length - 1 ? 0 : currentIndex + 1;
    items[idx]?.focus();
    return idx;
  }
  if (e.key === 'Home') {
    e.preventDefault();
    items[0]?.focus();
    return 0;
  }
  if (e.key === 'End') {
    e.preventDefault();
    items[items.length - 1]?.focus();
    return items.length - 1;
  }
  return currentIndex;
}

// ── Contrast ratio calculation (WCAG 2.1) ─────────────────────────────────────

function parseHex(hex: string): [number, number, number] {
  const clean = hex.replace('#', '');
  const full = clean.length === 3
    ? clean.split('').map((c) => c + c).join('')
    : clean;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return [r, g, b];
}

function toLinear(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/**
 * Compute WCAG 2.1 contrast ratio between two hex colors.
 * Returns a value between 1 and 21.
 */
export function contrastRatio(hex1: string, hex2: string): number {
  const L1 = relativeLuminance(parseHex(hex1));
  const L2 = relativeLuminance(parseHex(hex2));
  const lighter = Math.max(L1, L2);
  const darker  = Math.min(L1, L2);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Returns true if the pair meets WCAG 2.1 AA for normal text (≥4.5:1). */
export function meetsAA(foreground: string, background: string): boolean {
  return contrastRatio(foreground, background) >= 4.5;
}

/** Returns true if the pair meets WCAG 2.1 AA for large text / UI components (≥3:1). */
export function meetsAALarge(foreground: string, background: string): boolean {
  return contrastRatio(foreground, background) >= 3;
}

/** Returns 'AAA', 'AA', 'AA Large', or 'Fail' for a given color pair. */
export function wcagLevel(foreground: string, background: string): 'AAA' | 'AA' | 'AA Large' | 'Fail' {
  const ratio = contrastRatio(foreground, background);
  if (ratio >= 7) return 'AAA';
  if (ratio >= 4.5) return 'AA';
  if (ratio >= 3) return 'AA Large';
  return 'Fail';
}

// ── ID generation helper ──────────────────────────────────────────────────────

let _idCounter = 0;
export function generateA11yId(prefix = 'vf'): string {
  return `${prefix}-${++_idCounter}`;
}
