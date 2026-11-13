package io.github.divasatriaa.clipdeck

import android.Manifest
import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothSocket
import android.content.ClipData
import android.content.ClipboardManager
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.IBinder
import android.provider.MediaStore
import android.provider.Settings
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.BufferedInputStream
import java.io.EOFException
import java.io.IOException
import java.io.OutputStream

/**
 * Foreground service that holds the Bluetooth (RFCOMM) link to the computer
 * running clipdeck-bridge, puts received text on the clipboard and saves
 * received images to Pictures/Clipdeck. It reconnects by itself until the
 * user taps Disconnect.
 */
class ClipdeckService : Service() {

    companion object {
        private const val ACTION_CONNECT = "io.github.divasatriaa.clipdeck.CONNECT"
        private const val ACTION_DISCONNECT = "io.github.divasatriaa.clipdeck.DISCONNECT"
        private const val EXTRA_ADDRESS = "address"
        private const val CHANNEL_ID = "connection"
        private const val NOTIFICATION_ID = 1

        fun connect(context: Context, address: String) {
            val intent = Intent(context, ClipdeckService::class.java)
                .setAction(ACTION_CONNECT)
                .putExtra(EXTRA_ADDRESS, address)
            ContextCompat.startForegroundService(context, intent)
        }

        fun disconnect(context: Context) {
            context.startService(Intent(context, ClipdeckService::class.java).setAction(ACTION_DISCONNECT))
        }
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var job: Job? = null

    @Volatile
    private var socket: BluetoothSocket? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_DISCONNECT -> {
                stopEverything()
                return START_NOT_STICKY
            }
            ACTION_CONNECT -> {
                val address = intent.getStringExtra(EXTRA_ADDRESS) ?: return START_NOT_STICKY
                startInForeground(getString(R.string.notification_connecting))
                job?.cancel()
                closeSocket()
                job = scope.launch { connectLoop(address) }
            }
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        scope.cancel()
        closeSocket()
        ClipStore.setLink(ClipStore.Link())
        super.onDestroy()
    }

