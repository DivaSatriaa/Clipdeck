package io.github.divasatriaa.clipdeck

import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.EOFException

class ProtocolTest {
    @Test
    fun roundTripsTextFrame() {
        val text = "Halo dari PC 👋\nbaris kedua"
        val bytes = encodeFrame(JSONObject().put("t", "text").put("id", 7), text.toByteArray())
        val frame = ByteArrayInputStream(bytes).readFrame()
        assertEquals("text", frame.type)
        assertEquals(7L, frame.id)
        assertEquals(text, String(frame.payload, Charsets.UTF_8))
    }

    @Test
    fun readsSeveralFramesInARow() {
        val out = ByteArrayOutputStream()
        out.writeFrame(helloHeader("PC"))
        out.writeFrame(JSONObject().put("t", "image").put("id", 2).put("mime", "image/png"), ByteArray(70_000) { it.toByte() })
        out.writeFrame(JSONObject().put("t", "ping"))
        val input = ByteArrayInputStream(out.toByteArray())

        assertEquals("hello", input.readFrame().type)
        val image = input.readFrame()
        assertEquals("image/png", image.header.getString("mime"))
        assertEquals(70_000, image.payload.size)
        assertEquals(1.toByte(), image.payload[1])
        assertEquals("ping", input.readFrame().type)
    }

    /** Bytes exactly as clipdeck-bridge (bridge/bridge.js encodeFrame) produces them. */
    @Test
    fun decodesBridgeEncoding() {
        val json = """{"t":"text","id":1,"size":2}""".toByteArray()
        val bytes = byteArrayOf(0, 0, 0, json.size.toByte()) + json + "hi".toByteArray()
        val frame = ByteArrayInputStream(bytes).readFrame()
        assertEquals("text", frame.type)
        assertArrayEquals("hi".toByteArray(), frame.payload)
    }

    @Test
    fun encodesSizeInHeader() {
        val bytes = encodeFrame(ackHeader(5))
        val headerLength = java.nio.ByteBuffer.wrap(bytes, 0, 4).int
        val header = JSONObject(String(bytes, 4, headerLength))
        assertEquals("ack", header.getString("t"))
        assertEquals(0, header.getInt("size"))
        assertEquals(4 + headerLength, bytes.size)
    }

    @Test(expected = ProtocolException::class)
    fun rejectsHugeHeader() {
        ByteArrayInputStream(byteArrayOf(0x7f, 0, 0, 0)).readFrame()
    }

    @Test
    fun reportsEndOfStream() {
        var eof = false
        try {
            ByteArrayInputStream(ByteArray(0)).readFrame()
        } catch (e: EOFException) {
            eof = true
        }
        assertTrue(eof)
    }
}
