package io.github.divasatriaa.clipdeck

import android.content.Context
import android.net.Uri
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

/** Connection state and received items, shared by the service and the UI. */
object ClipStore {
    enum class Status { OFF, CONNECTING, CONNECTED, RETRYING }

    data class Link(
        val status: Status = Status.OFF,
        val computerName: String = "",
        val message: String = "",
    )

    sealed interface Item {
        val id: Long
        val time: Long

        data class Text(override val id: Long, override val time: Long, val text: String) : Item
        data class Image(override val id: Long, override val time: Long, val uri: Uri, val mime: String) : Item
    }

    private const val MAX_ITEMS = 50
    private var nextId = 1L

    private val _link = MutableStateFlow(Link())
    val link: StateFlow<Link> = _link.asStateFlow()

    private val _items = MutableStateFlow<List<Item>>(emptyList())
    val items: StateFlow<List<Item>> = _items.asStateFlow()

    fun setLink(link: Link) {
        _link.value = link
    }

    @Synchronized
    fun addText(text: String) = add(Item.Text(nextId++, System.currentTimeMillis(), text))

    @Synchronized
    fun addImage(uri: Uri, mime: String) = add(Item.Image(nextId++, System.currentTimeMillis(), uri, mime))

    private fun add(item: Item) {
        _items.update { (listOf(item) + it).take(MAX_ITEMS) }
    }
}

/** The computer the phone connects to, remembered across launches. */
class Prefs(context: Context) {
    private val prefs = context.getSharedPreferences("clipdeck", Context.MODE_PRIVATE)

    var computerAddress: String?
        get() = prefs.getString("computer_address", null)
        set(value) = prefs.edit().putString("computer_address", value).apply()

    var computerName: String?
        get() = prefs.getString("computer_name", null)
        set(value) = prefs.edit().putString("computer_name", value).apply()
}
