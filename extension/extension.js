// SPDX-License-Identifier: GPL-2.0-or-later
//
// Clipdeck — Windows 11-style clipboard history for GNOME Shell.
//
// Why an extension and not a normal app?
// On GNOME Wayland only the focused window receives clipboard events, and
// Mutter exposes no data-control protocol. Code running inside GNOME Shell
// can watch the clipboard through Meta.Selection, so that is where Clipdeck
// lives.

import Clutter from 'gi://Clutter';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as AnimationUtils from 'resource:///org/gnome/shell/misc/animationUtils.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {CLIPDECK_ACCENT, popupAccentCss, resolveAccent} from './accent.js';

const MAX_TEXT_LENGTH = 100_000;
const PREVIEW_MAX_CHARS = 160;
const PREVIEW_MAX_LINES = 3;
const PASTE_DELAY_MS = 120;
const SCREEN_MARGIN = 12;
const CARET_GAP = 6;

const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
// Inner width of a card: popup 380px - list padding - card padding/border.
const THUMB_WIDTH = 344;
const THUMB_MIN_HEIGHT = 48;
const THUMB_MAX_HEIGHT = 180;

const OPEN_DURATION_MS = 200;
const CLOSE_DURATION_MS = 110;
const ITEM_STAGGER_MS = 22;
const ITEM_STAGGER_COUNT = 8;

// MIME types that mean "this clipboard content has a text form".
const TEXT_MIMES = ['text/plain', 'text/plain;charset=utf-8', 'UTF8_STRING', 'STRING', 'TEXT'];
// Preferred image formats, best first. GNOME screenshots use image/png.
const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/bmp', 'image/gif'];

// Password managers (KeePassXC, etc.) tag secrets with this MIME type.
const PASSWORD_HINT_MIME = 'x-kde-passwordManagerHint';

// Terminals paste with Ctrl+Shift+V instead of Ctrl+V.
const TERMINAL_WM_CLASSES = [
    'gnome-terminal',
    'org.gnome.console',
    'kgx',
    'org.gnome.ptyxis',
    'ptyxis',
    'kitty',
    'alacritty',
    'wezterm',
    'tilix',
    'terminator',
    'xterm',
    'konsole',
    'foot',
];

/** St.BoxLayout changed from `vertical` to `orientation` in GNOME 48. */
function makeBox(params, vertical = false) {
    const box = new St.BoxLayout(params);
    if ('orientation' in box) {
        box.orientation = vertical
            ? Clutter.Orientation.VERTICAL
            : Clutter.Orientation.HORIZONTAL;
    } else {
        box.vertical = vertical;
    }
    return box;
}

/**
 * Put a scrollable child into an St.ScrollView.
 *
 * GNOME 45: St.ScrollView is an St.Bin, and only ClutterContainer.add_actor()
 * registers the scrollable child. St.Bin.set_child() adds the actor but leaves
 * the scroll view's internal child unset, so the view measures 0px high and the
 * list is invisible. GNOME 46+ removed add_actor() and uses set_child().
 */
function setScrollChild(scrollView, child) {
    if (typeof scrollView.add_actor === 'function')
        scrollView.add_actor(child);
    else
        scrollView.set_child(child);
}

/** Short, card-friendly preview of a clipboard entry. */
function makePreview(text) {
    const lines = text.trim().replace(/\t/g, '    ').split(/\r?\n/);
    let preview = lines.slice(0, PREVIEW_MAX_LINES).join('\n');
    const cut = lines.length > PREVIEW_MAX_LINES;

    if (preview.length > PREVIEW_MAX_CHARS)
        return `${preview.slice(0, PREVIEW_MAX_CHARS).trimEnd()}…`;
    if (cut)
        preview += ' …';
    return preview;
}

/**
 * Where should the popup appear? Like Windows, prefer the text caret of the
 * field being typed in, then the focused window, then the mouse pointer.
 *
 * The caret is only known when the app reports it to GNOME's input method
 * (native Wayland apps using text-input, with IBus running). XWayland apps such
 * as Chrome without --ozone-platform=wayland do not, so they fall back to the
 * focused window.
 */
