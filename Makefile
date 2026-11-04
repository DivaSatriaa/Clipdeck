UUID := clipdeck@sidrusgemink.github.io
DIST := dist
ZIP  := $(DIST)/$(UUID).shell-extension.zip

.PHONY: pack install enable disable reinstall logs clean

## Build the installable zip (schemas are compiled automatically)
pack:
	mkdir -p $(DIST)
	gnome-extensions pack --force --out-dir=$(DIST) .

## Install into ~/.local/share/gnome-shell/extensions
install: pack
	gnome-extensions install --force $(ZIP)

enable:
	gnome-extensions enable $(UUID)

disable:
	gnome-extensions disable $(UUID)

## Re-pack and re-install after editing code (then log out & in on Wayland)
reinstall: install

## Follow GNOME Shell logs (errors from the extension show up here)
logs:
	journalctl -f -o cat /usr/bin/gnome-shell

clean:
	rm -rf $(DIST)
