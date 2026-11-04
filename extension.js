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
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as AnimationUtils from 'resource:///org/gnome/shell/misc/animationUtils.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const MAX_ITEMS = 50;
const MAX_TEXT_LENGTH = 100_000;
const PREVIEW_MAX_CHARS = 160;
const PREVIEW_MAX_LINES = 3;
const PASTE_DELAY_MS = 120;
const SCREEN_MARGIN = 12;
const CARET_GAP = 6;

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
        this._backdrop.connect('button-press-event', (actor, event) => {
            if (event.get_source() === actor)
                this.close();
            return Clutter.EVENT_STOP;
        });
        this._backdrop.connect('key-press-event', (_actor, event) =>
            this._onKeyPress(event));

        this._box = makeBox({style_class: 'clipdeck-popup', reactive: true}, true);
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
            text: '↑↓ navigate   ·   Enter paste   ·   Del remove   ·   Esc close',
        }));

        this._backdrop.add_child(this._box);
        Main.uiGroup.add_child(this._backdrop);
    }

    _show(anchor) {
        this._grab = Main.pushModal(this._backdrop, {actionMode: Shell.ActionMode.POPUP});
        if ((this._grab.get_seat_state() & Clutter.GrabState.KEYBOARD) === 0) {
            // Another component holds the keyboard; bail out cleanly.
            console.warn('[Clipdeck] could not grab keyboard, popup closed');
            this.close();
            return;
        }

        this._rebuildList();
        this._placeAt(anchor);
        this._focusIndex(0);

        console.log(`[Clipdeck] popup opened at ${this._box.x},${this._box.y} ` +
            `(anchor: ${anchor.source}), items=${this._buttons.length}`);

        this._box.opacity = 0;
        this._box.translation_y = 6;
        this._box.ease({
            opacity: 255,
            translation_y: 0,
            duration: 140,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    close() {
        if (!this.isOpen)
            return;

        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }

        this._backdrop?.destroy();
        this._backdrop = null;
        this._box = null;
        this._scroll = null;
        this._list = null;
        this._buttons = [];
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

    _rebuildList() {
        this._list.destroy_all_children();
        this._buttons = [];

        const history = this._ext.history;
        if (history.length === 0) {
            this._list.add_child(new St.Label({
                style_class: 'clipdeck-empty',
                text: 'Nothing here yet.\nCopy some text and it will show up here.',
                x_expand: true,
                x_align: Clutter.ActorAlign.CENTER,
            }));
            return;
        }

        for (const entry of history) {
            const label = new St.Label({
                style_class: 'clipdeck-item-text',
                text: makePreview(entry.text),
                x_expand: true,
                x_align: Clutter.ActorAlign.START,
            });
            label.clutter_text.line_wrap = true;
            label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
            label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;

            const button = new St.Button({
                style_class: 'clipdeck-item',
                can_focus: true,
                x_expand: true,
                child: label,
            });
            button.connect('clicked', () => this._ext.activateEntry(entry));
            button.connect('key-focus-in', () => {
                if (this._scroll)
                    AnimationUtils.ensureActorVisibleInScrollView(this._scroll, button);
            });
            button._clipdeckEntry = entry;

            this._list.add_child(button);
            this._buttons.push(button);
        }
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
        if (anchor.source === 'caret' && y > maxY)
            y = anchor.y - height - CARET_GAP;

        x = Math.max(minX, Math.min(x, maxX));
        y = Math.max(minY, Math.min(y, maxY));
        this._box.set_position(Math.round(x), Math.round(y));
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
        this._clipboard = St.Clipboard.get_default();
        this._virtualKeyboard = getDefaultSeat().create_virtual_device(
            Clutter.InputDeviceType.KEYBOARD_DEVICE);

        this._selection = global.display.get_selection();
        this._ownerChangedId = this._selection.connect('owner-changed',
            (_selection, type, source) => {
                if (type === Meta.SelectionType.SELECTION_CLIPBOARD)
                    this._onClipboardChanged(source);
            });

        this._popup = new ClipboardPopup(this);

        const action = Main.wm.addKeybinding(
            'toggle-popup',
            this._settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP,
            () => {
                console.log('[Clipdeck] shortcut pressed');
                try {
                    this._popup.toggle();
                } catch (e) {
                    console.error(`[Clipdeck] popup failed: ${e}\n${e.stack}`);
                }
            });

        console.log(`[Clipdeck] enabled, shortcut=${JSON.stringify(
            this._settings.get_strv('toggle-popup'))}, action=${action}`);
        if (!action)
            console.warn('[Clipdeck] shortcut could not be registered (already taken?)');

        // Pick up whatever is already on the clipboard.
        this._onClipboardChanged(null);
    }

    disable() {
        Main.wm.removeKeybinding('toggle-popup');

        this._popup?.close();
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

        this._virtualKeyboard = null;
        this._clipboard = null;
        this._history = null;
        this._settings = null;
    }

    get history() {
        return this._history ?? [];
    }

    clearHistory() {
        this._history.length = 0;
    }

    removeEntry(entry) {
        const index = this._history.indexOf(entry);
        if (index >= 0)
            this._history.splice(index, 1);
    }

    /** Put an entry back on the clipboard and paste it into the focused window. */
    activateEntry(entry) {
        this._clipboard.set_text(St.ClipboardType.CLIPBOARD, entry.text);
        this._addToHistory(entry.text);
        this._popup.close();

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
        const mimeTypes = source?.get_mimetypes?.() ?? [];
        if (mimeTypes.includes(PASSWORD_HINT_MIME))
            return;

        this._clipboard.get_text(St.ClipboardType.CLIPBOARD, (_clipboard, text) => {
            // The callback can arrive after disable().
            if (!this._history || !text || !text.trim())
                return;
            if (text.length > MAX_TEXT_LENGTH)
                return;
            this._addToHistory(text);
        });
    }

    _addToHistory(text) {
        const existing = this._history.findIndex(entry => entry.text === text);
        if (existing === 0)
            return;
        if (existing > 0)
            this._history.splice(existing, 1);

        this._history.unshift({text, time: Date.now()});
        if (this._history.length > MAX_ITEMS)
            this._history.length = MAX_ITEMS;
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