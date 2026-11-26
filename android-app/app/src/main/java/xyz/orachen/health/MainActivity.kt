package xyz.orachen.health

import android.annotation.SuppressLint
import android.app.DownloadManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.Environment
import android.webkit.CookieManager
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import com.itos.coui.effect.SpotlightPreset
import com.itos.coui.effect.rememberCouiSpotlight
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.URL
import javax.net.ssl.HttpsURLConnection
import kotlin.math.roundToInt

private const val dashboard = "https://health.example.com"
private const val dashboardHost = "health.example.com"
private val endpoint = Uri.parse(dashboard)

class MainActivity : ComponentActivity() {
    private lateinit var web: WebView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        web = createDashboard(this)
        if (savedInstanceState == null || web.restoreState(savedInstanceState) == null) web.loadUrl(dashboard)
        setContent { HealthApp(web) }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        web.saveState(outState)
        super.onSaveInstanceState(outState)
    }

    override fun onDestroy() {
        super.onDestroy()
        (web.parent as? android.view.ViewGroup)?.removeView(web)
        web.destroy()
    }
}

private fun Uri.isDashboard(): Boolean =
    scheme == "https" && host == dashboardHost && (port == -1 || port == 443)

@SuppressLint("SetJavaScriptEnabled")
private fun createDashboard(context: Context) = WebView(context).apply {
    settings.javaScriptEnabled = true
    settings.domStorageEnabled = true
    settings.allowFileAccess = false
    settings.allowContentAccess = false
    settings.mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW
    webViewClient = object : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val uri = request.url
            if (uri.isDashboard() || !request.isForMainFrame) return false
            if (request.hasGesture() && uri.scheme in setOf("http", "https")) {
                runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, uri)) }
            }
            return true
        }
    }
    setDownloadListener { url, userAgent, _, mimeType, _ ->
        val uri = Uri.parse(url)
        if (uri.isDashboard() && uri.path == "/api/v1/dashboard/workout.gpx") {
            val id = uri.getQueryParameter("id")?.filter(Char::isDigit).orEmpty()
            val request = DownloadManager.Request(uri)
                .setMimeType(mimeType ?: "application/gpx+xml")
                .setTitle("训练路线 GPX")
                .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, "workout-$id.gpx")
            CookieManager.getInstance().getCookie(dashboard)?.let { request.addRequestHeader("Cookie", it) }
            userAgent?.let { request.addRequestHeader("User-Agent", it) }
            runCatching { context.getSystemService(DownloadManager::class.java).enqueue(request) }
                .onFailure { Toast.makeText(context, "无法导出 GPX", Toast.LENGTH_SHORT).show() }
        }
    }
}

private enum class Screen(val label: String) {
    Dashboard("面板"), Native("原生摘要"), Sync("同步")
}

@Composable
private fun HealthApp(web: WebView) {
    val dark = isSystemInDarkTheme()
    val colors = if (dark) darkColorScheme(primary = Color(0xFFA7C8FF))
        else lightColorScheme(primary = Color(0xFF245EAC))
    var screen by rememberSaveable { mutableStateOf(Screen.Dashboard) }
    val status by SyncRunner.status.collectAsState()
    LaunchedEffect(status.revision) {
        if (status.revision > 0) web.reload()
    }
    BackHandler {
        when {
            screen != Screen.Dashboard -> screen = Screen.Dashboard
            web.canGoBack() -> web.goBack()
            else -> (web.context as? ComponentActivity)?.finish()
        }
    }
    MaterialTheme(colorScheme = colors) {
        Scaffold(
            bottomBar = {
                Surface(tonalElevation = 3.dp) {
                    Row(
                        Modifier.fillMaxWidth().navigationBarsPadding().padding(horizontal = 8.dp, vertical = 4.dp),
                        horizontalArrangement = Arrangement.SpaceEvenly,
                    ) {
                        Screen.entries.forEach { item ->
                            if (screen == item) FilledTonalButton(
                                onClick = {}, modifier = Modifier.weight(1f),
                            ) { Text(item.label) }
                            else TextButton(
                                onClick = { screen = item }, modifier = Modifier.weight(1f),
                            ) { Text(item.label) }
                        }
                    }
                }
            },
        ) { padding ->
            Box(Modifier.fillMaxSize().padding(padding)) {
                when (screen) {
                    Screen.Dashboard -> AndroidView(
                        factory = {
                            (web.parent as? android.view.ViewGroup)?.removeView(web)
                            web
                        },
                        modifier = Modifier.fillMaxSize(),
                    )
                    Screen.Native -> NativeSummary(dark, status.revision) { screen = Screen.Dashboard }
                    Screen.Sync -> SyncScreen(status) { screen = Screen.Dashboard }
                }
            }
        }
    }
}