function getTypingAnchor() {
    const window = global.display.get_focus_window();
    const frame = window?.get_frame_rect();

    const im = Main.inputMethod;
    const caret = im?._currentFocus ? im._cursorRect : null;
    if (caret && caret.width >= 0 && caret.height > 0 &&
        (!frame || rectContains(frame, caret.x, caret.y))) {
        return {
            source: 'caret',
            x: caret.x,
            y: caret.y,
            height: caret.height,
            centered: false,
        };
    }

    if (frame && frame.width > 0 && frame.height > 0) {
        // Horizontally centered, a third of the way down: roughly where text
        // fields sit in most windows (search boxes, chat inputs, editors).
        return {
            source: 'window',
            x: frame.x + frame.width / 2,
            y: frame.y + frame.height / 3,
            height: 0,
            centered: true,
        };
    }

    const [x, y] = global.get_pointer();
    return {source: 'pointer', x, y, height: 0, centered: false};
}

/** Pick the image format to read, or null when the clipboard should be read as text. */
function pickImageMime(mimeTypes) {
    if (mimeTypes.some(mime => TEXT_MIMES.includes(mime)))
        return null;
    return IMAGE_MIMES.find(mime => mimeTypes.includes(mime)) ??
        mimeTypes.find(mime => mime.startsWith('image/')) ?? null;
}

function entryKey(entry) {
    return entry.type === 'image' ? `image:${entry.hash}` : `text:${entry.text}`;
}

/** Clear `reactive` on an actor tree so a fading popup no longer takes clicks. */
function makeUnreactive(actor) {
    actor.reactive = false;
    for (const child of actor.get_children())
        makeUnreactive(child);
}

function deleteFile(path) {
    try {
        Gio.File.new_for_path(path).delete(null);
    } catch {
        // Already gone.
    }
}

function rectContains(rect, x, y) {
    return x >= rect.x && x < rect.x + rect.width &&
        y >= rect.y && y < rect.y + rect.height;
}

function getDefaultSeat() {
    const backend = global.stage.get_context?.()?.get_backend?.() ??
        Clutter.get_default_backend();
    return backend.get_default_seat();
}

class ClipboardPopup {
    constructor(extension) {
        this._ext = extension;
        this._backdrop = null;
        this._box = null;
        this._scroll = null;
        this._list = null;
        this._grab = null;
        this._buttons = [];
    }

    get isOpen() {
        return this._backdrop !== null;
    }

    toggle() {
        if (this.isOpen)
            this.close();
        else
            this.open();
    }

    open() {
        if (this.isOpen)
            return;

        // Read where the user is typing *before* the modal grab: pushModal()
        // moves focus away from the app and the input method forgets the caret.
        const anchor = getTypingAnchor();

        try {
            this._build();
            this._show(anchor);
        } catch (e) {
            console.error(`[Clipdeck] popup failed: ${e}\n${e.stack}`);
            this.close();
        }
    }

    _build() {
        // Full-screen transparent layer: catches clicks outside the popup.
        this._backdrop = new St.Widget({
            reactive: true,
            x: 0,
            y: 0,
            width: global.stage.width,
            height: global.stage.height,
        });
        // Click anywhere outside the card closes the popup. (Clutter 45+ no
        // longer sets the event source for button events, so ask the stage
        // which actor was actually hit.)
        //
        // Clicks inside the card must PROPAGATE: since GNOME 47, St.Button
        // uses a click gesture, and an actor that stops the press event
        // cancels every gesture in the chain, so buttons never emit
        // "clicked" (this is what broke "Clear all" and clicking items).
        this._backdrop.connect('button-press-event', (actor, event) => {
            if (global.stage.get_event_actor(event) !== actor)
                return Clutter.EVENT_PROPAGATE;
            this.close();
            return Clutter.EVENT_STOP;
        });
        this._backdrop.connect('key-press-event', (_actor, event) =>
            this._onKeyPress(event));

        this._box = makeBox({style_class: 'clipdeck-popup', reactive: true}, true);
        if (this._ext.useDarkTheme)
            this._box.add_style_class_name('clipdeck-dark');
        if (this._ext.hasCustomAccent)
            this._box.add_style_class_name('clipdeck-accent');
        this._box.add_child(this._buildHeader());

        this._list = makeBox({style_class: 'clipdeck-list', x_expand: true}, true);
        this._scroll = new St.ScrollView({
            style_class: 'clipdeck-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: true,
        });
        setScrollChild(this._scroll, this._list);
        this._box.add_child(this._scroll);

        this._box.add_child(new St.Label({
            style_class: 'clipdeck-footer',
            text: 'Click or Enter to paste   ·   Del remove   ·   click outside to close',
        }));

        this._backdrop.add_child(this._box);
        Main.uiGroup.add_child(this._backdrop);
    }

