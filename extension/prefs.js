// SPDX-License-Identifier: GPL-2.0-or-later
//
// Preferences window shown by the Extensions app (⚙ next to Clipdeck).
// It offers the same settings as the standalone Clipdeck app, minus the
// on/off switch, which the Extensions app already has.

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {
    accelLabel,
    createAppearanceGroup,
    createClipboardGroup,
    createShortcutRow,
    describeConflicts,
} from './settingsUi.js';

export default class ClipdeckPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(560, 640);

        const page = new Adw.PreferencesPage({
            title: 'Clipdeck',
            icon_name: 'edit-paste-symbolic',
        });

        const general = new Adw.PreferencesGroup({
            title: 'General',
            description: 'Press the shortcut, then click an item (or press Enter) to paste it.',
        });

        // Shown when another GNOME shortcut already uses Clipdeck's keys.
        const conflictRow = new Adw.ActionRow({
            title: 'Shortcut conflict',
            css_classes: ['warning'],
            visible: false,
        });
        conflictRow.add_prefix(new Gtk.Image({icon_name: 'dialog-warning-symbolic'}));
        const freeButton = new Gtk.Button({
            label: 'Free Shortcut',
            valign: Gtk.Align.CENTER,
            css_classes: ['suggested-action'],
        });
        conflictRow.add_suffix(freeButton);

        let conflict = null;
        const syncConflicts = () => {
            conflict = describeConflicts(settings);
            conflictRow.visible = conflict !== null;
            if (conflict)
                conflictRow.subtitle = conflict.message;
        };
        freeButton.connect('clicked', () => {
            const accel = conflict?.accel;
            conflict?.fix();
            syncConflicts();
            if (accel)
                window.add_toast(new Adw.Toast({title: `${accelLabel(accel)} now opens Clipdeck`}));
        });

        general.add(createShortcutRow(settings, accel => {
            window.add_toast(new Adw.Toast({title: `Shortcut set to ${accelLabel(accel)}`}));
            syncConflicts();
        }));
        general.add(conflictRow);
        page.add(general);

        page.add(createAppearanceGroup(settings, 'Applies to the clipboard popup'));
        page.add(createClipboardGroup(settings));

        const changedId = settings.connect('changed::toggle-popup', syncConflicts);
        // Re-check after the user fixes things in GNOME Settings.
        const activeId = window.connect('notify::is-active', () => {
            if (window.is_active)
                syncConflicts();
        });
        window.connect('close-request', () => {
            settings.disconnect(changedId);
            window.disconnect(activeId);
            return false;
        });
        syncConflicts();

        window.add(page);
    }
}
