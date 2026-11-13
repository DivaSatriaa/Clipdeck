// SPDX-License-Identifier: GPL-2.0-or-later
//
// clipdeck-bridge: sends new Clipdeck items to the Clipdeck Android app over
// Bluetooth (RFCOMM).
//
// GNOME Shell (the extension) cannot hold a Bluetooth connection itself, so
// this small helper does it:
//
//   extension ──ItemAdded (session D-Bus)──► bridge ──RFCOMM──► phone
//
// The bridge is D-Bus activated: the extension (or the settings app) starts
// it when "phone-sync" is on, and it exits again when the setting is off.
// It registers a BlueZ profile, so BlueZ hands it the socket of every
// paired phone that connects to the Clipdeck service UUID. Unpaired devices
// are rejected by BlueZ (RequireAuthentication).
//
// Wire format: see docs/PROTOCOL.md.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

// GLib 2.80 moved the Unix-only APIs into GioUnix / GLibUnix; older
// systems (GNOME 45) only have the Gio / GLib versions.
async function optionalImport(name) {
    try {
        return (await import(`gi://${name}`)).default;
    } catch {
        return null;
    }
}
const GioUnix = await optionalImport('GioUnix');
const GLibUnix = await optionalImport('GLibUnix');
const UnixInputStream = GioUnix?.InputStream ?? Gio.UnixInputStream;
const UnixOutputStream = GioUnix?.OutputStream ?? Gio.UnixOutputStream;
const unixSignalAdd = GLibUnix?.signal_add_full ?? GLib.unix_signal_add;

const VERSION = 1;
const SERVICE_UUID = '0a1a0290-5d48-4328-92d4-cdb628a6acb9';
const UUID = 'clipdeck@divasatriaa.github.io';
const SCHEMA_ID = 'org.gnome.shell.extensions.clipdeck';

const BUS_NAME = 'io.github.divasatriaa.Clipdeck.Bridge';
const BUS_PATH = '/io/github/divasatriaa/Clipdeck/Bridge';
const PROFILE_PATH = '/io/github/divasatriaa/Clipdeck/Profile';
const SHELL_PATH = '/io/github/divasatriaa/Clipdeck';
const SHELL_IFACE = 'io.github.divasatriaa.Clipdeck1';

const MAX_HEADER = 64 * 1024;
const MAX_PAYLOAD = 50 * 1024 * 1024;
const PING_SECONDS = 30;
// Items copied while no phone is connected are kept and sent on connect.
const MAX_PENDING = 5;

const BRIDGE_IFACE = `
<node>
  <interface name="io.github.divasatriaa.Clipdeck.Bridge1">
    <property name="Status" type="s" access="read"/>
    <property name="DeviceName" type="s" access="read"/>
    <property name="LastError" type="s" access="read"/>
  </interface>
</node>`;

const PROFILE_IFACE = `
<node>
  <interface name="org.bluez.Profile1">
    <method name="Release"/>
    <method name="NewConnection">
      <arg name="device" type="o" direction="in"/>
      <arg name="fd" type="h" direction="in"/>
      <arg name="properties" type="a{sv}" direction="in"/>
    </method>
    <method name="RequestDisconnection">
      <arg name="device" type="o" direction="in"/>
    </method>
  </interface>
</node>`;

const log = msg => console.log(`clipdeck-bridge: ${msg}`);

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

function loadSettings() {
    const defaultSource = Gio.SettingsSchemaSource.get_default();
    const fromDefault = defaultSource?.lookup(SCHEMA_ID, true);
    if (fromDefault?.has_key('phone-sync'))
        return new Gio.Settings({settings_schema: fromDefault});

    const here = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
    const dirs = [
        GLib.getenv('CLIPDECK_SCHEMA_DIR'),
        GLib.build_filenamev([GLib.get_user_data_dir(), 'gnome-shell', 'extensions', UUID, 'schemas']),
        GLib.build_filenamev(['/usr/share/gnome-shell/extensions', UUID, 'schemas']),
        GLib.build_filenamev([here, '..', 'extension', 'schemas']),
    ];
    for (const dir of dirs) {
        if (!dir || !GLib.file_test(GLib.build_filenamev([dir, 'gschemas.compiled']), GLib.FileTest.EXISTS))
            continue;
        try {
            const source = Gio.SettingsSchemaSource.new_from_directory(dir, defaultSource, false);
            const schema = source.lookup(SCHEMA_ID, false);
            if (schema?.has_key('phone-sync'))
                return new Gio.Settings({settings_schema: schema});
        } catch {
            // Try the next location.
        }
    }
    return null;
}

