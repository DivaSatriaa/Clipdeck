// SPDX-License-Identifier: GPL-2.0-or-later
//
// Settings widgets shared by the Clipdeck app (app/main.js) and the
// extension's preferences window (prefs.js). GTK 4 + libadwaita only:
// never import this from extension.js.

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {ACCENT_PRESETS, describeAccent, isHexColor} from './accent.js';

export const DEFAULT_SHORTCUT = '<Super>v';

/* ------------------------------------------------------------------ */
/* Accelerators                                                        */
/* ------------------------------------------------------------------ */

export function parseAccel(accel) {
    if (!accel)
        return null;
    const [ok, keyval, mods] = Gtk.accelerator_parse(accel);
    if (!ok || !keyval)
        return null;
    return {keyval: Gdk.keyval_to_lower(keyval), mods};
}

function sameAccel(a, b) {
    const pa = parseAccel(a), pb = parseAccel(b);
    return pa !== null && pb !== null && pa.keyval === pb.keyval && pa.mods === pb.mods;
}

export function accelLabel(accel) {
    const parsed = parseAccel(accel);
    return parsed ? Gtk.accelerator_get_label(parsed.keyval, parsed.mods) : 'Disabled';
}

/** Gio.Settings for a schema, or null when it is not installed (never abort). */
export function trySettings(schemaId, path = null) {
    const schema = Gio.SettingsSchemaSource.get_default()?.lookup(schemaId, true);
    if (!schema)
        return null;
    return path
        ? new Gio.Settings({settings_schema: schema, path})
        : new Gio.Settings({settings_schema: schema});
}

// Places where GNOME keeps global shortcuts that would win over Clipdeck's.
const SHORTCUT_SCHEMAS = [
    'org.gnome.shell.keybindings',
    'org.gnome.desktop.wm.keybindings',
    'org.gnome.mutter.keybindings',
    'org.gnome.mutter.wayland.keybindings',
    'org.gnome.settings-daemon.plugins.media-keys',
];
const MEDIA_KEYS_SCHEMA = 'org.gnome.settings-daemon.plugins.media-keys';
const CUSTOM_SCHEMA = 'org.gnome.settings-daemon.plugins.media-keys.custom-keybinding';

/**
 * Every other GNOME shortcut bound to `accel`. Each conflict knows how to
 * remove the accelerator from itself.
 */
export function findConflicts(accel) {
    const conflicts = [];
    if (!parseAccel(accel))
        return conflicts;

    for (const schemaId of SHORTCUT_SCHEMAS) {
        const settings = trySettings(schemaId);
        if (!settings)
            continue;
        const schema = settings.settings_schema;
        for (const key of schema.list_keys()) {
            const type = schema.get_key(key).get_value_type().dup_string();
            const label = schema.get_key(key).get_summary() || key;
            if (type === 'as') {
                const values = settings.get_strv(key);
                if (values.some(v => sameAccel(v, accel))) {
                    conflicts.push({
                        label,
                        free: () => settings.set_strv(key, values.filter(v => !sameAccel(v, accel))),
                    });
                }
            } else if (type === 's' && sameAccel(settings.get_string(key), accel)) {
                conflicts.push({label, free: () => settings.set_string(key, '')});
            }
        }
    }

    const mediaKeys = trySettings(MEDIA_KEYS_SCHEMA);
    for (const path of mediaKeys?.get_strv('custom-keybindings') ?? []) {
        const custom = trySettings(CUSTOM_SCHEMA, path);
        if (!custom || !sameAccel(custom.get_string('binding'), accel))
            continue;
        const name = custom.get_string('name') || custom.get_string('command');
        conflicts.push({
            label: `Custom shortcut “${name}”`,
            free: () => custom.set_string('binding', ''),
        });
    }
    return conflicts;
}

/**
 * Describe the conflicts of the current Clipdeck shortcut, or null when
 * there are none. `fix()` frees the shortcut everywhere else.
 */
export function describeConflicts(settings) {
    const accel = settings.get_strv('toggle-popup')[0] ?? '';
    const conflicts = findConflicts(accel);
    if (conflicts.length === 0)
        return null;
    return {
        accel,
        message: `${accelLabel(accel)} is also used by: ${conflicts.map(c => c.label).join(', ')}. ` +
            'Clipdeck will not open until it is freed.',
        fix: () => conflicts.forEach(c => c.free()),
    };
}

