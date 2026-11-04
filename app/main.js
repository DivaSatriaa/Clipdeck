// SPDX-License-Identifier: GPL-2.0-or-later
//
// Clipdeck settings app. Controls the Clipdeck GNOME Shell extension:
// turns it on and off over D-Bus and edits its GSettings.
//
// Needs: gjs, GTK 4.14+ and libadwaita 1.5+ (Ubuntu 24.04 and newer).

import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import {programArgs, programInvocationName} from 'system';

const APP_ID = 'io.github.divasatriaa.Clipdeck';
const VERSION = '0.2.0';
const UUID = 'clipdeck@divasatriaa.github.io';
const SCHEMA_ID = 'org.gnome.shell.extensions.clipdeck';
const REPO_URL = 'https://github.com/divasatriaa/clipdeck';
const ISSUES_URL = `${REPO_URL}/issues`;

const APP_DIR = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);

// Modules shared with the extension's prefs.js. Installed next to this
// file; in a source checkout they live in ../extension/.
function sharedModule(name) {
    return GLib.file_test(GLib.build_filenamev([APP_DIR, name]), GLib.FileTest.EXISTS)
        ? `./${name}`
        : `../extension/${name}`;
}

const {
    accelLabel,
    createAppearanceGroup,
    createClipboardGroup,
    createShortcutRow,
    describeConflicts,
    trySettings,
} = await import(sharedModule('settingsUi.js'));
const {resolveAccent, shade} = await import(sharedModule('accent.js'));

// GNOME Shell exports org.gnome.Shell.Extensions on this object path
// (js/ui/shellDBus.js), not on /org/gnome/Shell/Extensions.
const SHELL_BUS_NAME = 'org.gnome.Shell';
const SHELL_OBJECT_PATH = '/org/gnome/Shell';
const EXTENSIONS_IFACE = 'org.gnome.Shell.Extensions';

// org.gnome.Shell.Extensions extension states (js/misc/extensionUtils.js).
const ExtensionState = {
    ACTIVE: 1,
    INACTIVE: 2,
    ERROR: 3,
    OUT_OF_DATE: 4,
    DOWNLOADING: 5,
    INITIALIZED: 6,
    DEACTIVATING: 7,
    ACTIVATING: 8,
    UNINSTALLED: 99,
};

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

/**
 * The schema is installed system-wide by the .deb package, but a
 * `make install` from source only ships it inside the extension folder,
 * and a source checkout keeps it next to this file.
 */
function loadExtensionSettings() {
    const defaultSource = Gio.SettingsSchemaSource.get_default();
    const schema = defaultSource?.lookup(SCHEMA_ID, true);
    if (schema)
        return new Gio.Settings({settings_schema: schema});

    const candidates = [
        GLib.getenv('CLIPDECK_SCHEMA_DIR'),
        GLib.build_filenamev([GLib.get_user_data_dir(), 'gnome-shell', 'extensions', UUID, 'schemas']),
        GLib.build_filenamev(['/usr/share/gnome-shell/extensions', UUID, 'schemas']),
        GLib.build_filenamev([APP_DIR, '..', 'extension', 'schemas']),
    ];
    for (const dir of candidates) {
        if (!dir || !GLib.file_test(GLib.build_filenamev([dir, 'gschemas.compiled']), GLib.FileTest.EXISTS))
            continue;
        try {
            const source = Gio.SettingsSchemaSource.new_from_directory(dir, defaultSource, false);
            const found = source.lookup(SCHEMA_ID, false);
            if (found)
                return new Gio.Settings({settings_schema: found});
        } catch (e) {
            console.warn(`Clipdeck: could not read schemas in ${dir}: ${e.message}`);
        }
    }
    return null;
}

/* ------------------------------------------------------------------ */
/* GNOME Shell extension control (D-Bus)                               */
/* ------------------------------------------------------------------ */

class ShellExtensions {
    constructor(onChanged) {
        this._bus = Gio.DBus.session;
        this._signalId = this._bus.signal_subscribe(
            SHELL_BUS_NAME, EXTENSIONS_IFACE, 'ExtensionStateChanged',
            SHELL_OBJECT_PATH, UUID, Gio.DBusSignalFlags.NONE,
            () => onChanged());
    }

    _call(method, args, replyType) {
        return this._bus.call_sync(SHELL_BUS_NAME, SHELL_OBJECT_PATH,
            EXTENSIONS_IFACE, method, args,
            replyType ? new GLib.VariantType(replyType) : null,
            Gio.DBusCallFlags.NONE, 3000, null);
    }

