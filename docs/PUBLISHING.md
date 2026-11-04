# Publishing Clipdeck

Clipdeck can be distributed in two ways. They are independent; you can do either or both.

| | extensions.gnome.org (EGO) | Launchpad PPA |
| --- | --- | --- |
| What users get | The extension, with settings under ⚙ in the Extensions app | The extension **and** the Clipdeck settings app |
| How users install | One click in the Extension Manager app or on the website | `sudo add-apt-repository ppa:…` then `sudo apt install clipdeck` |
| Works on | Any distribution with GNOME 45–50 | Ubuntu only, one upload per Ubuntu release |
| Review | Manual review by GNOME volunteers | None (your own archive) |

---

## 1. extensions.gnome.org

### Before uploading

The code already follows the [EGO review guidelines](https://gjs.guide/extensions/review-guidelines/review-guidelines.html):

- `extension.js` only imports Shell-side libraries (St, Clutter, Meta, Shell); `prefs.js` and `settingsUi.js` only import GTK and libadwaita.
- Everything created in `enable()` is destroyed in `disable()`, including the keybinding, signal handlers, timeouts, popup and cached images.
- Only warnings and errors are logged.
- The GSettings schema ID starts with `org.gnome.shell.extensions.`.

Before each upload:

1. Bump `version-name` in `extension/metadata.json` if the code changed.
2. Make sure `shell-version` only lists GNOME versions you have tested.

### Upload

1. Create an account at <https://extensions.gnome.org/accounts/register/>.
2. Build the zip:

   ```bash
   make pack
   ```

   The zip is written to `dist/clipdeck@divasatriaa.github.io.shell-extension.zip`. Check its contents with:

   ```bash
   unzip -l dist/clipdeck@divasatriaa.github.io.shell-extension.zip
   ```

   It should contain `extension.js`, `prefs.js`, `settingsUi.js`, `stylesheet.css`, `metadata.json` and `schemas/`.

3. Upload the zip at <https://extensions.gnome.org/upload/>.
4. Wait for the review, which can take from a few days to a few weeks. If the reviewer asks for changes, fix them, bump `version-name` and upload again.

After approval, people can install Clipdeck from the website or with the **Extension Manager** app (`sudo apt install gnome-shell-extension-manager` on Ubuntu).

---

## 2. Launchpad PPA

Launchpad does not accept ready-made `.deb` files. You upload a **signed source package**, and Launchpad builds the `.deb` itself. The `debian/` folder in this repository is that source package.

### One-time setup

1. Create an account at <https://launchpad.net>.
2. Install the tools:

   ```bash
   sudo apt install devscripts debhelper dput gnupg
   ```

3. Create an OpenPGP key if you do not have one. Use the **same name and email** that you will put in `debian/changelog`:

   ```bash
   gpg --full-generate-key
   ```

4. Upload the key to the Ubuntu key server and add it to your Launchpad profile (*OpenPGP keys* on your profile page). Launchpad emails you an encrypted message to confirm it:

   ```bash
   gpg --keyserver keyserver.ubuntu.com --send-keys YOUR_KEY_ID
   ```

5. On your Launchpad profile, choose **Create a new PPA** and name it `clipdeck`. Its address will be `ppa:YOUR_LAUNCHPAD_NAME/clipdeck`.

### Set the maintainer

Launchpad rejects uploads whose signature does not match the changelog. In both `debian/control` (`Maintainer:`) and `debian/changelog` (the line starting with ` -- `), replace `divasatriaa <divasatriaa@users.noreply.github.com>` with the name and email of your GPG key.

### Build and upload (Ubuntu 24.04 "noble")

```bash
make ppa-source
```

This runs `debuild -S -sa -d` and asks for your GPG passphrase. The source package is written to the folder **above** the repository. Upload it with:

```bash
dput ppa:YOUR_LAUNCHPAD_NAME/clipdeck ../clipdeck_0.2.0~noble1_source.changes
```

Launchpad emails you when the upload is accepted and again when the build finishes, usually within an hour.

### Other Ubuntu releases

Each upload targets one Ubuntu release, named in `debian/changelog`. For example, for Ubuntu 26.04 "resolute":

```bash
dch -v 0.2.0~resolute1 -D resolute "Build for Ubuntu 26.04."
```

```bash
make ppa-source
```

```bash
dput ppa:YOUR_LAUNCHPAD_NAME/clipdeck ../clipdeck_0.2.0~resolute1_source.changes
```

Because Clipdeck is architecture-independent, you can also skip the rebuild: on the PPA page, open **View package details → Copy packages** and copy the noble build to the other releases.

Check the supported release names at <https://launchpad.net/ubuntu/+series>.

### Installing from the PPA

```bash
sudo add-apt-repository ppa:YOUR_LAUNCHPAD_NAME/clipdeck
```

```bash
sudo apt install clipdeck
```

Then log out and back in, and open **Clipdeck** from the app grid.

### Test the package locally first

Build the binary package without signing, the same way Launchpad will:

```bash
dpkg-buildpackage -us -uc -b
```

```bash
sudo apt install ../clipdeck_0.2.0~noble1_all.deb
```