/* ------------------------------------------------------------------ */
/* Shortcut capture dialog                                             */
/* ------------------------------------------------------------------ */

export const ShortcutDialog = GObject.registerClass({
    Signals: {'shortcut-chosen': {param_types: [GObject.TYPE_STRING]}},
}, class ShortcutDialog extends Adw.Window {
    _init(parent) {
        super._init({
            modal: true,
            transient_for: parent,
            title: 'Set Shortcut',
            default_width: 420,
            resizable: false,
        });

        const status = new Adw.StatusPage({
            icon_name: 'input-keyboard-symbolic',
            title: 'Press the new shortcut',
            description: 'Use at least one modifier, such as Super, Ctrl or Alt.\n' +
                'Esc cancels · Backspace restores Super+V',
        });
        status.add_css_class('compact');

        const toolbar = new Adw.ToolbarView();
        toolbar.add_top_bar(new Adw.HeaderBar());
        toolbar.set_content(status);
        this.set_content(toolbar);

        const keys = new Gtk.EventControllerKey();
        keys.connect('key-pressed', (_c, keyval, _keycode, state) => this._onKey(keyval, state));
        this.add_controller(keys);

        // Let Super+V & co. reach this window instead of GNOME Shell while
        // the user records a shortcut (GNOME may ask for permission once).
        this.connect('map', () => {
            try {
                this.get_surface()?.inhibit_system_shortcuts(null);
            } catch {
                // Not supported on this display server.
            }
        });
        this.connect('unmap', () => {
            try {
                this.get_surface()?.restore_system_shortcuts();
            } catch {
                // Nothing to restore.
            }
        });
    }

    _onKey(keyval, state) {
        const mods = state & Gtk.accelerator_get_default_mod_mask();
        const key = Gdk.keyval_to_lower(keyval);

        if (mods === 0 && key === Gdk.KEY_Escape) {
            this.close();
            return Gdk.EVENT_STOP;
        }
        if (mods === 0 && key === Gdk.KEY_BackSpace) {
            this.emit('shortcut-chosen', DEFAULT_SHORTCUT);
            this.close();
            return Gdk.EVENT_STOP;
        }
        // Wait for a real key; a lone modifier or a bare letter is not enough.
        if (mods === 0 || !Gtk.accelerator_valid(key, mods))
            return Gdk.EVENT_STOP;

        this.emit('shortcut-chosen', Gtk.accelerator_name(key, mods));
        this.close();
        return Gdk.EVENT_STOP;
    }
});

/* ------------------------------------------------------------------ */
/* Rows and groups                                                     */
/* ------------------------------------------------------------------ */

/**
 * "Open clipboard history" row: shows the shortcut, records a new one,
 * resets it. `onChanged(accel)` is called after the user picks one.
 */
export function createShortcutRow(settings, onChanged = null) {
    const row = new Adw.ActionRow({
        title: 'Open clipboard history',
        subtitle: 'Shortcut that shows the Clipdeck popup',
        activatable: true,
    });

    const label = new Gtk.ShortcutLabel({valign: Gtk.Align.CENTER, disabled_text: 'Disabled'});
    row.add_suffix(label);

    const reset = new Gtk.Button({
        icon_name: 'edit-undo-symbolic',
        valign: Gtk.Align.CENTER,
        tooltip_text: 'Reset to Super+V',
        css_classes: ['flat'],
    });
    reset.connect('clicked', () => settings.reset('toggle-popup'));
    row.add_suffix(reset);
    row.add_suffix(new Gtk.Image({icon_name: 'go-next-symbolic'}));

    const sync = () => {
        const accel = settings.get_strv('toggle-popup')[0] ?? '';
        label.accelerator = parseAccel(accel) ? accel : '';
    };
    const id = settings.connect('changed::toggle-popup', sync);
    row.connect('destroy', () => settings.disconnect(id));
    sync();

    row.connect('activated', () => {
        const dialog = new ShortcutDialog(row.get_root());
        dialog.connect('shortcut-chosen', (_d, accel) => {
            settings.set_strv('toggle-popup', [accel]);
            onChanged?.(accel);
        });
        dialog.present();
    });
    return row;
}