    /** {available, state, error} — available is false outside GNOME Shell. */
    info() {
        try {
            const [info] = this._call('GetExtensionInfo', new GLib.Variant('(s)', [UUID]), '(a{sv})')
                .recursiveUnpack();
            if (Object.keys(info).length === 0)
                return {available: true, state: ExtensionState.UNINSTALLED, error: ''};
            return {available: true, state: info.state, error: info.error ?? ''};
        } catch (e) {
            console.warn(`Clipdeck: cannot reach GNOME Shell: ${e.message}`);
            return {available: false, state: ExtensionState.UNINSTALLED, error: e.message};
        }
    }

    setEnabled(enabled) {
        if (enabled) {
            // The global "Extensions" switch overrides per-extension state.
            const shell = trySettings('org.gnome.shell');
            if (shell?.get_boolean('disable-user-extensions'))
                shell.set_boolean('disable-user-extensions', false);
        }
        this._call(enabled ? 'EnableExtension' : 'DisableExtension',
            new GLib.Variant('(s)', [UUID]), '(b)');
    }

    destroy() {
        this._bus.signal_unsubscribe(this._signalId);
    }
}

/* ------------------------------------------------------------------ */
/* Main window                                                         */
/* ------------------------------------------------------------------ */

const ClipdeckWindow = GObject.registerClass(
class ClipdeckWindow extends Adw.ApplicationWindow {
    _init(app, settings) {
        super._init({
            application: app,
            title: 'Clipdeck',
            default_width: 600,
            default_height: 860,
            width_request: 360,
            height_request: 400,
        });
        this._settings = settings;
        this._shell = new ShellExtensions(() => this._syncExtensionState());

        const toolbar = new Adw.ToolbarView();
        const header = new Adw.HeaderBar();
        header.pack_end(this._buildMenuButton());
        toolbar.add_top_bar(header);

        this._banner = new Adw.Banner({revealed: false});
        this._banner.connect('button-clicked', () => this._bannerAction?.());
        toolbar.add_top_bar(this._banner);

        this._toasts = new Adw.ToastOverlay();
        toolbar.set_content(this._toasts);
        this.set_content(toolbar);

        if (!settings) {
            this._toasts.set_child(new Adw.StatusPage({
                icon_name: 'dialog-warning-symbolic',
                title: 'Clipdeck is not installed',
                description: 'The Clipdeck GNOME Shell extension and its settings schema ' +
                    'were not found. Install the clipdeck package, or run ' +
                    '<tt>make install</tt> from the source folder, then open this app again.',
            }));
            return;
        }

        const page = new Adw.PreferencesPage();
        page.add(this._buildHero());
        page.add(this._buildGeneralGroup());
        page.add(createAppearanceGroup(settings, 'Applies to the popup and to this window'));
        page.add(createClipboardGroup(settings));
        page.add(this._buildAboutGroup());
        this._toasts.set_child(page);

        this._settingsIds = [
            settings.connect('changed::toggle-popup', () => this._syncConflicts()),
        ];

        this._syncExtensionState();
        this._syncConflicts();

        // Re-check conflicts when coming back from GNOME Settings.
        this.connect('notify::is-active', () => {
            if (this.is_active)
                this._syncConflicts();
        });
        this.connect('close-request', () => {
            this._shell.destroy();
            this._settingsIds?.forEach(id => this._settings.disconnect(id));
            return false;
        });
    }

    /* ---------- building ---------- */

    _buildMenuButton() {
        const menu = new Gio.Menu();
        menu.append('Star on GitHub', 'app.star');
        menu.append('Report an Issue', 'app.issues');
        menu.append('About Clipdeck', 'app.about');
        return new Gtk.MenuButton({
            icon_name: 'open-menu-symbolic',
            menu_model: menu,
            tooltip_text: 'Main Menu',
            primary: true,
        });
    }

    _buildHero() {
        const group = new Adw.PreferencesGroup();
        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 6,
            halign: Gtk.Align.CENTER,
            margin_top: 6,
            margin_bottom: 6,
        });

        box.append(createLogo(112));
        box.append(new Gtk.Label({label: 'Clipdeck', css_classes: ['title-1'], margin_top: 6}));
        box.append(new Gtk.Label({
            label: 'Clipboard history for GNOME. Press your shortcut,\npick an item, and it is pasted where you were typing.',
            justify: Gtk.Justification.CENTER,
            wrap: true,
            css_classes: ['dim-label'],
        }));

        this._statusLabel = new Gtk.Label({
            css_classes: ['clipdeck-status'],
            halign: Gtk.Align.CENTER,
            margin_top: 8,
        });
        box.append(this._statusLabel);

        group.add(box);
        return group;
    }

    _buildGeneralGroup() {
        const group = new Adw.PreferencesGroup({title: 'General'});

        this._enableRow = new Adw.SwitchRow({
            title: 'Enable Clipdeck',
            subtitle: 'Record clipboard history and listen for the shortcut',
        });
        this._enableHandler = this._enableRow.connect('notify::active', () => {
            try {
                this._shell.setEnabled(this._enableRow.active);
            } catch (e) {
                this._toast(`Could not change Clipdeck: ${e.message}`);
            }
            // The shell answers with ExtensionStateChanged; sync now as well.
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
                this._syncExtensionState();
                return GLib.SOURCE_REMOVE;
            });
        });
        group.add(this._enableRow);

        group.add(createShortcutRow(this._settings, accel => {
            this._toast(`Shortcut set to ${accelLabel(accel)}`);
            this._syncConflicts();
        }));

        return group;
    }

    _buildAboutGroup() {
        const group = new Adw.PreferencesGroup({title: 'Project'});

        const star = new Adw.ActionRow({
            title: 'Star Clipdeck on GitHub',
            subtitle: 'Like the app? A star helps other people find it',
            activatable: true,
        });
        star.add_prefix(new Gtk.Image({icon_name: 'starred-symbolic'}));
        star.add_suffix(new Gtk.Image({icon_name: 'adw-external-link-symbolic'}));
        star.connect('activated', () => this.application.activate_action('star', null));
        group.add(star);

        const issues = new Adw.ActionRow({
            title: 'Report an issue',
            subtitle: 'Found a bug or have an idea?',
            activatable: true,
        });
        issues.add_prefix(new Gtk.Image({icon_name: 'dialog-information-symbolic'}));
        issues.add_suffix(new Gtk.Image({icon_name: 'adw-external-link-symbolic'}));
        issues.connect('activated', () => this.application.activate_action('issues', null));
        group.add(issues);

        return group;
    }

    /* ---------- state ---------- */

    _syncExtensionState() {
        if (!this._enableRow)
            return;
        const info = this._shell.info();
        const active = info.state === ExtensionState.ACTIVE || info.state === ExtensionState.ACTIVATING;

        // Reflect the real state without calling Enable/Disable again.
        this._enableRow.block_signal_handler(this._enableHandler);
        this._enableRow.active = active;
        this._enableRow.unblock_signal_handler(this._enableHandler);

        let status, cls, sensitive = true;
        if (!info.available) {
            status = 'GNOME Shell not detected';
            cls = 'warning';
            sensitive = false;
        } else if (info.state === ExtensionState.UNINSTALLED) {
            status = 'Log out and back in to finish installing';
            cls = 'warning';
            sensitive = false;
        } else if (info.state === ExtensionState.ERROR || info.state === ExtensionState.OUT_OF_DATE) {
            status = info.state === ExtensionState.OUT_OF_DATE
                ? 'Not compatible with this GNOME version'
                : `Error: ${info.error || 'see “journalctl /usr/bin/gnome-shell”'}`;
            cls = 'error';
        } else if (active) {
            status = '● Running';
            cls = 'success';
        } else {
            status = '○ Turned off';
            cls = 'dim-label';
        }

        this._enableRow.sensitive = sensitive;
        this._statusLabel.label = status;
        this._statusLabel.css_classes = ['clipdeck-status', cls];
    }

    _syncConflicts() {
        const conflict = describeConflicts(this._settings);
        this._banner.revealed = conflict !== null;
        this._bannerAction = null;
        if (!conflict)
            return;

        this._banner.title = conflict.message;
        this._banner.button_label = 'Free Shortcut';
        this._bannerAction = () => {
            conflict.fix();
            this._toast(`${accelLabel(conflict.accel)} now opens Clipdeck`);
            this._syncConflicts();
        };
    }

    _toast(title) {
        this._toasts.add_toast(new Adw.Toast({title, timeout: 3}));
    }
});