@Composable
private fun SyncScreen(status: SyncRunner.Status, openDashboard: () -> Unit) {
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text("数据库同步", style = MaterialTheme.typography.headlineMedium)
        Text("通过这台手机现有的 AntiGem 流程解密华为运动健康数据库并同步到服务器。首次执行时，请在 Root 管理器里为本 App 授权。")
        Surface(
            modifier = Modifier.fillMaxWidth(),
            shape = RoundedCornerShape(22.dp),
            color = MaterialTheme.colorScheme.surfaceVariant,
        ) {
            Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(status.message, style = MaterialTheme.typography.titleMedium)
                if (status.running) LinearProgressIndicator(Modifier.fillMaxWidth())
            }
        }
        Button(onClick = SyncRunner::start, enabled = !status.running) {
            Text("解密并同步")
        }
        TextButton(onClick = openDashboard) { Text("查看健康面板") }
    }
}

private data class Ring(
    val label: String,
    val value: Double?,
    val goal: Double,
    val color: Color,
) {
    val completion get() = value?.let { it / goal }
}

private data class Summary(
    val date: String,
    val rings: List<Ring>,
    val sleepMinutes: Double?,
    val steps: Double?,
    val restingHeartRate: Double?,
)

private sealed interface SummaryState {
    data object Loading : SummaryState
    data class Ready(val summary: Summary) : SummaryState
    data class Message(val message: String, val login: Boolean = false) : SummaryState
}

private suspend fun loadSummary(): SummaryState = withContext(Dispatchers.IO) {
    val connection = URL("$dashboard/api/v1/dashboard/overview?days=1").openConnection() as HttpsURLConnection
    try {
        connection.instanceFollowRedirects = false
        connection.connectTimeout = 8_000
        connection.readTimeout = 12_000
        val cookies = CookieManager.getInstance().getCookie(endpoint.toString())
        if (!cookies.isNullOrEmpty()) connection.setRequestProperty("Cookie", cookies)
        when (connection.responseCode) {
            401, 403 -> SummaryState.Message("请先在面板登录，再回来查看原生摘要。", login = true)
            200 -> {
                val data = connection.inputStream.bufferedReader().use { JSONObject(it.readText()) }
                val latest = data.optJSONObject("latest_day")
                if (latest == null || data.optBoolean("empty")) SummaryState.Message("暂无可显示的健康记录")
                else SummaryState.Ready(Summary(
                    date = latest.optString("date"),
                    rings = listOf(
                        Ring(
                            "活动",
                            latest.number("calories_kcal"),
                            latest.number("calorie_goal_kcal")?.takeIf { it > 0 } ?: 300.0,
                            Color(0xFFFF3868),
                        ),
                        Ring("锻炼", latest.number("moderate_high_min"), 25.0, Color(0xFF6FD36F)),
                        Ring("活跃", latest.number("active_hours"), 12.0, Color(0xFF35BEE1)),
                    ),
                    sleepMinutes = data.optJSONObject("latest_night_sleep")?.number("total_sleep_min")
                        ?: latest.number("sleep_total_min"),
                    steps = latest.number("steps"),
                    restingHeartRate = latest.number("hr_rest"),
                ))
            }
            else -> SummaryState.Message("暂时无法读取健康数据")
        }
    } catch (_: java.io.IOException) {
        SummaryState.Message("连接健康服务失败")
    } catch (_: org.json.JSONException) {
        SummaryState.Message("暂时无法读取健康数据")
    } finally {
        connection.disconnect()
    }
}

private fun JSONObject.number(key: String): Double? = optDouble(key).takeIf { it.isFinite() && it >= 0 }

