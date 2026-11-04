UUID       := clipdeck@divasatriaa.github.io
APP_ID     := io.github.divasatriaa.Clipdeck
VERSION    := $(shell sed -n 's/.*"version-name": *"\([^"]*\)".*/\1/p' extension/metadata.json)
MAINTAINER ?= divasatriaa <divasatriaa@users.noreply.github.com>

DIST       := dist
ZIP        := $(DIST)/$(UUID).shell-extension.zip
DEB        := $(DIST)/clipdeck_$(VERSION)_all.deb

# Per-user install locations (make install)
LOCAL_DATA := $(HOME)/.local/share
LOCAL_BIN  := $(HOME)/.local/bin
LOCAL_APP  := $(LOCAL_DATA)/clipdeck

ICON_SIZES := 16 24 32 48 64 128 256 512

.PHONY: all pack install install-extension install-app uninstall enable disable \
        run-app schemas deb logs lint clean help

all: pack

help:
	@echo "make install    Install the extension and the settings app for this user"
	@echo "make uninstall  Remove both again"
	@echo "make deb        Build $(DEB) (install with: sudo apt install ./$(DEB))"
	@echo "make run-app    Run the settings app from this folder"
	@echo "make enable     Turn the extension on   |  make disable  Turn it off"
	@echo "make logs       Follow GNOME Shell logs"

## ---------------------------------------------------------------- extension

pack:
	mkdir -p $(DIST)
	gnome-extensions pack --force --out-dir=$(DIST) extension

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
	install -m644 app/main.js assets/logo.png $(LOCAL_APP)/
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

## ---------------------------------------------------------------------- deb

deb:
	rm -rf $(DIST)/deb
	$(eval ROOT := $(DIST)/deb)
	install -d $(ROOT)/DEBIAN $(ROOT)/usr/bin $(ROOT)/usr/share/clipdeck \
		$(ROOT)/usr/share/applications $(ROOT)/usr/share/metainfo \
		$(ROOT)/usr/share/glib-2.0/schemas $(ROOT)/usr/share/doc/clipdeck \
		$(ROOT)/usr/share/gnome-shell/extensions/$(UUID)
	# GNOME Shell extension (schema goes to the system schema directory)
	install -m644 extension/metadata.json extension/extension.js extension/stylesheet.css \
		$(ROOT)/usr/share/gnome-shell/extensions/$(UUID)/
	install -m644 extension/schemas/org.gnome.shell.extensions.clipdeck.gschema.xml \
		$(ROOT)/usr/share/glib-2.0/schemas/
	# Settings app
	install -m644 app/main.js assets/logo.png $(ROOT)/usr/share/clipdeck/
	sed 's|@APPDIR@|/usr/share/clipdeck|' app/clipdeck.in > $(ROOT)/usr/bin/clipdeck
	chmod 755 $(ROOT)/usr/bin/clipdeck
	sed 's|@BINDIR@|/usr/bin|' data/$(APP_ID).desktop.in > $(ROOT)/usr/share/applications/$(APP_ID).desktop
	install -m644 data/$(APP_ID).metainfo.xml $(ROOT)/usr/share/metainfo/
	for size in $(ICON_SIZES); do \
		install -Dm644 data/icons/hicolor/$${size}x$${size}/apps/$(APP_ID).png \
			$(ROOT)/usr/share/icons/hicolor/$${size}x$${size}/apps/$(APP_ID).png; \
	done
	install -m644 packaging/debian/copyright $(ROOT)/usr/share/doc/clipdeck/
	# Package metadata
	sed -e 's|@VERSION@|$(VERSION)|' -e 's|@MAINTAINER@|$(MAINTAINER)|' \
		packaging/debian/control.in > $(ROOT)/DEBIAN/control
	echo "Installed-Size: $$(du -sk --exclude=DEBIAN $(ROOT) | cut -f1)" >> $(ROOT)/DEBIAN/control
	install -m755 packaging/debian/postinst $(ROOT)/DEBIAN/
	dpkg-deb --root-owner-group --build $(ROOT) $(DEB)
	@echo
	@echo "Built $(DEB). Install it with: sudo apt install ./$(DEB)"

## -------------------------------------------------------------------- misc

logs:
	journalctl -f -o cat /usr/bin/gnome-shell

clean:
	rm -rf $(DIST) extension/schemas/gschemas.compiled
