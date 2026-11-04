// SPDX-License-Identifier: GPL-2.0-or-later
//
// Accent colour helpers shared by the extension, prefs.js and the app.
// Plain JavaScript only (no GI imports), so every side can load it.

/** The Clipdeck purple from the logo; the stylesheet already uses it. */
export const CLIPDECK_ACCENT = '#71388a';

/** GNOME 47+ accent colours (org.gnome.desktop.interface accent-color). */
export const SYSTEM_ACCENTS = {
    blue: '#3584e4',
    teal: '#2190a4',
    green: '#3a944a',
    yellow: '#c88800',
    orange: '#ed5b00',
    red: '#e62d42',
    pink: '#d56199',
    purple: '#9141ac',
    slate: '#6f8396',
};

/** Swatches offered in the settings, in display order. */
export const ACCENT_PRESETS = [
    {id: 'clipdeck', name: 'Clipdeck', color: CLIPDECK_ACCENT},
    {id: 'system', name: 'Follow system', color: null},
    ...['blue', 'teal', 'green', 'yellow', 'orange', 'red', 'pink', 'slate'].map(id => ({
        id: SYSTEM_ACCENTS[id],
        name: id[0].toUpperCase() + id.slice(1),
        color: SYSTEM_ACCENTS[id],
    })),
];

export function isHexColor(value) {
    return /^#[0-9a-f]{6}$/i.test(value ?? '');
}

/**
 * Turn the `accent-color` setting into "#rrggbb".
 * @param {string} value - "clipdeck", "system" or "#rrggbb"
 * @param {string|null} systemAccent - GNOME's accent-color name, if any
 */
export function resolveAccent(value, systemAccent = null) {
    if (isHexColor(value))
        return value.toLowerCase();
    if (value === 'system')
        return SYSTEM_ACCENTS[systemAccent] ?? SYSTEM_ACCENTS.blue;
    return CLIPDECK_ACCENT;
}

function toRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toHex(rgb) {
    return `#${rgb.map(c => Math.round(c).toString(16).padStart(2, '0')).join('')}`;
}

/** Blend `hex` towards white (amount > 0) or black (amount < 0). */
export function shade(hex, amount) {
    const target = amount > 0 ? 255 : 0;
    const t = Math.abs(amount);
    return toHex(toRgb(hex).map(c => c + (target - c) * t));
}

export function rgba(hex, alpha) {
    return `rgba(${toRgb(hex).join(', ')}, ${alpha})`;
}

/** Name of a preset colour, or the hex code for custom colours. */
export function describeAccent(value) {
    const preset = ACCENT_PRESETS.find(p => p.id === value);
    return preset ? preset.name : `Custom ${value.toUpperCase()}`;
}

/** Mix `base` with `tint`: amount 0 gives base, 1 gives tint. */
export function mix(base, tint, amount) {
    const a = toRgb(base), b = toRgb(tint);
    return toHex(a.map((c, i) => c + (b[i] - c) * amount));
}

/**
 * Popup CSS for an accent colour: the focus ring and hover states use the
 * colour itself, and the popup, card and button backgrounds get a light
 * tint of it, so the whole popup follows the chosen colour.
 *
 * The selectors carry .clipdeck-accent so they outrank stylesheet.css (and
 * the dark variants outrank the light ones).
 */
export function popupAccentCss(hex) {
    const L = '.clipdeck-popup.clipdeck-accent';
    const D = '.clipdeck-popup.clipdeck-dark.clipdeck-accent';
    const darkAccent = shade(hex, 0.35);
    return `
${L} {
  background-color: ${rgba(mix('#f7f7f8', hex, 0.06), 0.98)};
  border: 1px solid ${rgba(hex, 0.12)};
}
${L} .clipdeck-clear-button {
  background-color: #ffffff;
  border: 1px solid ${rgba(hex, 0.14)};
}
${L} .clipdeck-clear-button:hover { background-color: ${mix('#ffffff', hex, 0.07)}; }
${L} .clipdeck-clear-button:active { background-color: ${mix('#ffffff', hex, 0.14)}; }
${L} .clipdeck-clear-button:focus { border: 1px solid ${hex}; }
${L} .clipdeck-item {
  background-color: #ffffff;
  border: 1px solid ${rgba(hex, 0.08)};
}
${L} .clipdeck-item:hover {
  background-color: ${mix('#ffffff', hex, 0.04)};
  border: 1px solid ${rgba(hex, 0.30)};
}
${L} .clipdeck-item:active { background-color: ${mix('#ffffff', hex, 0.10)}; }
${L} .clipdeck-item:focus {
  border: 2px solid ${hex};
  padding: 11px 13px;
}
${L} .clipdeck-item-image { background-color: ${rgba(hex, 0.06)}; }

${D} {
  background-color: ${rgba(mix('#1e1e20', hex, 0.10), 0.98)};
  border: 1px solid rgba(255, 255, 255, 0.08);
}
${D} .clipdeck-clear-button {
  background-color: ${mix('#2c2c2e', hex, 0.10)};
  border: 1px solid rgba(255, 255, 255, 0.08);
}
${D} .clipdeck-clear-button:hover { background-color: ${mix('#353537', hex, 0.14)}; }
${D} .clipdeck-clear-button:active { background-color: ${mix('#3e3e40', hex, 0.18)}; }
${D} .clipdeck-clear-button:focus { border: 1px solid ${darkAccent}; }
${D} .clipdeck-item {
  background-color: ${mix('#28282a', hex, 0.10)};
  border: 1px solid rgba(255, 255, 255, 0.06);
}
${D} .clipdeck-item:hover {
  background-color: ${mix('#303032', hex, 0.14)};
  border: 1px solid ${rgba(darkAccent, 0.30)};
}
${D} .clipdeck-item:active { background-color: ${mix('#38383a', hex, 0.18)}; }
${D} .clipdeck-item:focus {
  border: 2px solid ${darkAccent};
  padding: 11px 13px;
}
${D} .clipdeck-item-image { background-color: ${rgba(darkAccent, 0.08)}; }
`;
}