    _show(anchor) {
        this._grab = Main.pushModal(this._backdrop, {actionMode: Shell.ActionMode.POPUP});
        // Clutter.Grab.get_seat_state() only exists on GNOME 47+; older
        // versions have no way to ask, so assume the grab worked.
        const canCheck = typeof this._grab.get_seat_state === 'function';
        if (canCheck &&
            (this._grab.get_seat_state() & Clutter.GrabState.KEYBOARD) === 0) {
            // Another component holds the keyboard; bail out cleanly.
            console.warn('[Clipdeck] could not grab keyboard, popup closed');
            this.close();
            return;
        }

        const animate = !this._ext.reduceMotion;
        this._rebuildList(animate);
        const fromAbove = this._placeAt(anchor);
        this._focusIndex(0);

        if (!animate)
            return;

        // Grow out of the text field: slightly scaled down and shifted towards
        // the anchor, then ease into place.
        this._box.set_pivot_point(0.5, fromAbove ? 1 : 0);
        this._box.opacity = 0;
        this._box.scale_x = 0.94;
        this._box.scale_y = 0.94;
        this._box.translation_y = fromAbove ? 10 : -10;
        this._box.ease({
            opacity: 255,
            scale_x: 1,
            scale_y: 1,
            translation_y: 0,
            duration: OPEN_DURATION_MS,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
    }

    close({animate = true} = {}) {
        if (!this.isOpen)
            return;

        // Release the keyboard right away so focus goes back to the app (the
        // paste keystroke must reach it); only the fade-out is delayed.
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }

        const backdrop = this._backdrop;
        const box = this._box;
        this._backdrop = null;
        this._box = null;
        this._scroll = null;
        this._list = null;
        this._buttons = [];

        if (!animate || !box || this._ext.reduceMotion) {
            backdrop.destroy();
            return;
        }

        makeUnreactive(backdrop);
        box.remove_all_transitions();
        box.ease({
            opacity: 0,
            scale_x: 0.97,
            scale_y: 0.97,
            duration: CLOSE_DURATION_MS,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onStopped: () => backdrop.destroy(),
        });
    }

    refresh() {
        if (!this.isOpen)
            return;
        const index = this._currentIndex();
        this._rebuildList();
        this._focusIndex(Math.min(Math.max(index, 0), this._buttons.length - 1));
    }

    _buildHeader() {
        const header = makeBox({style_class: 'clipdeck-header', x_expand: true});

        header.add_child(new St.Label({
            style_class: 'clipdeck-title',
            text: 'Clipboard',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));

        const clearButton = new St.Button({
            style_class: 'clipdeck-clear-button',
            label: 'Clear all',
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        clearButton.connect('clicked', () => {
            this._ext.clearHistory();
            this.refresh();
        });
        header.add_child(clearButton);

        return header;
    }

    _rebuildList(animate = false) {
        this._list.destroy_all_children();
        this._buttons = [];

        const history = this._ext.history;
        if (history.length === 0) {
            this._list.add_child(new St.Label({
                style_class: 'clipdeck-empty',
                text: 'Nothing here yet.\nCopy some text or take a screenshot\nand it will show up here.',
                x_expand: true,
                x_align: Clutter.ActorAlign.CENTER,
            }));
            return;
        }

        history.forEach((entry, i) => {
            const button = new St.Button({
                style_class: 'clipdeck-item',
                can_focus: true,
                x_expand: true,
                child: entry.type === 'image'
                    ? this._buildImagePreview(entry)
                    : this._buildTextPreview(entry),
            });
            button.connect('clicked', () => this._ext.activateEntry(entry));
            button.connect('key-focus-in', () => {
                if (this._scroll)
                    AnimationUtils.ensureActorVisibleInScrollView(this._scroll, button);
            });
            button._clipdeckEntry = entry;

            this._list.add_child(button);
            this._buttons.push(button);

            // Cards slide in one after another when the popup opens.
            if (animate && i < ITEM_STAGGER_COUNT) {
                button.opacity = 0;
                button.translation_y = 8;
                button.ease({
                    opacity: 255,
                    translation_y: 0,
                    delay: 40 + i * ITEM_STAGGER_MS,
                    duration: 220,
                    mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                });
            }
        });
    }

    _buildTextPreview(entry) {
        const label = new St.Label({
            style_class: 'clipdeck-item-text',
            text: makePreview(entry.text),
            x_expand: true,
            x_align: Clutter.ActorAlign.START,
        });
        label.clutter_text.line_wrap = true;
        label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        return label;
    }

    _buildImagePreview(entry) {
        const box = makeBox({x_expand: true}, true);

        let height = THUMB_MAX_HEIGHT;
        if (entry.width > 0 && entry.height > 0)
            height = Math.round(THUMB_WIDTH * entry.height / entry.width);
        height = Math.max(THUMB_MIN_HEIGHT, Math.min(height, THUMB_MAX_HEIGHT));

        const uri = Gio.File.new_for_path(entry.path).get_uri();
        box.add_child(new St.Widget({
            style_class: 'clipdeck-item-image',
            style: `background-image: url("${uri}");`,
            x_expand: true,
            height,
        }));

        const size = entry.width > 0 ? `  ·  ${entry.width} × ${entry.height}` : '';
        box.add_child(new St.Label({
            style_class: 'clipdeck-item-caption',
            text: `Image${size}`,
        }));
        return box;
    }

    _placeAt(anchor) {
        const monitor = Main.layoutManager.monitors.find(m =>
            rectContains(m, anchor.x, anchor.y)) ?? Main.layoutManager.primaryMonitor;

        const [, width] = this._box.get_preferred_width(-1);
        const [, height] = this._box.get_preferred_height(width);

        const minX = monitor.x + SCREEN_MARGIN;
        const minY = monitor.y + SCREEN_MARGIN;
        const maxX = monitor.x + monitor.width - width - SCREEN_MARGIN;
        const maxY = monitor.y + monitor.height - height - SCREEN_MARGIN;

        let x = anchor.x;
        let y = anchor.y + anchor.height + CARET_GAP;
        if (anchor.centered)
            x -= width / 2;
        // Not enough room below the caret: open above it instead.
        let fromAbove = false;
        if (anchor.source === 'caret' && y > maxY) {
            y = anchor.y - height - CARET_GAP;
            fromAbove = true;
        }

        x = Math.max(minX, Math.min(x, maxX));
        y = Math.max(minY, Math.min(y, maxY));
        this._box.set_position(Math.round(x), Math.round(y));
        return fromAbove;
    }

    _currentIndex() {
        return this._buttons.indexOf(global.stage.get_key_focus());
    }

    _focusIndex(index) {
        if (this._buttons.length === 0) {
            global.stage.set_key_focus(this._backdrop);
            return;
        }
        const clamped = Math.min(Math.max(index, 0), this._buttons.length - 1);
        this._buttons[clamped].grab_key_focus();
    }

    _onKeyPress(event) {
        const symbol = event.get_key_symbol();
        const index = this._currentIndex();

        switch (symbol) {
        case Clutter.KEY_Escape:
            this.close();
            return Clutter.EVENT_STOP;

        case Clutter.KEY_Down:
            this._focusIndex(index < 0 ? 0 : index + 1);
            return Clutter.EVENT_STOP;

        case Clutter.KEY_Up:
            this._focusIndex(index < 0 ? 0 : index - 1);
            return Clutter.EVENT_STOP;

        case Clutter.KEY_Home:
            this._focusIndex(0);
            return Clutter.EVENT_STOP;

        case Clutter.KEY_End:
            this._focusIndex(this._buttons.length - 1);
            return Clutter.EVENT_STOP;

        case Clutter.KEY_Delete:
            if (index >= 0) {
                this._ext.removeEntry(this._buttons[index]._clipdeckEntry);
                this.refresh();
            }
            return Clutter.EVENT_STOP;

        case Clutter.KEY_Return:
        case Clutter.KEY_KP_Enter:
            // St.Button already handles Enter when it has focus; this covers
            // the case where focus sits somewhere else in the popup.
            if (index >= 0)
                this._ext.activateEntry(this._buttons[index]._clipdeckEntry);
            return Clutter.EVENT_STOP;

        default:
            return Clutter.EVENT_PROPAGATE;
        }
    }
}

export default class ClipdeckExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._history = [];
        this._pasteTimeoutId = 0;
        this._imageDir = this._prepareImageDir();
        this._clipboard = St.Clipboard.get_default();
        this._virtualKeyboard = getDefaultSeat().create_virtual_device(
            Clutter.InputDeviceType.KEYBOARD_DEVICE);

        this._selection = global.display.get_selection();
        this._ownerChangedId = this._selection.connect('owner-changed',
            (_selection, type, source) => {
                if (type === Meta.SelectionType.SELECTION_CLIPBOARD)
                    this._onClipboardChanged(source);
            });

        this._interfaceSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._settingsChangedIds = [
            this._settings.connect('changed::history-size', () => this._trimHistory()),
            this._settings.connect('changed::accent-color', () => this._applyAccent()),
        ];
        // GNOME 47+ has a system accent colour that "Follow system" tracks.
        this._interfaceChangedId = this._interfaceSettings.settings_schema.has_key('accent-color')
            ? this._interfaceSettings.connect('changed::accent-color', () => this._applyAccent())
            : 0;

        // A shell theme change replaces the St.Theme and drops our stylesheet.
        this._themeContext = St.ThemeContext.get_for_stage(global.stage);
        this._themeChangedId = this._themeContext.connect('changed', () => this._applyAccent(true));
        this._accentDir = this._prepareCacheDir('theme');
        this._accentFile = null;
        this._accentHex = null;
        this._applyAccent();

        this._popup = new ClipboardPopup(this);

        const action = Main.wm.addKeybinding(
            'toggle-popup',
            this._settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP,
            () => {
                try {
                    this._popup.toggle();
                } catch (e) {
                    console.error(`[Clipdeck] popup failed: ${e}\n${e.stack}`);
                }
            });

        if (!action)
            console.warn('[Clipdeck] shortcut could not be registered (already taken?)');

        // Pick up whatever is already on the clipboard.
        this._onClipboardChanged(null);
    }

    disable() {
        Main.wm.removeKeybinding('toggle-popup');

        this._settingsChangedIds?.forEach(id => this._settings.disconnect(id));
        this._settingsChangedIds = null;
        if (this._interfaceChangedId)
            this._interfaceSettings.disconnect(this._interfaceChangedId);
        this._interfaceChangedId = 0;
        this._interfaceSettings = null;

        if (this._themeChangedId)
            this._themeContext.disconnect(this._themeChangedId);
        this._themeChangedId = 0;
        this._unloadAccent();
        this._themeContext = null;
        this._accentDir = null;

        this._popup?.close({animate: false});
        this._popup = null;

        if (this._ownerChangedId) {
            this._selection.disconnect(this._ownerChangedId);
            this._ownerChangedId = 0;
        }
        this._selection = null;

        if (this._pasteTimeoutId) {
            GLib.source_remove(this._pasteTimeoutId);
            this._pasteTimeoutId = 0;
        }

        // History lives in memory, so its image files go with it.
        this._history?.forEach(entry => this._disposeEntry(entry));
        this._history = null;

        this._virtualKeyboard = null;
        this._clipboard = null;
        this._imageDir = null;
        this._settings = null;
    }

    get history() {
        return this._history ?? [];
    }

    get reduceMotion() {
        return this._settings?.get_boolean('reduce-motion') ?? false;
    }

    get hasCustomAccent() {
        return this._accentFile !== null;
    }

    get useDarkTheme() {
        const theme = this._settings?.get_string('theme') ?? 'system';
        if (theme !== 'system')
            return theme === 'dark';
        return this._interfaceSettings?.get_string('color-scheme') === 'prefer-dark';
    }

    clearHistory() {
        this._history.forEach(entry => this._disposeEntry(entry));
        this._history.length = 0;
    }

    removeEntry(entry) {
        const index = this._history.indexOf(entry);
        if (index >= 0) {
            this._history.splice(index, 1);
            this._disposeEntry(entry);
        }
    }

    /** Put an entry back on the clipboard and paste it into the focused window. */
    activateEntry(entry) {
        this._popup.close();

        if (entry.type !== 'image') {
            this._clipboard.set_text(St.ClipboardType.CLIPBOARD, entry.text);
            this._addEntry(entry);
            this._schedulePaste();
            return;
        }

        Gio.File.new_for_path(entry.path).load_contents_async(null, (file, result) => {
            let contents;
            try {
                [, contents] = file.load_contents_finish(result);
            } catch (e) {
                console.warn(`[Clipdeck] could not read image ${entry.path}: ${e.message}`);
                return;
            }
            if (!this._history)
                return;
            this._clipboard.set_content(St.ClipboardType.CLIPBOARD, entry.mime,
                new GLib.Bytes(contents));
            this._addEntry(entry);
            this._schedulePaste();
        });
    }

    _schedulePaste() {
        // Give the target window a moment to get keyboard focus back.
        if (this._pasteTimeoutId)
            GLib.source_remove(this._pasteTimeoutId);
        this._pasteTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PASTE_DELAY_MS, () => {
            this._pasteTimeoutId = 0;
            this._sendPasteShortcut();
            return GLib.SOURCE_REMOVE;
        });
    }

    _onClipboardChanged(source) {
        const mimeTypes = source?.get_mimetypes?.() ??
            this._clipboard.get_mimetypes(St.ClipboardType.CLIPBOARD) ?? [];
        if (mimeTypes.includes(PASSWORD_HINT_MIME))
            return;

        // Screenshots (PrtScr) and "Copy image" put only image data on the
        // clipboard. Anything that also offers text is stored as text.
        const imageMime = pickImageMime(mimeTypes);
        if (imageMime) {
            if (this._settings.get_boolean('enable-images'))
                this._captureImage(imageMime);
            return;
        }

        this._clipboard.get_text(St.ClipboardType.CLIPBOARD, (_clipboard, text) => {
            // The callback can arrive after disable().
            if (!this._history || !text || !text.trim())
                return;
            if (text.length > MAX_TEXT_LENGTH)
                return;
            this._addEntry({type: 'text', text});
        });
    }

    _captureImage(mime) {
        this._clipboard.get_content(St.ClipboardType.CLIPBOARD, mime, (_clipboard, bytes) => {
            if (!this._history || !bytes)
                return;
            const size = bytes.get_size();
            if (size === 0 || size > MAX_IMAGE_BYTES)
                return;

            const hash = GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA256, bytes);
            const known = this._history.find(entry => entry.hash === hash);
            if (known) {
                this._addEntry(known);
                return;
            }

            // Keep image data on disk instead of in GNOME Shell's memory; the
            // popup shows it straight from the file.
            const ext = mime.split('/')[1].replace(/[^a-z0-9]/gi, '') || 'img';
            const file = this._imageDir.get_child(`${hash}.${ext}`);
            file.replace_contents_bytes_async(bytes, null, false,
                Gio.FileCreateFlags.REPLACE_DESTINATION, null, (_file, result) => {
                    try {
                        file.replace_contents_finish(result);
                    } catch (e) {
                        console.warn(`[Clipdeck] could not save image: ${e.message}`);
                        return;
                    }
                    if (!this._history) {
                        deleteFile(file.get_path());
                        return;
                    }

                    let width = 0, height = 0;
                    try {
                        [, width, height] = GdkPixbuf.Pixbuf.get_file_info(file.get_path());
                    } catch {
                        // Unknown format: show a default-sized preview.
                    }
                    this._addEntry({type: 'image', hash, mime, path: file.get_path(), width, height});
                });
        });
    }