/* ------------------------------------------------------------------ */
/* Framing                                                             */
/* ------------------------------------------------------------------ */

/** Encode one frame: 4-byte big-endian header length, JSON header, payload. */
export function encodeFrame(header, payload = null) {
    const body = payload ?? new Uint8Array(0);
    const json = new TextEncoder().encode(JSON.stringify({...header, size: body.length}));
    const frame = new Uint8Array(4 + json.length + body.length);
    new DataView(frame.buffer).setUint32(0, json.length);
    frame.set(json, 4);
    frame.set(body, 4 + json.length);
    return frame;
}

/** One phone connection: an RFCOMM socket fd handed over by BlueZ. */
class PhoneConnection {
    constructor(fd, deviceName, callbacks) {
        this.deviceName = deviceName;
        this._callbacks = callbacks;
        this._cancellable = new Gio.Cancellable();
        this._input = new UnixInputStream({fd, close_fd: true});
        this._output = new UnixOutputStream({fd, close_fd: false});
        this._queue = [];
        this._writing = false;
        this._closed = false;

        this.send({t: 'hello', v: VERSION, name: GLib.get_host_name()});
        this._readFrame();
        this._pingId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, PING_SECONDS, () => {
            this.send({t: 'ping'});
            return GLib.SOURCE_CONTINUE;
        });
    }

    send(header, payload = null) {
        if (this._closed)
            return;
        this._queue.push(encodeFrame(header, payload));
        this._flush();
    }

    _flush() {
        if (this._writing || this._queue.length === 0 || this._closed)
            return;
        this._writing = true;
        const frame = this._queue.shift();
        this._output.write_all_async(frame, GLib.PRIORITY_DEFAULT, this._cancellable, (stream, result) => {
            this._writing = false;
            try {
                stream.write_all_finish(result);
            } catch (e) {
                this.close(`write failed: ${e.message}`);
                return;
            }
            this._flush();
        });
    }

    /** Read exactly `count` bytes, then call `done(Uint8Array)`. */
    _readExactly(count, done) {
        const chunks = [];
        let received = 0;
        const step = () => {
            if (received === count) {
                const out = new Uint8Array(count);
                let offset = 0;
                for (const c of chunks) {
                    out.set(c, offset);
                    offset += c.length;
                }
                done(out);
                return;
            }
            this._input.read_bytes_async(Math.min(count - received, 65536), GLib.PRIORITY_DEFAULT,
                this._cancellable, (stream, result) => {
                    let bytes;
                    try {
                        bytes = stream.read_bytes_finish(result);
                    } catch (e) {
                        this.close(`read failed: ${e.message}`);
                        return;
                    }
                    if (bytes.get_size() === 0) {
                        this.close('phone disconnected');
                        return;
                    }
                    const chunk = bytes.toArray();
                    chunks.push(chunk);
                    received += chunk.length;
                    step();
                });
        };
        step();
    }

    _readFrame() {
        if (this._closed)
            return;
        this._readExactly(4, lengthBytes => {
            const headerLength = new DataView(lengthBytes.buffer).getUint32(0);
            if (headerLength === 0 || headerLength > MAX_HEADER) {
                this.close(`bad header length ${headerLength}`);
                return;
            }
            this._readExactly(headerLength, headerBytes => {
                let header;
                try {
                    header = JSON.parse(new TextDecoder().decode(headerBytes));
                } catch {
                    this.close('bad header');
                    return;
                }
                const size = header.size ?? 0;
                if (size < 0 || size > MAX_PAYLOAD) {
                    this.close(`bad payload size ${size}`);
                    return;
                }
                const handle = payload => {
                    this._onFrame(header, payload);
                    this._readFrame();
                };
                if (size === 0)
                    handle(new Uint8Array(0));
                else
                    this._readExactly(size, handle);
            });
        });
    }

    _onFrame(header) {
        switch (header.t) {
        case 'hello':
            if (typeof header.name === 'string' && header.name)
                this.deviceName = header.name;
            this._callbacks.onReady(this);
            break;
        case 'ping':
            this.send({t: 'pong'});
            break;
        default:
            // 'ack', 'pong' and unknown types need no answer.
            break;
        }
    }

    close(reason = 'closed') {
        if (this._closed)
            return;
        this._closed = true;
        log(`connection to ${this.deviceName} closed: ${reason}`);
        if (this._pingId)
            GLib.source_remove(this._pingId);
        this._pingId = 0;
        this._cancellable.cancel();
        try {
            this._output.close(null);
            this._input.close(null);
        } catch {
            // Already closed.
        }
        this._callbacks.onClosed(this);
    }
}