    private fun stopEverything() {
        job?.cancel()
        closeSocket()
        ClipStore.setLink(ClipStore.Link())
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun closeSocket() {
        try {
            socket?.close()
        } catch (_: IOException) {
        }
        socket = null
    }

    /* ---------------- connection ---------------- */

    private suspend fun connectLoop(address: String) {
        var backoffMs = 2_000L
        while (currentCoroutineContext().isActive) {
            try {
                runConnection(address)
                backoffMs = 2_000L
            } catch (e: SecurityException) {
                ClipStore.setLink(ClipStore.Link(ClipStore.Status.RETRYING, message = getString(R.string.status_no_permission)))
            } catch (e: IOException) {
                if (!currentCoroutineContext().isActive) return
                val message = when (e) {
                    is EOFException -> getString(R.string.status_closed_by_computer)
                    else -> e.message ?: getString(R.string.status_cannot_reach)
                }
                ClipStore.setLink(ClipStore.Link(ClipStore.Status.RETRYING, message = message))
            } finally {
                closeSocket()
            }
            updateNotification(getString(R.string.notification_retrying))
            delay(backoffMs)
            backoffMs = (backoffMs * 2).coerceAtMost(30_000L)
        }
    }

    @SuppressLint("MissingPermission")
    private suspend fun runConnection(address: String) {
        if (Build.VERSION.SDK_INT >= 31 &&
            checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED
        ) throw SecurityException("BLUETOOTH_CONNECT not granted")

        val adapter = getSystemService(BluetoothManager::class.java)?.adapter
            ?: throw IOException(getString(R.string.status_no_bluetooth))
        if (!adapter.isEnabled) throw IOException(getString(R.string.status_bluetooth_off))

        val device = adapter.getRemoteDevice(address)
        val computer = device.name ?: address
        ClipStore.setLink(ClipStore.Link(ClipStore.Status.CONNECTING, computer))

        val s = device.createRfcommSocketToServiceRecord(Protocol.SERVICE_UUID)
        socket = s
        adapter.cancelDiscovery()
        s.connect()

        val input = BufferedInputStream(s.inputStream, 64 * 1024)
        val output = s.outputStream
        output.writeFrame(helloHeader(phoneName()))

        while (currentCoroutineContext().isActive) {
            val frame = input.readFrame()
            when (frame.type) {
                "hello" -> {
                    val name = frame.header.optString("name").ifEmpty { computer }
                    ClipStore.setLink(ClipStore.Link(ClipStore.Status.CONNECTED, name))
                    updateNotification(getString(R.string.notification_connected, name))
                }
                "text" -> {
                    val text = String(frame.payload, Charsets.UTF_8)
                    copyText(text)
                    ClipStore.addText(text)
                    ack(output, frame.id)
                }
                "image" -> {
                    val mime = frame.header.optString("mime", "image/png")
                    val uri = saveImage(frame.payload, mime)
                    if (uri != null) {
                        copyImage(uri)
                        ClipStore.addImage(uri, mime)
                    }
                    ack(output, frame.id)
                }
                "ping" -> output.writeFrame(pongHeader())
                else -> Unit // "pong" and future message types.
            }
        }
    }

    private fun ack(output: OutputStream, id: Long) {
        if (id >= 0) output.writeFrame(ackHeader(id))
    }

    private fun phoneName(): String =
        Settings.Global.getString(contentResolver, Settings.Global.DEVICE_NAME) ?: Build.MODEL

    /* ---------------- clipboard and images ---------------- */

    private suspend fun copyText(text: String) = withContext(Dispatchers.Main) {
        getSystemService(ClipboardManager::class.java)
            ?.setPrimaryClip(ClipData.newPlainText(getString(R.string.clip_label_text), text))
    }

    private suspend fun copyImage(uri: Uri) = withContext(Dispatchers.Main) {
        getSystemService(ClipboardManager::class.java)
            ?.setPrimaryClip(ClipData.newUri(contentResolver, getString(R.string.clip_label_image), uri))
    }

    /** Saves to Pictures/Clipdeck (no storage permission needed on Android 10+). */
    private fun saveImage(bytes: ByteArray, mime: String): Uri? {
        val extension = when (mime) {
            "image/jpeg" -> "jpg"
            "image/webp" -> "webp"
            "image/gif" -> "gif"
            "image/bmp" -> "bmp"
            else -> "png"
        }
        val values = ContentValues().apply {
            put(MediaStore.Images.Media.DISPLAY_NAME, "clipdeck-${System.currentTimeMillis()}.$extension")
            put(MediaStore.Images.Media.MIME_TYPE, mime)
            put(MediaStore.Images.Media.RELATIVE_PATH, "${Environment.DIRECTORY_PICTURES}/Clipdeck")
            put(MediaStore.Images.Media.IS_PENDING, 1)
        }
        val resolver = contentResolver
        val uri = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values) ?: return null
        return try {
            resolver.openOutputStream(uri)?.use { it.write(bytes) } ?: throw IOException("no output stream")
            values.clear()
            values.put(MediaStore.Images.Media.IS_PENDING, 0)
            resolver.update(uri, values, null, null)
            uri
        } catch (e: IOException) {
            resolver.delete(uri, null, null)
            null
        }
    }

    /* ---------------- notification ---------------- */

    private fun startInForeground(text: String) {
        createChannel()
        ServiceCompat.startForeground(
            this, NOTIFICATION_ID, buildNotification(text),
            if (Build.VERSION.SDK_INT >= 29) ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE else 0,
        )
    }

    private fun updateNotification(text: String) {
        getSystemService(NotificationManager::class.java)?.notify(NOTIFICATION_ID, buildNotification(text))
    }

    private fun createChannel() {
        val channel = NotificationChannel(
            CHANNEL_ID, getString(R.string.notification_channel), NotificationManager.IMPORTANCE_LOW,
        )
        getSystemService(NotificationManager::class.java)?.createNotificationChannel(channel)
    }

    private fun buildNotification(text: String): Notification {
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE,
        )
        val disconnect = PendingIntent.getService(
            this, 1, Intent(this, ClipdeckService::class.java).setAction(ACTION_DISCONNECT),
            PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(getString(R.string.app_name))
            .setContentText(text)
            .setContentIntent(open)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .addAction(0, getString(R.string.action_disconnect), disconnect)
            .build()
    }
}
