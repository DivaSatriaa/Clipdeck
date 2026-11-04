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

/**
 * Popup CSS for an accent colour. The selectors carry .clipdeck-accent so
 * they outrank stylesheet.css (and the dark variants outrank the light).
 */
export function popupAccentCss(hex) {
    const light = hex;
    const dark = shade(hex, 0.35);
    return `
.clipdeck-popup.clipdeck-accent .clipdeck-item:hover {
  border: 1px solid ${rgba(light, 0.30)};
}
.clipdeck-popup.clipdeck-accent .clipdeck-item:active {
  background-color: ${rgba(light, 0.10)};
}
.clipdeck-popup.clipdeck-accent .clipdeck-item:focus {
  border: 2px solid ${light};
  padding: 11px 13px;
}
.clipdeck-popup.clipdeck-accent .clipdeck-clear-button:focus {
  border: 1px solid ${light};
}
.clipdeck-popup.clipdeck-dark.clipdeck-accent .clipdeck-item:hover {
  border: 1px solid ${rgba(dark, 0.30)};
}
.clipdeck-popup.clipdeck-dark.clipdeck-accent .clipdeck-item:active {
  background-color: ${rgba(dark, 0.14)};
}
.clipdeck-popup.clipdeck-dark.clipdeck-accent .clipdeck-item:focus {
  border: 2px solid ${dark};
  padding: 11px 13px;
}
.clipdeck-popup.clipdeck-dark.clipdeck-accent .clipdeck-clear-button:focus {
  border: 1px solid ${dark};
}
`;
}