    _addEntry(entry) {
        const key = entryKey(entry);
        const existing = this._history.findIndex(e => entryKey(e) === key);
        if (existing === 0)
            return;
        if (existing > 0)
            entry = this._history.splice(existing, 1)[0];

        entry.time = Date.now();
        this._history.unshift(entry);
        this._trimHistory();

        this._popup?.refresh();
    }

    _trimHistory() {
        const max = this._settings.get_int('history-size');
        while (this._history.length > max)
            this._disposeEntry(this._history.pop());
    }

    _disposeEntry(entry) {
        if (entry?.type === 'image' && !this._history?.some(e => e !== entry && e.path === entry.path))
            deleteFile(entry.path);
    }

    /**
     * Load a small generated stylesheet with the chosen accent colour. The
     * file name contains the colour, so St never serves a stale cached copy.
     */
    _applyAccent(themeChanged = false) {
        // Loading a stylesheet emits St.ThemeContext::changed synchronously.
        if (this._applyingAccent)
            return;
        this._applyingAccent = true;
        try {
            this._doApplyAccent(themeChanged);
        } finally {
            this._applyingAccent = false;
        }
    }

    _doApplyAccent(themeChanged) {
        const systemAccent = this._interfaceChangedId
            ? this._interfaceSettings.get_string('accent-color')
            : null;
        // An outdated compiled schema (older install) may lack the key.
        const value = this._settings.settings_schema.has_key('accent-color')
            ? this._settings.get_string('accent-color')
            : 'clipdeck';
        const hex = resolveAccent(value, systemAccent);
        if (hex === this._accentHex && !themeChanged)
            return;

        // stylesheet.css already uses the Clipdeck purple.
        const theme = this._themeContext.get_theme();
        const loaded = this._accentFile &&
            theme.get_custom_stylesheets().some(f => f.equal(this._accentFile));
        if (hex === this._accentHex && loaded)
            return;

        this._unloadAccent();
        this._accentHex = hex;
        if (hex === CLIPDECK_ACCENT)
            return;

        const file = this._accentDir.get_child(`accent-${hex.slice(1)}.css`);
        try {
            file.replace_contents(new TextEncoder().encode(popupAccentCss(hex)), null, false,
                Gio.FileCreateFlags.REPLACE_DESTINATION, null);
            this._accentFile = file;
            theme.load_stylesheet(file);
        } catch (e) {
            this._accentFile = null;
            console.warn(`[Clipdeck] could not apply accent colour ${hex}: ${e.message}`);
            deleteFile(file.get_path());
        }
    }

