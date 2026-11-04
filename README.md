# Clipdeck

Windows 11-style clipboard history for GNOME. Press **Super+V**, pick an item, and it is pasted straight into the field you were typing in.

> Status: early development (v0.1.0). History is kept in memory for now and is cleared when you log out.

## Features

- Clipboard history for text, newest first, duplicates moved to the top
- Popup opens at the text caret (or over the focused window) with **Super+V**
- Click or press **Enter** to paste directly into the focused app
- Terminal-aware paste (sends Ctrl+Shift+V in terminals)
- Keyboard navigation: ↑ ↓ Home End, **Del** to remove an item, **Esc** to close
- Skips entries that password managers mark as secret
- Works on Wayland and X11

## Why a GNOME Shell extension?

On GNOME Wayland, only the focused window receives clipboard events, and GNOME's compositor (Mutter) does not expose the data-control protocol that clipboard managers use on other desktops. A regular background app therefore cannot see what you copy.

Code that runs inside GNOME Shell can listen to the clipboard through `Meta.Selection`, register a global shortcut, and send a paste keystroke through a virtual keyboard device. That is why Clipdeck is built as an extension.

```
 copy (Ctrl+C) ──► Meta.Selection "owner-changed" ──► history (in memory)
                                                          │
 Super+V ──► popup (St widgets, modal) ──► pick item ─────┘
                                              │
                    St.Clipboard.set_text ◄───┘
                              │
                    virtual keyboard sends Ctrl+V ──► focused app
```

## Requirements

- GNOME Shell 45 or newer (Ubuntu 24.04 LTS and later)

## Install from source

```bash
git clone https://github.com/SidrusGemink/clipdeck.git
cd clipdeck
make install
```

GNOME uses **Super+V** for the notification list by default. Free it first:

```bash
gsettings set org.gnome.shell.keybindings toggle-message-tray "['<Super>m']"
```

Then log out and back in (required on Wayland), and enable the extension:

```bash
make enable
```

## Development

| Command          | What it does                                  |
| ---------------- | --------------------------------------------- |
| `make pack`      | Build the installable zip into `dist/`        |
| `make install`   | Install or update the extension               |
| `make enable`    | Enable the extension                          |
| `make logs`      | Follow GNOME Shell logs for errors            |

After changing code on Wayland, run `make install` and log out and back in. To test without logging out, run a nested shell in a window:

```bash
# GNOME 49 and newer (needs the mutter devkit package)
dbus-run-session gnome-shell --devkit --wayland

# GNOME 45–48
dbus-run-session -- gnome-shell --nested --wayland
```

## Roadmap

- [x] Text history, popup, paste into focused app
- [ ] Search and pinned items
- [ ] Save history to disk
- [ ] Image support
- [ ] Settings page (shortcut, history size, excluded apps)
- [ ] Dark theme that follows the system
- [ ] Publish on extensions.gnome.org

## License

GPL-2.0-or-later
