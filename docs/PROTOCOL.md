# Clipdeck phone protocol

How `clipdeck-bridge` (on the computer) talks to the Clipdeck Android app.

## Transport

- **Bluetooth Classic, RFCOMM.** The phone connects to the computer.
- **Service UUID:** `0a1a0290-5d48-4328-92d4-cdb628a6acb9`.
  - On the computer, `clipdeck-bridge` registers this UUID with BlueZ (`org.bluez.ProfileManager1.RegisterProfile`, role `server`).
  - On Android, the app connects with `BluetoothDevice.createRfcommSocketToServiceRecord(uuid)`.
- **Pairing is required.** The profile is registered with `RequireAuthentication = true`, so BlueZ only hands over connections from bonded (paired) devices, and the link is encrypted by Bluetooth itself.

## Framing

Every message is one frame:

| Bytes | Content |
| --- | --- |
| 4 | Length `N` of the header, unsigned 32-bit big-endian |
| `N` | Header: UTF-8 JSON object, always with `"t"` (type) and `"size"` |
| `size` | Payload (UTF-8 text or image data); absent when `size` is 0 |

Limits: the header must be 1 B – 64 KiB, and the payload 0 B – 50 MiB. A peer that receives anything else closes the connection.

## Messages

### Computer → phone

| `t` | Other header fields | Payload | Meaning |
| --- | --- | --- | --- |
| `hello` | `v` (protocol version, `1`), `name` (computer host name) | none | Sent first, right after the connection opens |
| `text` | `id` | UTF-8 text | Something was copied; put it on the clipboard |
| `image` | `id`, `mime` (for example `image/png`) | image bytes | An image or screenshot was copied |
| `ping` | none | none | Keep-alive, every 30 s; answer with `pong` |

### Phone → computer

| `t` | Other header fields | Payload | Meaning |
| --- | --- | --- | --- |
| `hello` | `v`, `name` (phone name) | none | Sent first; the computer reports the phone as connected once this arrives |
| `ack` | `id` | none | An item was received and handled |
| `ping` | none | none | Keep-alive; the computer answers `pong` |
| `pong` | none | none | Answer to `ping` |

Unknown message types must be ignored, so newer versions can add messages without breaking older ones.

## Example

The computer sends the text `hi` as item 3:

```text
00 00 00 1c  {"t":"text","id":3,"size":2}  68 69
```

## Computer side

The GNOME Shell extension cannot hold a Bluetooth connection, so the work is split between two processes:

1. **The extension** emits `ItemAdded(kind, text, path, mime)` on the session bus. The object path is `/io/github/divasatriaa/Clipdeck` and the interface is `io.github.divasatriaa.Clipdeck1`. It only does this while the `phone-sync` setting is on.
2. **`clipdeck-bridge`** listens for that signal and forwards each item to the connected phone.
   - It only accepts the signal from the bus name that owns `org.gnome.Shell`.
   - It only sends image files from `~/.cache/clipdeck/images`.
   - Items copied while no phone is connected are kept (up to 5) and sent when the phone connects.

`clipdeck-bridge` is started by D-Bus activation (`io.github.divasatriaa.Clipdeck.Bridge`) and exits when `phone-sync` is turned off. It publishes its state on the session bus as the read-only properties `Status`, `DeviceName` and `LastError` of `io.github.divasatriaa.Clipdeck.Bridge1`. `Status` is one of `waiting`, `connected`, `no-bluetooth` or `error`.