    _unloadAccent() {
        if (!this._accentFile)
            return;
        this._themeContext?.get_theme()?.unload_stylesheet(this._accentFile);
        deleteFile(this._accentFile.get_path());
        this._accentFile = null;
        this._accentHex = null;
    }

    _prepareImageDir() {
        return this._prepareCacheDir('images');
    }

    /** ~/.cache/clipdeck/<name>, emptied: nothing in it outlives a session. */
    _prepareCacheDir(name) {
        const path = GLib.build_filenamev([GLib.get_user_cache_dir(), 'clipdeck', name]);
        GLib.mkdir_with_parents(path, 0o700);
        const dir = Gio.File.new_for_path(path);

        // Leftovers from a previous session: history is in memory only.
        try {
            const children = dir.enumerate_children('standard::name',
                Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
            let info;
            while ((info = children.next_file(null)) !== null)
                deleteFile(dir.get_child(info.get_name()).get_path());
            children.close(null);
        } catch (e) {
            console.warn(`[Clipdeck] could not clean ${path}: ${e.message}`);
        }
        return dir;
    }

    _sendPasteShortcut() {
        if (!this._virtualKeyboard)
            return;

        const window = global.display.get_focus_window();
        const wmClass = window?.get_wm_class()?.toLowerCase() ?? '';
        const isTerminal = TERMINAL_WM_CLASSES.some(name => wmClass.includes(name));

        const keys = isTerminal
            ? [Clutter.KEY_Control_L, Clutter.KEY_Shift_L, Clutter.KEY_v]
            : [Clutter.KEY_Control_L, Clutter.KEY_v];

        const time = GLib.get_monotonic_time();
        for (const key of keys)
            this._virtualKeyboard.notify_keyval(time, key, Clutter.KeyState.PRESSED);
        for (const key of [...keys].reverse())
            this._virtualKeyboard.notify_keyval(time, key, Clutter.KeyState.RELEASED);
    }
}