/* ------------------------------------------------------------------ */
/* Bridge                                                              */
/* ------------------------------------------------------------------ */

class Bridge {
    constructor(loop) {
        this._loop = loop;
        this._status = 'starting';
        this._deviceName = '';
        this._lastError = '';
        this._connection = null;
        this._pending = [];
        this._nextId = 1;
        this._profileRegistered = false;
        this._shellOwner = null;
    }

    start() {
        this._settings = loadSettings();
        if (!this._settings) {
            log('settings schema with phone-sync not found; is Clipdeck installed?');
            this._loop.quit();
            return;
        }
        if (!this._settings.get_boolean('phone-sync')) {
            log('phone sync is off, exiting');
            this._loop.quit();
            return;
        }
        this._settings.connect('changed::phone-sync', () => {
            if (!this._settings.get_boolean('phone-sync')) {
                log('phone sync turned off, exiting');
                this.stop();
            }
        });

        this._bridgeImpl = Gio.DBusExportedObject.wrapJSObject(BRIDGE_IFACE, this);
        this._bridgeImpl.export(Gio.DBus.session, BUS_PATH);
        Gio.bus_own_name_on_connection(Gio.DBus.session, BUS_NAME, Gio.BusNameOwnerFlags.NONE,
            null, () => {
                log('another bridge is already running, exiting');
                this._loop.quit();
            });

        // Only trust ItemAdded signals sent by GNOME Shell itself.
        this._shellWatch = Gio.bus_watch_name_on_connection(Gio.DBus.session, 'org.gnome.Shell',
            Gio.BusNameWatcherFlags.NONE,
            (_c, _name, owner) => {
                this._shellOwner = owner;
            },
            () => {
                this._shellOwner = null;
            });
        this._itemSignal = Gio.DBus.session.signal_subscribe(null, SHELL_IFACE, 'ItemAdded',
            SHELL_PATH, null, Gio.DBusSignalFlags.NONE,
            (_c, sender, _path, _iface, _signal, params) => {
                if (sender !== this._shellOwner)
                    return;
                const [kind, text, path, mime] = params.deepUnpack();
                this._onItem(kind, text, path, mime);
            });

        this._system = Gio.DBus.system;
        this._profileImpl = Gio.DBusExportedObject.wrapJSObject(PROFILE_IFACE, this);
        this._profileImpl.export(this._system, PROFILE_PATH);
        this._bluezWatch = Gio.bus_watch_name_on_connection(this._system, 'org.bluez',
            Gio.BusNameWatcherFlags.NONE,
            () => this._registerProfile(),
            () => {
                this._profileRegistered = false;
                this._connection?.close('Bluetooth stopped');
                this._setStatus('no-bluetooth', '', 'Bluetooth is not available');
            });
    }

    stop() {
        this._connection?.close('bridge stopping');
        if (this._profileRegistered) {
            try {
                this._system.call_sync('org.bluez', '/org/bluez', 'org.bluez.ProfileManager1',
                    'UnregisterProfile', new GLib.Variant('(o)', [PROFILE_PATH]), null,
                    Gio.DBusCallFlags.NONE, 2000, null);
            } catch {
                // BlueZ already gone.
            }
        }
        this._loop.quit();
    }

    _registerProfile() {
        const options = {
            Name: new GLib.Variant('s', 'Clipdeck'),
            Role: new GLib.Variant('s', 'server'),
            RequireAuthentication: new GLib.Variant('b', true),
            RequireAuthorization: new GLib.Variant('b', false),
            AutoConnect: new GLib.Variant('b', false),
        };
        this._system.call('org.bluez', '/org/bluez', 'org.bluez.ProfileManager1', 'RegisterProfile',
            new GLib.Variant('(osa{sv})', [PROFILE_PATH, SERVICE_UUID, options]), null,
            Gio.DBusCallFlags.NONE, -1, null, (connection, result) => {
                try {
                    connection.call_finish(result);
                    this._profileRegistered = true;
                    log('Bluetooth profile registered, waiting for the phone');
                    this._setStatus('waiting', '', '');
                } catch (e) {
                    log(`could not register the Bluetooth profile: ${e.message}`);
                    this._setStatus('error', '', e.message);
                }
            });
    }