export function createAppearanceGroup(settings, description) {
    const group = new Adw.PreferencesGroup({title: 'Appearance', description});

    const themes = ['system', 'light', 'dark'];
    const themeRow = new Adw.ComboRow({
        title: 'Theme',
        model: Gtk.StringList.new(['Follow System', 'Light', 'Dark']),
    });
    themeRow.selected = Math.max(0, themes.indexOf(settings.get_string('theme')));
    themeRow.connect('notify::selected', () =>
        settings.set_string('theme', themes[themeRow.selected]));
    group.add(themeRow);

    // Skip the row when an older install's schema has no accent-color key.
    if (settings.settings_schema.has_key('accent-color'))
        group.add(createAccentRow(settings));

    const motionRow = new Adw.SwitchRow({
        title: 'Reduce animations',
        subtitle: 'Show and hide the popup instantly',
    });
    settings.bind('reduce-motion', motionRow, 'active', Gio.SettingsBindFlags.DEFAULT);
    group.add(motionRow);

    return group;
}

/* ------------------------------------------------------------------ */
/* Accent colour picker                                                */
/* ------------------------------------------------------------------ */

let swatchCssInstalled = false;

function installSwatchCss() {
    if (swatchCssInstalled)
        return;
    swatchCssInstalled = true;

    const rules = ACCENT_PRESETS.map((preset, i) => preset.color
        ? `.clipdeck-swatch-${i} { background: ${preset.color}; }`
        : `.clipdeck-swatch-${i} { background: linear-gradient(135deg,
             #3584e4 0%, #3a944a 33%, #ed5b00 66%, #d56199 100%); }`);
    const css = `
.clipdeck-swatch {
  min-width: 30px;
  min-height: 30px;
  padding: 0;
  border-radius: 999px;
  color: white;
  box-shadow: inset 0 0 0 1px alpha(black, 0.12);
}
.clipdeck-swatch:checked,
.clipdeck-swatch.selected {
  box-shadow: inset 0 0 0 1px alpha(black, 0.12), 0 0 0 2px @window_bg_color, 0 0 0 4px alpha(@window_fg_color, 0.55);
}
.clipdeck-swatch image { -gtk-icon-shadow: 0 1px 2px alpha(black, 0.4); }
.clipdeck-swatch-custom {
  background: alpha(@window_fg_color, 0.08);
  color: @window_fg_color;
}
.clipdeck-swatch-custom image { -gtk-icon-shadow: none; }
${rules.join('\n')}
`;
    const provider = new Gtk.CssProvider();
    if (provider.load_from_string)
        provider.load_from_string(css);
    else
        provider.load_from_data(css, -1);
    Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), provider,
        Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
}

function hexToRgba(hex) {
    const rgba = new Gdk.RGBA();
    rgba.parse(hex);
    return rgba;
}

function rgbaToHex(rgba) {
    const c = v => Math.round(v * 255).toString(16).padStart(2, '0');
    return `#${c(rgba.red)}${c(rgba.green)}${c(rgba.blue)}`;
}

/**
 * "Accent color" row: a swatch per preset (Clipdeck purple, follow system,
 * GNOME's palette) plus a colour dialog for any custom colour.
 */