/* ------------------------------------------------------------------ */
/* Application                                                         */
/* ------------------------------------------------------------------ */

function findLogoFile() {
    const candidates = [
        GLib.build_filenamev([APP_DIR, 'logo.png']),
        GLib.build_filenamev([APP_DIR, '..', 'assets', 'logo.png']),
    ];
    return candidates.find(path => GLib.file_test(path, GLib.FileTest.EXISTS)) ?? null;
}

function createLogo(size) {
    const file = findLogoFile();
    const image = file
        ? Gtk.Image.new_from_file(file)
        : Gtk.Image.new_from_icon_name(APP_ID);
    image.pixel_size = size;
    image.add_css_class('icon-dropshadow');
    return image;
}

const CSS = `
.clipdeck-status {
  padding: 4px 12px;
  border-radius: 999px;
  font-weight: bold;
  font-size: 0.9em;
  background-color: alpha(currentColor, 0.08);
}
.clipdeck-status.success { color: @success_color; background-color: alpha(@success_color, 0.12); }
.clipdeck-status.warning { color: @warning_color; background-color: alpha(@warning_color, 0.12); }
.clipdeck-status.error { color: @error_color; background-color: alpha(@error_color, 0.12); }
`;

const ClipdeckApplication = GObject.registerClass(
class ClipdeckApplication extends Adw.Application {
    _init() {
        super._init({application_id: APP_ID, flags: Gio.ApplicationFlags.DEFAULT_FLAGS});
        GLib.set_application_name('Clipdeck');

        this._addAction('star', () => this._openUri(REPO_URL));
        this._addAction('issues', () => this._openUri(ISSUES_URL));
        this._addAction('about', () => this._showAbout());
        this._addAction('quit', () => this.quit());
        this.set_accels_for_action('app.quit', ['<Control>q']);
        this.set_accels_for_action('window.close', ['<Control>w']);
    }

    vfunc_startup() {
        super.vfunc_startup();

        const display = Gdk.Display.get_default();
        // Running from a source checkout: make the app icon findable.
        const sourceIcons = GLib.build_filenamev([APP_DIR, '..', 'data', 'icons']);
        if (GLib.file_test(sourceIcons, GLib.FileTest.IS_DIR))
            Gtk.IconTheme.get_for_display(display).add_search_path(sourceIcons);
        Gtk.Window.set_default_icon_name(APP_ID);

        const provider = new Gtk.CssProvider();
        provider.load_from_string(CSS);
        Gtk.StyleContext.add_provider_for_display(display, provider,
            Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);

        this._settings = loadExtensionSettings();
        if (this._settings) {
            this._accentProvider = new Gtk.CssProvider();
            Gtk.StyleContext.add_provider_for_display(display, this._accentProvider,
                Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);

            this._applyTheme();
            this._settings.connect('changed::theme', () => this._applyTheme());
            this._settings.connect('changed::accent-color', () => this._applyTheme());
            Adw.StyleManager.get_default().connect('notify::dark', () => this._applyTheme());
        }
    }

    vfunc_activate() {
        let window = this.active_window;
        if (!window)
            window = new ClipdeckWindow(this, this._settings);
        window.present();
    }

    _applyTheme() {
        const schemes = {
            light: Adw.ColorScheme.FORCE_LIGHT,
            dark: Adw.ColorScheme.FORCE_DARK,
        };
        const styleManager = Adw.StyleManager.get_default();
        styleManager.color_scheme =
            schemes[this._settings.get_string('theme')] ?? Adw.ColorScheme.DEFAULT;

        // Preview the popup's accent colour in this window too. "Follow
        // system" leaves libadwaita's own (system) accent alone.
        const value = this._settings.get_string('accent-color');
        let css = '';
        if (value !== 'system') {
            const bg = resolveAccent(value);
            const fg = styleManager.dark ? shade(bg, 0.35) : shade(bg, -0.1);
            css = Adw.get_minor_version() >= 6
                ? `:root { --accent-bg-color: ${bg}; --accent-color: ${fg}; }`
                : `@define-color accent_bg_color ${bg}; @define-color accent_color ${fg};`;
        }
        this._accentProvider.load_from_string(css);
    }

    _addAction(name, callback) {
        const action = new Gio.SimpleAction({name});
        action.connect('activate', callback);
        this.add_action(action);
    }

    _openUri(uri) {
        new Gtk.UriLauncher({uri}).launch(this.active_window, null, null);
    }

    _showAbout() {
        const about = new Adw.AboutWindow({
            transient_for: this.active_window,
            application_name: 'Clipdeck',
            application_icon: APP_ID,
            version: VERSION,
            developer_name: 'divasatriaa',
            website: REPO_URL,
            issue_url: ISSUES_URL,
            license_type: Gtk.License.GPL_2_0,
            comments: 'Windows-style clipboard history for GNOME, with text and screenshot support.',
        });
        about.present();
    }
});

new ClipdeckApplication().run([programInvocationName, ...programArgs]);