    /* ---------- org.bluez.Profile1 ---------- */

    Release() {
        this._profileRegistered = false;
    }

    NewConnectionAsync([devicePath, fdIndex], invocation) {
        let fd;
        try {
            fd = invocation.get_message().get_unix_fd_list().get(fdIndex);
        } catch (e) {
            invocation.return_dbus_error('org.bluez.Error.Rejected', `no socket: ${e.message}`);
            return;
        }
        invocation.return_value(null);

        const name = this._deviceAlias(devicePath);
        log(`phone connected: ${name}`);
        this._connection?.close('replaced by a new connection');
        this._connection = new PhoneConnection(fd, name, {
            onReady: conn => {
                if (conn !== this._connection)
                    return;
                this._setStatus('connected', conn.deviceName, '');
                for (const item of this._pending.splice(0))
                    this._sendItem(item);
            },
            onClosed: conn => {
                if (conn !== this._connection)
                    return;
                this._connection = null;
                if (this._profileRegistered)
                    this._setStatus('waiting', '', '');
            },
        });
    }

    RequestDisconnectionAsync(_params, invocation) {
        this._connection?.close('disconnect requested');
        invocation.return_value(null);
    }

    _deviceAlias(devicePath) {
        try {
            const reply = this._system.call_sync('org.bluez', devicePath,
                'org.freedesktop.DBus.Properties', 'Get',
                new GLib.Variant('(ss)', ['org.bluez.Device1', 'Alias']),
                new GLib.VariantType('(v)'), Gio.DBusCallFlags.NONE, 2000, null);
            return reply.deepUnpack()[0].deepUnpack();
        } catch {
            return 'phone';
        }
    }

    /* ---------- items ---------- */

    _onItem(kind, text, path, mime) {
        if (kind === 'image' && !this._settings.get_boolean('phone-sync-images'))
            return;
        const item = {id: this._nextId++, kind, text, path, mime};
        if (this._status === 'connected') {
            this._sendItem(item);
        } else {
            this._pending.push(item);
            if (this._pending.length > MAX_PENDING)
                this._pending.shift();
        }
    }

    _sendItem(item) {
        const conn = this._connection;
        if (!conn)
            return;
        if (item.kind === 'text') {
            conn.send({t: 'text', id: item.id}, new TextEncoder().encode(item.text));
            return;
        }
        // Only send files from Clipdeck's own image cache.
        const cache = GLib.build_filenamev([GLib.get_user_cache_dir(), 'clipdeck', 'images']);
        const file = Gio.File.new_for_path(item.path);
        if (!file.has_parent(Gio.File.new_for_path(cache))) {
            log(`ignoring image outside the cache: ${item.path}`);
            return;
        }
        file.load_contents_async(null, (f, result) => {
            try {
                const [, contents] = f.load_contents_finish(result);
                conn.send({t: 'image', id: item.id, mime: item.mime}, contents);
            } catch (e) {
                log(`could not read ${item.path}: ${e.message}`);
            }
        });
    }

    /* ---------- io.github.divasatriaa.Clipdeck.Bridge1 ---------- */

    get Status() {
        return this._status;
    }

    get DeviceName() {
        return this._deviceName;
    }

    get LastError() {
        return this._lastError;
    }

    _setStatus(status, deviceName, lastError) {
        this._status = status;
        this._deviceName = deviceName;
        this._lastError = lastError;
        for (const [name, value] of [['Status', status], ['DeviceName', deviceName], ['LastError', lastError]])
            this._bridgeImpl?.emit_property_changed(name, new GLib.Variant('s', value));
    }
}

const loop = new GLib.MainLoop(null, false);
const bridge = new Bridge(loop);
unixSignalAdd(GLib.PRIORITY_DEFAULT, 15 /* SIGTERM */, () => {
    bridge.stop();
    return GLib.SOURCE_REMOVE;
});
GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
    bridge.start();
    return GLib.SOURCE_REMOVE;
});
loop.run();