export function createAccentRow(settings) {
    installSwatchCss();

    const row = new Adw.PreferencesRow({activatable: false, focusable: false});
    const box = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 10,
        margin_top: 12,
        margin_bottom: 12,
        margin_start: 12,
        margin_end: 12,
    });
    row.set_child(box);

    const header = new Gtk.Box({spacing: 6});
    header.append(new Gtk.Label({label: 'Accent color', xalign: 0, hexpand: true}));
    const current = new Gtk.Label({css_classes: ['dim-label'], xalign: 1});
    header.append(current);
    box.append(header);

    const swatches = new Gtk.FlowBox({
        selection_mode: Gtk.SelectionMode.NONE,
        max_children_per_line: 11,
        min_children_per_line: 4,
        column_spacing: 4,
        row_spacing: 6,
        homogeneous: true,
    });
    box.append(swatches);

    let syncing = false;
    const buttons = [];
    let group = null;
    ACCENT_PRESETS.forEach((preset, i) => {
        const button = new Gtk.ToggleButton({
            css_classes: ['clipdeck-swatch', `clipdeck-swatch-${i}`],
            tooltip_text: preset.name,
            halign: Gtk.Align.CENTER,
            valign: Gtk.Align.CENTER,
        });
        button.update_property([Gtk.AccessibleProperty.LABEL], [preset.name]);
        const check = new Gtk.Image({icon_name: 'object-select-symbolic', visible: false});
        button.set_child(check);
        if (group)
            button.set_group(group);
        else
            group = button;
        button.connect('toggled', () => {
            check.visible = button.active;
            if (button.active && !syncing)
                settings.set_string('accent-color', preset.id);
        });
        swatches.append(button);
        buttons.push(button);
    });

    // Custom colour: a "+" swatch that opens the colour dialog and then
    // shows the chosen colour itself.
    const custom = new Gtk.Button({
        css_classes: ['clipdeck-swatch', 'clipdeck-swatch-custom'],
        tooltip_text: 'Custom color…',
        halign: Gtk.Align.CENTER,
        valign: Gtk.Align.CENTER,
        child: new Gtk.Image({icon_name: 'list-add-symbolic'}),
    });
    custom.update_property([Gtk.AccessibleProperty.LABEL], ['Custom color']);
    const customCss = new Gtk.CssProvider();
    custom.get_style_context().add_provider(customCss, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION + 1);
    const dialog = new Gtk.ColorDialog({title: 'Custom Accent Color', with_alpha: false});
    custom.connect('clicked', () => {
        const value = settings.get_string('accent-color');
        const initial = hexToRgba(isHexColor(value) ? value : '#71388a');
        dialog.choose_rgba(custom.get_root(), initial, null, (_d, result) => {
            try {
                settings.set_string('accent-color', rgbaToHex(dialog.choose_rgba_finish(result)));
            } catch {
                // Dialog cancelled.
            }
        });
    });
    swatches.append(custom);

    const sync = () => {
        const value = settings.get_string('accent-color');
        syncing = true;
        const index = ACCENT_PRESETS.findIndex(p => p.id === value.toLowerCase());
        buttons.forEach((b, i) => {
            b.active = i === index;
        });
        const isCustom = index < 0 && isHexColor(value);
        const css = isCustom
            ? `.clipdeck-swatch-custom { background: ${value}; color: white; }`
            : '';
        if (customCss.load_from_string)
            customCss.load_from_string(css);
        else
            customCss.load_from_data(css, -1);
        custom.child.icon_name = isCustom ? 'object-select-symbolic' : 'list-add-symbolic';
        if (isCustom)
            custom.add_css_class('selected');
        else
            custom.remove_css_class('selected');
        current.label = describeAccent(value);
        syncing = false;
    };
    const id = settings.connect('changed::accent-color', sync);
    row.connect('destroy', () => settings.disconnect(id));
    sync();

    return row;
}

export function createClipboardGroup(settings) {
    const group = new Adw.PreferencesGroup({title: 'Clipboard'});

    const imagesRow = new Adw.SwitchRow({
        title: 'Screenshots and images',
        subtitle: 'Keep PrtScr screenshots and copied images in the history',
    });
    settings.bind('enable-images', imagesRow, 'active', Gio.SettingsBindFlags.DEFAULT);
    group.add(imagesRow);

    // Bound by hand: GSettings cannot map an int key to a double property.
    const historyRow = Adw.SpinRow.new_with_range(10, 200, 5);
    historyRow.title = 'History size';
    historyRow.subtitle = 'Older items are removed after this many';
    historyRow.value = settings.get_int('history-size');
    historyRow.connect('notify::value', () => {
        const value = Math.round(historyRow.value);
        if (value !== settings.get_int('history-size'))
            settings.set_int('history-size', value);
    });
    const id = settings.connect('changed::history-size', () => {
        historyRow.value = settings.get_int('history-size');
    });
    historyRow.connect('destroy', () => settings.disconnect(id));
    group.add(historyRow);

    return group;
}
