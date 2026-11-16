package io.github.divasatriaa.clipdeck

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothClass
import android.bluetooth.BluetoothManager
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.os.Build
import android.os.Bundle
import android.net.Uri
import android.provider.Settings
import android.text.format.DateUtils
import android.util.Size
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent { ClipdeckTheme { ClipdeckScreen() } }
    }
}

/* ------------------------------------------------------------------ */
/* Theme: the Clipdeck purple, or the wallpaper colours on Android 12+  */
/* ------------------------------------------------------------------ */

private val Purple = Color(0xFF71388A)
private val LightColors = lightColorScheme(primary = Purple, secondary = Color(0xFFF37A20))
private val DarkColors = darkColorScheme(primary = Color(0xFFD3A6E6), secondary = Color(0xFFFFB68A))

@Composable
fun ClipdeckTheme(content: @Composable () -> Unit) {
    val dark = isSystemInDarkTheme()
    val context = LocalContext.current
    val colors: ColorScheme = when {
        Build.VERSION.SDK_INT >= 31 && dark -> dynamicDarkColorScheme(context)
        Build.VERSION.SDK_INT >= 31 -> dynamicLightColorScheme(context)
        dark -> DarkColors
        else -> LightColors
    }
    MaterialTheme(colorScheme = colors, content = content)
}

/* ------------------------------------------------------------------ */
/* Screen                                                              */
/* ------------------------------------------------------------------ */

private fun requiredPermissions(): Array<String> = buildList {
    if (Build.VERSION.SDK_INT >= 31) add(Manifest.permission.BLUETOOTH_CONNECT)
    if (Build.VERSION.SDK_INT >= 33) add(Manifest.permission.POST_NOTIFICATIONS)
}.toTypedArray()

