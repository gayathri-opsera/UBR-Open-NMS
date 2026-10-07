'use strict';

/**
 * Dropdown options from a definition's `enumValues`.
 *
 * Definitions write an option as "Label(raw)" — the part in parentheses is what the device
 * stores, the part before it is what a person reads: "Enable(0)", "AES-256(psk2+ccmp-256)".
 * An entry may hold several options joined by "/" ("Enable(1)/Disable(0)") or run together
 * ("Access(1)Trunk(2)"). An entry without parentheses is both label and value ("Auto").
 *
 * Nothing is invented: every option comes from the definition text. Entries that are not
 * valid options (free text such as "channel list based on country(36") are kept as plain
 * label = value so they stay visible, never silently dropped or "fixed".
 */

const PAIR_RE = /([^()/]+?)\s*\(([^()]*)\)/g;

/** @param {string[]} enumValues @returns {Array<{value:string,label:string}>} */
function parseEnumOptions(enumValues) {
  const out = [];
  const seen = new Set();
  const push = (value, label) => {
    const v = String(value).trim();
    if (seen.has(v)) return;
    seen.add(v);
    out.push({ value: v, label: String(label).trim() });
  };
  for (const raw of Array.isArray(enumValues) ? enumValues : []) {
    const text = String(raw).trim();
    if (!text) continue;
    const pairs = [...text.matchAll(PAIR_RE)];
    if (pairs.length > 0 && pairs.map((m) => m[0]).join('').replace(/[\s/]/g, '') === text.replace(/[\s/]/g, '')) {
      for (const m of pairs) push(m[2], m[1]);
    } else {
      push(text, text);
    }
  }
  return out;
}

module.exports = { parseEnumOptions };
