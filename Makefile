UUID       := clipdeck@divasatriaa.github.io
APP_ID     := io.github.divasatriaa.Clipdeck
VERSION    := $(shell sed -n 's/.*"version-name": *"\([^"]*\)".*/\1/p' extension/metadata.json)
MAINTAINER ?= divasatriaa <divasatriaa@users.noreply.github.com>

DIST       := dist
ZIP        := $(DIST)/$(UUID).shell-extension.zip
DEB        := $(DIST)/clipdeck_$(VERSION)_all.deb

# System-wide install (used by `make deb` and debian/rules)
PREFIX     ?= /usr
DESTDIR    ?=
SHARE      := $(DESTDIR)$(PREFIX)/share

# Per-user install locations (make install)
LOCAL_DATA := $(HOME)/.local/share
LOCAL_BIN  := $(HOME)/.local/bin
LOCAL_APP  := $(LOCAL_DATA)/clipdeck

ICON_SIZES := 16 24 32 48 64 128 256 512
EXT_FILES  := extension/metadata.json extension/extension.js extension/prefs.js \
              extension/settingsUi.js extension/stylesheet.css
APP_FILES  := app/main.js extension/settingsUi.js assets/logo.png

.PHONY: all help pack install install-extension install-app uninstall enable disable \
        schemas run-app install-system deb ppa-source logs clean

all: pack

help:
	@echo "make install         Install the extension and the settings app for this user"
	@echo "make uninstall       Remove both again"
	@echo "make deb             Build $(DEB) (install with: sudo apt install ./$(DEB))"
	@echo "make pack            Build the extension zip for extensions.gnome.org"
	@echo "make ppa-source      Build a signed source package for a Launchpad PPA"
	@echo "make run-app         Run the settings app from this folder"
	@echo "make enable/disable  Turn the extension on or off"
	@echo "make logs            Follow GNOME Shell logs"

## ---------------------------------------------------------------- extension

# The zip uploaded to extensions.gnome.org. gnome-extensions only picks up
# extension.js, prefs.js, metadata.json, stylesheet.css and schemas/ itself.
pack:
	mkdir -p $(DIST)
	gnome-extensions pack --force --out-dir=$(DIST) --extra-source=settingsUi.js extension

install-extension: pack
	gnome-extensions install --force $(ZIP)

enable:
	gnome-extensions enable $(UUID)

disable:
	gnome-extensions disable $(UUID)

## ---------------------------------------------------------------------- app

schemas:
	glib-compile-schemas extension/schemas

run-app: schemas
	gjs -m app/main.js

install-app:
	install -d $(LOCAL_APP) $(LOCAL_BIN) $(LOCAL_DATA)/applications
	install -m644 $(APP_FILES) $(LOCAL_APP)/
	sed 's|@APPDIR@|$(LOCAL_APP)|' app/clipdeck.in > $(LOCAL_BIN)/clipdeck
	chmod 755 $(LOCAL_BIN)/clipdeck
	sed 's|@BINDIR@|$(LOCAL_BIN)|' data/$(APP_ID).desktop.in \
		> $(LOCAL_DATA)/applications/$(APP_ID).desktop
	for size in $(ICON_SIZES); do \
		install -Dm644 data/icons/hicolor/$${size}x$${size}/apps/$(APP_ID).png \
			$(LOCAL_DATA)/icons/hicolor/$${size}x$${size}/apps/$(APP_ID).png; \
	done
	-gtk-update-icon-cache -q -t $(LOCAL_DATA)/icons/hicolor 2>/dev/null
	-update-desktop-database -q $(LOCAL_DATA)/applications 2>/dev/null

## ------------------------------------------------------------------ install

install: install-extension install-app
	@echo
	@echo "Installed. On Wayland, log out and back in, then open Clipdeck from the app grid."

uninstall:
	-gnome-extensions uninstall $(UUID)
	rm -rf $(LOCAL_APP)
	rm -f $(LOCAL_BIN)/clipdeck $(LOCAL_DATA)/applications/$(APP_ID).desktop
	rm -f $(foreach s,$(ICON_SIZES),$(LOCAL_DATA)/icons/hicolor/$(s)x$(s)/apps/$(APP_ID).png)

## ------------------------------------------------------- system / packages

# Installs everything under $(DESTDIR)$(PREFIX). The settings schema goes to
# the system schema directory, where the glib dpkg trigger compiles it.
install-system:
	install -d $(SHARE)/gnome-shell/extensions/$(UUID) $(SHARE)/glib-2.0/schemas \
		$(SHARE)/clipdeck $(SHARE)/applications $(SHARE)/metainfo $(DESTDIR)$(PREFIX)/bin
	install -m644 $(EXT_FILES) $(SHARE)/gnome-shell/extensions/$(UUID)/
	install -m644 extension/schemas/org.gnome.shell.extensions.clipdeck.gschema.xml \
		$(SHARE)/glib-2.0/schemas/
	install -m644 $(APP_FILES) $(SHARE)/clipdeck/
	sed 's|@APPDIR@|$(PREFIX)/share/clipdeck|' app/clipdeck.in > $(DESTDIR)$(PREFIX)/bin/clipdeck
	chmod 755 $(DESTDIR)$(PREFIX)/bin/clipdeck
	sed 's|@BINDIR@|$(PREFIX)/bin|' data/$(APP_ID).desktop.in > $(SHARE)/applications/$(APP_ID).desktop
	install -m644 data/$(APP_ID).metainfo.xml $(SHARE)/metainfo/
	for size in $(ICON_SIZES); do \
		install -Dm644 data/icons/hicolor/$${size}x$${size}/apps/$(APP_ID).png \
			$(SHARE)/icons/hicolor/$${size}x$${size}/apps/$(APP_ID).png; \
	done

# Quick binary package without debhelper: `sudo apt install ./dist/...deb`.
deb:
	rm -rf $(DIST)/deb
	$(MAKE) --no-print-directory install-system DESTDIR=$(DIST)/deb PREFIX=/usr
	install -Dm644 debian/copyright $(DIST)/deb/usr/share/doc/clipdeck/copyright
	install -d $(DIST)/deb/DEBIAN
	sed -e 's|@VERSION@|$(VERSION)|' -e 's|@MAINTAINER@|$(MAINTAINER)|' \
		packaging/control.in > $(DIST)/deb/DEBIAN/control
	echo "Installed-Size: $$(du -sk --exclude=DEBIAN $(DIST)/deb | cut -f1)" >> $(DIST)/deb/DEBIAN/control
	dpkg-deb --root-owner-group --build $(DIST)/deb $(DEB)
	@echo
	@echo "Built $(DEB). Install it with: sudo apt install ./$(DEB)"

# Signed source package for Launchpad (see docs/PUBLISHING.md).
ppa-source:
	debuild -S -sa -d

## -------------------------------------------------------------------- misc

logs:
	journalctl -f -o cat /usr/bin/gnome-shell

clean:
	rm -rf $(DIST) extension/schemas/gschemas.compiled