private fun Context.hasBluetoothPermission(): Boolean =
    Build.VERSION.SDK_INT < 31 ||
        ContextCompat.checkSelfPermission(this, Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED

data class Computer(val name: String, val address: String, val isComputer: Boolean)

@SuppressLint("MissingPermission")
private fun Context.bondedComputers(): List<Computer> {
    if (!hasBluetoothPermission()) return emptyList()
    val adapter = getSystemService(BluetoothManager::class.java)?.adapter ?: return emptyList()
    return adapter.bondedDevices.orEmpty()
        .map {
            Computer(
                name = it.name ?: it.address,
                address = it.address,
                isComputer = it.bluetoothClass?.majorDeviceClass == BluetoothClass.Device.Major.COMPUTER,
            )
        }
        // Computers first, then everything else that is paired.
        .sortedWith(compareByDescending<Computer> { it.isComputer }.thenBy { it.name.lowercase() })
}

@Composable
fun ClipdeckScreen() {
    val context = LocalContext.current
    val prefs = remember { Prefs(context) }
    val link by ClipStore.link.collectAsState()
    val items by ClipStore.items.collectAsState()

    var hasPermission by remember { mutableStateOf(context.hasBluetoothPermission()) }
    var computers by remember { mutableStateOf(context.bondedComputers()) }
    var selected by remember { mutableStateOf(prefs.computerAddress) }

    val permissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) {
        hasPermission = context.hasBluetoothPermission()
        computers = context.bondedComputers()
    }
    LaunchedEffect(Unit) {
        if (!hasPermission) permissionLauncher.launch(requiredPermissions())
    }

    Scaffold { padding ->
        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(padding),
            contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            item { Header() }
            item { StatusCard(link) }

            if (!hasPermission) {
                item {
                    InfoCard(
                        title = stringResource(R.string.permission_title),
                        body = stringResource(R.string.permission_body),
                        action = stringResource(R.string.permission_action),
                    ) { permissionLauncher.launch(requiredPermissions()) }
                }
            } else {
                item {
                    ComputerCard(
                        computers = computers,
                        selected = selected,
                        connected = link.status != ClipStore.Status.OFF,
                        onSelect = {
                            selected = it.address
                            prefs.computerAddress = it.address
                            prefs.computerName = it.name
                        },
                        onRefresh = { computers = context.bondedComputers() },
                        onConnect = { selected?.let { ClipdeckService.connect(context, it) } },
                        onDisconnect = { ClipdeckService.disconnect(context) },
                    )
                }
            }

            item {
                Text(
                    stringResource(R.string.recent_title),
                    style = MaterialTheme.typography.titleMedium,
                    modifier = Modifier.padding(top = 8.dp),
                )
            }
            if (items.isEmpty()) {
                item {
                    Text(
                        stringResource(R.string.recent_empty),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            items(items, key = { it.id }) { ItemCard(it) }
            item { CoffeeButton() }
        }
    }
}

@Composable
private fun CoffeeButton() {
    val context = LocalContext.current
    OutlinedButton(
        onClick = {
            context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://ko-fi.com/divasatria")))
        },
        modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
    ) { Text(stringResource(R.string.action_coffee)) }
}

@Composable
private fun Header() {
    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(vertical = 8.dp)) {
        Image(
            painter = painterResource(R.drawable.logo),
            contentDescription = null,
            modifier = Modifier.size(56.dp),
        )
        Spacer(Modifier.width(14.dp))
        Column {
            Text(stringResource(R.string.app_name), style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
            Text(
                stringResource(R.string.tagline),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun StatusCard(link: ClipStore.Link) {
    val (title, color) = when (link.status) {
        ClipStore.Status.CONNECTED -> stringResource(R.string.status_connected, link.computerName) to Color(0xFF2E7D32)
        ClipStore.Status.CONNECTING -> stringResource(R.string.status_connecting, link.computerName) to MaterialTheme.colorScheme.primary
        ClipStore.Status.RETRYING -> stringResource(R.string.status_retrying) to Color(0xFFC77700)
        ClipStore.Status.OFF -> stringResource(R.string.status_off) to MaterialTheme.colorScheme.outline
    }
    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerHigh)) {
        Row(Modifier.fillMaxWidth().padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(12.dp).clip(CircleShape).background(color))
            Spacer(Modifier.width(12.dp))
            Column {
                Text(title, style = MaterialTheme.typography.titleMedium)
                val detail = when (link.status) {
                    ClipStore.Status.CONNECTED -> stringResource(R.string.status_connected_detail)
                    ClipStore.Status.RETRYING -> link.message
                    else -> ""
                }
                if (detail.isNotEmpty()) {
                    Text(detail, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
    }
}

@Composable
private fun ComputerCard(
    computers: List<Computer>,
    selected: String?,
    connected: Boolean,
    onSelect: (Computer) -> Unit,
    onRefresh: () -> Unit,
    onConnect: () -> Unit,
    onDisconnect: () -> Unit,
) {
    val context = LocalContext.current
    Card {
        Column(Modifier.fillMaxWidth().padding(16.dp)) {
            Text(stringResource(R.string.computer_title), style = MaterialTheme.typography.titleMedium)
            Text(
                stringResource(R.string.computer_hint),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(8.dp))
            if (computers.isEmpty()) {
                Text(stringResource(R.string.computer_none), style = MaterialTheme.typography.bodyMedium)
            }
            computers.forEach { computer ->
                Row(
                    Modifier.fillMaxWidth().clickable(enabled = !connected) { onSelect(computer) }.padding(vertical = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    RadioButton(selected = computer.address == selected, onClick = { onSelect(computer) }, enabled = !connected)
                    Column {
                        Text(computer.name, style = MaterialTheme.typography.bodyLarge)
                        if (!computer.isComputer) {
                            Text(
                                stringResource(R.string.computer_not_a_computer),
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                }
            }
            Spacer(Modifier.height(12.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (connected) {
                    Button(onClick = onDisconnect) { Text(stringResource(R.string.action_disconnect)) }
                } else {
                    Button(onClick = onConnect, enabled = selected != null) { Text(stringResource(R.string.action_connect)) }
                }
                OutlinedButton(onClick = {
                    context.startActivity(Intent(Settings.ACTION_BLUETOOTH_SETTINGS))
                    onRefresh()
                }) { Text(stringResource(R.string.action_pair)) }
            }
        }
    }
}

@Composable
private fun InfoCard(title: String, body: String, action: String, onAction: () -> Unit) {
    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.secondaryContainer)) {
        Column(Modifier.fillMaxWidth().padding(16.dp)) {
            Text(title, style = MaterialTheme.typography.titleMedium)
            Text(body, style = MaterialTheme.typography.bodyMedium)
            Spacer(Modifier.height(8.dp))
            Button(onClick = onAction) { Text(action) }
        }
    }
}

@Composable
private fun ItemCard(item: ClipStore.Item) {
    val context = LocalContext.current
    val copy = {
        val clipboard = context.getSystemService(ClipboardManager::class.java)
        val clip = when (item) {
            is ClipStore.Item.Text -> ClipData.newPlainText(context.getString(R.string.clip_label_text), item.text)
            is ClipStore.Item.Image -> ClipData.newUri(context.contentResolver, context.getString(R.string.clip_label_image), item.uri)
        }
        clipboard?.setPrimaryClip(clip)
    }
    Card(Modifier.fillMaxWidth().clickable { copy() }) {
        Column(Modifier.padding(14.dp)) {
            when (item) {
                is ClipStore.Item.Text -> Text(
                    item.text, maxLines = 4, overflow = TextOverflow.Ellipsis,
                    style = MaterialTheme.typography.bodyLarge,
                )
                is ClipStore.Item.Image -> Thumbnail(item)
            }
            Spacer(Modifier.height(6.dp))
            Text(
                DateUtils.getRelativeTimeSpanString(item.time).toString() + " · " + stringResource(R.string.tap_to_copy),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun Thumbnail(item: ClipStore.Item.Image) {
    val context = LocalContext.current
    val bitmap by produceState<Bitmap?>(null, item.uri) {
        value = withContext(Dispatchers.IO) {
            runCatching { context.contentResolver.loadThumbnail(item.uri, Size(640, 640), null) }.getOrNull()
        }
    }
    bitmap?.let {
        Image(
            bitmap = it.asImageBitmap(),
            contentDescription = stringResource(R.string.clip_label_image),
            contentScale = ContentScale.Fit,
            modifier = Modifier.fillMaxWidth().height(180.dp).clip(RoundedCornerShape(8.dp)),
        )
    } ?: Text(stringResource(R.string.clip_label_image))
}
