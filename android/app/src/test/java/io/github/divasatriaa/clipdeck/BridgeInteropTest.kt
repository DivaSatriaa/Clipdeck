package io.github.divasatriaa.clipdeck

import org.junit.Assert.assertEquals
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File
import java.net.Socket

/**
 * Plays the phone against the real clipdeck-bridge (bridge/bridge.js),
 * reached through a local TCP socket that a test BlueZ stand-in hands to
 * the bridge as if it were an RFCOMM connection (the bridge only sees a
 * socket file descriptor either way).
 *
 * Skipped unless CLIPDECK_BRIDGE_PORT is set; see the bridge test harness.
 */
class BridgeInteropTest {
    @Test
    fun receivesItemsFromBridge() {
        val port = System.getenv("CLIPDECK_BRIDGE_PORT")
        assumeTrue("set CLIPDECK_BRIDGE_PORT to run", port != null)
        val expectedImage = File(System.getenv("CLIPDECK_EXPECTED_IMAGE")!!).readBytes()

        Socket("127.0.0.1", port!!.toInt()).use { socket ->
            val input = socket.getInputStream().buffered()
            val output = socket.getOutputStream()
            output.writeFrame(helloHeader("JVM phone"))

            val received = mutableListOf<Frame>()
            while (received.count { it.type == "text" || it.type == "image" } < 3) {
                val frame = input.readFrame()
                received += frame
                if (frame.type == "text" || frame.type == "image") output.writeFrame(ackHeader(frame.id))
            }

            assertEquals("hello", received.first().type)
            val texts = received.filter { it.type == "text" }.map { String(it.payload, Charsets.UTF_8) }
            assertEquals(listOf("copied before connect", "Halo dari PC 👋\nbaris kedua"), texts)
            val image = received.single { it.type == "image" }
            assertEquals("image/png", image.header.getString("mime"))
            assertEquals(expectedImage.toList(), image.payload.toList())
        }
    }
}
