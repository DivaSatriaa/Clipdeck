package io.github.divasatriaa.clipdeck

import org.json.JSONObject
import java.io.DataInputStream
import java.io.EOFException
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.nio.ByteBuffer
import java.util.UUID

/**
 * Clipdeck wire protocol (docs/PROTOCOL.md), shared with clipdeck-bridge.
 *
 * Every message is one frame:
 *   4 bytes   big-endian length N of the JSON header
 *   N bytes   UTF-8 JSON header, always with "t" (type) and "size"
 *   size      payload bytes (UTF-8 text or image data)
 */
object Protocol {
    const val VERSION = 1

    /** RFCOMM service UUID that clipdeck-bridge registers with BlueZ. */
    val SERVICE_UUID: UUID = UUID.fromString("0a1a0290-5d48-4328-92d4-cdb628a6acb9")

    const val MAX_HEADER = 64 * 1024
    const val MAX_PAYLOAD = 50 * 1024 * 1024
}

class ProtocolException(message: String) : IOException(message)

data class Frame(val header: JSONObject, val payload: ByteArray) {
    val type: String get() = header.optString("t")
    val id: Long get() = header.optLong("id", -1)
}

fun encodeFrame(header: JSONObject, payload: ByteArray = ByteArray(0)): ByteArray {
    header.put("size", payload.size)
    val json = header.toString().toByteArray(Charsets.UTF_8)
    return ByteBuffer.allocate(4 + json.size + payload.size)
        .putInt(json.size)
        .put(json)
        .put(payload)
        .array()
}

fun OutputStream.writeFrame(header: JSONObject, payload: ByteArray = ByteArray(0)) {
    write(encodeFrame(header, payload))
    flush()
}

/** Reads one frame; throws EOFException when the other side closed the link. */
fun InputStream.readFrame(): Frame {
    val data = if (this is DataInputStream) this else DataInputStream(this)
    val headerLength = try {
        data.readInt()
    } catch (e: EOFException) {
        throw e
    }
    if (headerLength <= 0 || headerLength > Protocol.MAX_HEADER)
        throw ProtocolException("bad header length $headerLength")

    val headerBytes = ByteArray(headerLength).also { data.readFully(it) }
    val header = try {
        JSONObject(String(headerBytes, Charsets.UTF_8))
    } catch (e: Exception) {
        throw ProtocolException("bad header")
    }
    val size = header.optInt("size", 0)
    if (size < 0 || size > Protocol.MAX_PAYLOAD)
        throw ProtocolException("bad payload size $size")

    val payload = ByteArray(size).also { data.readFully(it) }
    return Frame(header, payload)
}

fun helloHeader(deviceName: String): JSONObject =
    JSONObject().put("t", "hello").put("v", Protocol.VERSION).put("name", deviceName)

fun ackHeader(id: Long): JSONObject = JSONObject().put("t", "ack").put("id", id)

fun pongHeader(): JSONObject = JSONObject().put("t", "pong")