@Composable
private fun NativeSummary(dark: Boolean, revision: Int, openDashboard: () -> Unit) {
    var refresh by remember { mutableIntStateOf(0) }
    var state by remember { mutableStateOf<SummaryState>(SummaryState.Loading) }
    LaunchedEffect(revision, refresh) {
        state = SummaryState.Loading
        state = loadSummary()
    }
    BoxWithConstraints(Modifier.fillMaxSize()) {
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState())
                .heightIn(min = maxHeight + 100.dp).padding(24.dp),
            verticalArrangement = Arrangement.spacedBy(18.dp),
        ) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text("原生摘要", Modifier.weight(1f), style = MaterialTheme.typography.headlineMedium)
                TextButton(onClick = { refresh++ }) { Text("刷新") }
            }
            val ready = state as? SummaryState.Ready
            val message = state as? SummaryState.Message
            SpotlightCard(dark) {
                Text("每日健身圆环", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
                when {
                    ready != null -> {
                        Text(ready.summary.date, style = MaterialTheme.typography.bodySmall)
                        Rings(ready.summary.rings)
                    }
                    message != null -> {
                        Text(message.message)
                        if (message.login) TextButton(onClick = openDashboard) { Text("前往登录") }
                    }
                    else -> LinearProgressIndicator(Modifier.fillMaxWidth())
                }
            }
            if (ready != null) {
                SpotlightCard(dark) {
                    Text("睡眠", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
                    val minutes = ready.summary.sleepMinutes?.roundToInt()
                    Text(
                        minutes?.let { "${it / 60} 小时 ${it % 60} 分钟" } ?: "暂无记录",
                        style = MaterialTheme.typography.headlineSmall,
                    )
                }
                SpotlightCard(dark) {
                    Text("今日概况", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
                    SummaryValue("步数", ready.summary.steps, "步")
                    SummaryValue("静息心率", ready.summary.restingHeartRate, "次/分")
                    TextButton(onClick = openDashboard) { Text("查看完整面板") }
                }
            }
        }
    }
}

@Composable
private fun SummaryValue(label: String, value: Double?, unit: String) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        Text(label)
        Text(value?.let { "${it.roundToInt()} $unit" } ?: "—", fontWeight = FontWeight.SemiBold)
    }
}

@Composable
private fun SpotlightCard(dark: Boolean, content: @Composable ColumnScope.() -> Unit) {
    val shape = RoundedCornerShape(26.dp)
    val (touch, drawLight) = rememberCouiSpotlight(
        interactive = true,
        preset = SpotlightPreset.TranslucentLarge1,
        dark = dark,
        cancelOnConsumedMove = false,
    )
    val background = if (dark) listOf(Color(0xFF242139), Color(0xFF153348))
        else listOf(Color(0xFFFFEBF4), Color(0xFFDAEEFF))
    Column(
        Modifier.fillMaxWidth().clip(shape)
            .background(Brush.linearGradient(background))
            .border(1.dp, if (dark) Color(0x44FFFFFF) else Color(0x40374C6A), shape)
            .then(touch)
            .drawBehind { drawLight?.invoke(this) }
            .padding(18.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
        content = content,
    )
}

@Composable
private fun Rings(rings: List<Ring>) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Canvas(Modifier.size(100.dp)) {
            val stroke = 9.dp.toPx()
            val step = 13.dp.toPx()
            rings.forEachIndexed { index, ring ->
                val edge = stroke / 2 + index * step
                val ringSize = size.width - edge * 2
                val origin = Offset(edge, edge)
                val extent = Size(ringSize, ringSize)
                val style = Stroke(stroke, cap = StrokeCap.Round)
                drawArc(ring.color.copy(alpha = .23f), -90f, 360f, false, origin, extent, style = style)
                val sweep = (ring.completion ?: 0.0).coerceIn(0.0, 1.0).toFloat() * 360f
                if (sweep > 0f) drawArc(ring.color, -90f, sweep, false, origin, extent, style = style)
            }
        }
        Column(Modifier.weight(1f).padding(start = 18.dp), verticalArrangement = Arrangement.spacedBy(7.dp)) {
            rings.forEach { ring ->
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    Text(ring.label)
                    Text(ring.completion?.let { "${(it * 100).roundToInt()}%" } ?: "—", fontWeight = FontWeight.SemiBold)
                }
            }
        }
    }
}
