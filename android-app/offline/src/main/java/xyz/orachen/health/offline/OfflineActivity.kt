package xyz.orachen.health.offline

import android.content.Context
import android.content.Intent
import android.database.sqlite.SQLiteException
import android.net.Uri
import android.os.Bundle
import android.provider.OpenableColumns
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.itos.coui.effect.SpotlightPreset
import com.itos.coui.effect.rememberCouiSpotlight
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import java.io.IOException
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlin.math.roundToInt

class OfflineActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent { OfflineApp() }
    }

    override fun onStart() {
        super.onStart()
        OfflineSession.onAppStart(applicationContext)
    }
}

private object OfflineSession {
    private const val AUTO_SYNC_COOLDOWN_MS = 15_000L

    data class State(
        val data: HealthData? = null,
        val busy: Boolean = false,
        val status: String? = null,
        val hasCachedKey: Boolean = false,
        val needsHuaweiHealth: Boolean = false,
        val autoSyncOnOpen: Boolean = true,
    )

    val state = MutableStateFlow(State())
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var store: OfflineStore? = null
    private var initialized = false
    private var lastAutoSyncAttemptMs = 0L
    private var suppressNextAutoSync = false

    @Synchronized
    fun suppressNextAutoSync() {
        suppressNextAutoSync = true
    }

    @Synchronized
    fun resetAutoSyncCooldown() {
        lastAutoSyncAttemptMs = 0L
    }

    @Synchronized
    fun setAutoSyncOnOpen(enabled: Boolean) {
        val local = store ?: return
        local.setAutoSyncOnOpen(enabled)
        state.value = state.value.copy(autoSyncOnOpen = enabled)
    }

    @Synchronized
    fun onAppStart(context: Context) {
        val appContext = context.applicationContext
        val local = store ?: OfflineStore(appContext).also { store = it }
        val wasSuppressed = suppressNextAutoSync
        suppressNextAutoSync = false

        if (!initialized) {
            initialized = true
            val autoEnabled = local.isAutoSyncOnOpen()
            state.value = State(busy = true, status = "正在加载本地记录…", autoSyncOnOpen = autoEnabled)
            scope.launch {
                val restoredState = try {
                    State(
                        data = local.restore(),
                        busy = false,
                        hasCachedKey = local.hasCachedKey(),
                        autoSyncOnOpen = local.isAutoSyncOnOpen(),
                    )
                } catch (_: Exception) {
                    State(
                        status = "本地记录无法读取，请重新同步或导入数据库",
                        hasCachedKey = local.hasCachedKey(),
                        autoSyncOnOpen = local.isAutoSyncOnOpen(),
                    )
                }
                state.value = restoredState

                if (local.isAutoSyncOnOpen() && !wasSuppressed) {
                    val startState = synchronized(this@OfflineSession) {
                        if (state.value.busy) null
                        else {
                            lastAutoSyncAttemptMs = System.currentTimeMillis()
                            val pending = state.value.copy(
                                busy = true,
                                status = "正在检查华为运动健康数据更新…",
                                needsHuaweiHealth = false,
                            )
                            state.value = pending
                            state.value to restoredState
                        }
                    }
                    if (startState != null) {
                        executeSync(local, startState.second, forceRecoverKey = false, isAuto = true)
                    }
                }
            }
            return
        }

        if (wasSuppressed) return
        val autoEnabled = local.isAutoSyncOnOpen()
        val current = state.value
        if (!autoEnabled || current.busy) return

        val now = System.currentTimeMillis()
        if (current.needsHuaweiHealth || (now - lastAutoSyncAttemptMs >= AUTO_SYNC_COOLDOWN_MS)) {
            lastAutoSyncAttemptMs = now
            state.value = current.copy(
                busy = true,
                status = "正在检查华为运动健康数据更新…",
                needsHuaweiHealth = false,
                autoSyncOnOpen = autoEnabled,
            )
            scope.launch {
                executeSync(local, current, forceRecoverKey = false, isAuto = true)
            }
        }
    }

    @Synchronized
    fun import(uri: Uri, key: String) {
        val local = store ?: return
        val current = state.value
        if (current.busy) return
        state.value = current.copy(busy = true, status = "正在读取和校验数据库…", needsHuaweiHealth = false)
        scope.launch {
            state.value = try {
                val data = local.import(uri, key) { msg ->
                    state.value = state.value.copy(status = msg)
                }
                State(
                    data = data,
                    busy = false,
                    status = "已导入 ${data.days.size} 天记录和 ${data.workouts.size} 项训练",
                    hasCachedKey = local.hasCachedKey(),
                    needsHuaweiHealth = false,
                    autoSyncOnOpen = local.isAutoSyncOnOpen(),
                )
            } catch (e: ImportError) {
                current.copy(busy = false, status = e.message, hasCachedKey = local.hasCachedKey(), autoSyncOnOpen = local.isAutoSyncOnOpen())
            } catch (e: IllegalArgumentException) {
                current.copy(busy = false, status = e.message, hasCachedKey = local.hasCachedKey(), autoSyncOnOpen = local.isAutoSyncOnOpen())
            } catch (e: SQLiteException) {
                current.copy(
                    busy = false,
                    status = "无法读取数据库，请确认文件完整且数据库版本受支持（${formatExceptionDetail(e)}）",
                    hasCachedKey = local.hasCachedKey(),
                    autoSyncOnOpen = local.isAutoSyncOnOpen(),
                )
            } catch (e: IOException) {
                current.copy(
                    busy = false,
                    status = "导入失败，请检查文件权限和手机剩余空间（${formatExceptionDetail(e)}）",
                    hasCachedKey = local.hasCachedKey(),
                    autoSyncOnOpen = local.isAutoSyncOnOpen(),
                )
            } catch (e: Exception) {
                current.copy(
                    busy = false,
                    status = "无法导入选中的数据库（${formatExceptionDetail(e)}）",
                    hasCachedKey = local.hasCachedKey(),
                    autoSyncOnOpen = local.isAutoSyncOnOpen(),
                )
            }
        }
    }

    @Synchronized
    fun syncFromHuaweiHealth(forceRecoverKey: Boolean = false) {
        val local = store ?: return
        val current = state.value
        if (current.busy) return
        lastAutoSyncAttemptMs = System.currentTimeMillis()
        state.value = current.copy(
            busy = true,
            status = "正在准备自动同步…",
            needsHuaweiHealth = false,
            autoSyncOnOpen = local.isAutoSyncOnOpen(),
        )
        scope.launch {
            executeSync(local, current, forceRecoverKey = forceRecoverKey, isAuto = false)
        }
    }

    private fun executeSync(
        local: OfflineStore,
        fallbackState: State,
        forceRecoverKey: Boolean,
        isAuto: Boolean,
    ) {
        val autoEnabled = local.isAutoSyncOnOpen()
        state.value = try {
            val result = local.syncFromHuaweiHealth(
                forceRecoverKey = forceRecoverKey,
                skipIfUnchanged = isAuto,
                existingData = fallbackState.data,
            ) { msg ->
                state.value = state.value.copy(status = msg)
            }
            if (result.unchanged) {
                State(
                    data = result.data,
                    busy = false,
                    status = null,
                    hasCachedKey = local.hasCachedKey(),
                    needsHuaweiHealth = false,
                    autoSyncOnOpen = autoEnabled,
                )
            } else {
                val prefix = if (isAuto) "已自动同步" else "同步完成"
                State(
                    data = result.data,
                    busy = false,
                    status = "$prefix（${result.keyStatus}）：${result.data.days.size} 天记录，${result.data.workouts.size} 项训练",
                    hasCachedKey = local.hasCachedKey(),
                    needsHuaweiHealth = false,
                    autoSyncOnOpen = autoEnabled,
                )
            }
        } catch (e: SyncError) {
            fallbackState.copy(
                busy = false,
                status = e.message,
                hasCachedKey = local.hasCachedKey(),
                needsHuaweiHealth = e.needsHuaweiHealth,
                autoSyncOnOpen = autoEnabled,
            )
        } catch (e: ImportError) {
            fallbackState.copy(
                busy = false,
                status = e.message,
                hasCachedKey = local.hasCachedKey(),
                needsHuaweiHealth = false,
                autoSyncOnOpen = autoEnabled,
            )
        } catch (e: IllegalArgumentException) {
            fallbackState.copy(
                busy = false,
                status = e.message,
                hasCachedKey = local.hasCachedKey(),
                needsHuaweiHealth = false,
                autoSyncOnOpen = autoEnabled,
            )
        } catch (e: SQLiteException) {
            fallbackState.copy(
                busy = false,
                status = "无法读取解密后的数据库，请重试同步（${formatExceptionDetail(e)}）",
                hasCachedKey = local.hasCachedKey(),
                needsHuaweiHealth = false,
                autoSyncOnOpen = autoEnabled,
            )
        } catch (e: IOException) {
            fallbackState.copy(
                busy = false,
                status = "同步失败，请检查存储空间和文件权限（${formatExceptionDetail(e)}）",
                hasCachedKey = local.hasCachedKey(),
                needsHuaweiHealth = false,
                autoSyncOnOpen = autoEnabled,
            )
        } catch (e: Exception) {
            fallbackState.copy(
                busy = false,
                status = "自动同步失败（${formatExceptionDetail(e)}）",
                hasCachedKey = local.hasCachedKey(),
                needsHuaweiHealth = false,
                autoSyncOnOpen = autoEnabled,
            )
        }
    }

    private fun formatExceptionDetail(error: Throwable): String {
        val msg = error.message?.trim()?.take(160).orEmpty()
        return if (msg.isNotEmpty()) "${error.javaClass.simpleName}: $msg" else error.javaClass.simpleName
    }

    @Synchronized
    fun clear() {
        val local = store ?: return
        if (state.value.busy) return
        state.value = state.value.copy(busy = true)
        scope.launch {
            local.clear()
            state.value = State(
                status = "已清除本机导入的记录与缓存密钥",
                autoSyncOnOpen = local.isAutoSyncOnOpen(),
            )
        }
    }
}

private enum class Screen(val label: String) {
    Summary("摘要"), Trends("趋势"), Workouts("训练"), Import("同步与导入")
}

@Composable
private fun OfflineApp() {
    val context = LocalContext.current
    val dark = isSystemInDarkTheme()
    val state by OfflineSession.state.collectAsState()
    var screen by rememberSaveable { mutableStateOf(Screen.Summary) }
    var dismissedStatus by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(state.status) {
        if (state.status == null) dismissedStatus = null
        else if (state.status != dismissedStatus && state.busy) dismissedStatus = null
    }
    val colors = if (dark) darkColorScheme(primary = Color(0xFFA7C8FF))
        else lightColorScheme(primary = Color(0xFF245EAC))
    MaterialTheme(colorScheme = colors) {
        Scaffold(
            topBar = {
                Surface {
                    Column {
                        Row(
                            Modifier.fillMaxWidth().statusBarsPadding().padding(horizontal = 20.dp, vertical = 10.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(
                                if (screen == Screen.Import) "同步与导入" else screen.label,
                                Modifier.weight(1f),
                                style = MaterialTheme.typography.headlineSmall,
                                fontWeight = FontWeight.SemiBold,
                            )
                            if (screen != Screen.Import && state.data != null) {
                                TextButton(
                                    onClick = {
                                        dismissedStatus = null
                                        OfflineSession.syncFromHuaweiHealth()
                                    },
                                    enabled = !state.busy,
                                ) {
                                    Text(if (state.busy) "同步中…" else "同步")
                                }
                            }
                        }
                        if (state.busy && screen != Screen.Import) {
                            LinearProgressIndicator(Modifier.fillMaxWidth())
                        }
                    }
                }
            },
            bottomBar = {
                Surface(tonalElevation = 3.dp) {
                    Row(Modifier.fillMaxWidth().navigationBarsPadding().padding(horizontal = 6.dp)) {
                        Screen.entries.forEach { item ->
                            TextButton(
                                onClick = { screen = item },
                                colors = ButtonDefaults.textButtonColors(contentColor =
                                    if (screen == item) colors.primary else colors.onSurfaceVariant),
                                modifier = Modifier.weight(1f),
                            ) {
                                Text(
                                    if (item == Screen.Import) "导入" else item.label,
                                    fontWeight = if (screen == item) FontWeight.Bold else FontWeight.Normal,
                                )
                            }
                        }
                    }
                }
            },
        ) { padding ->
            val modifier = Modifier.fillMaxSize().padding(padding)
            val data = state.data
            Column(modifier) {
                val activeStatus = state.status
                if (screen != Screen.Import && data != null && activeStatus != null && activeStatus != dismissedStatus) {
                    Surface(
                        Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp),
                        shape = RoundedCornerShape(16.dp),
                        color = MaterialTheme.colorScheme.surfaceVariant,
                    ) {
                        Column(Modifier.padding(horizontal = 14.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            Text(activeStatus, style = MaterialTheme.typography.bodySmall)
                            if (!state.busy) {
                                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                    if (state.needsHuaweiHealth && canLaunchHuaweiHealth(context)) {
                                        TextButton(onClick = { launchHuaweiHealth(context) }) {
                                            Text("打开华为运动健康")
                                        }
                                    }
                                    TextButton(onClick = { dismissedStatus = activeStatus }) {
                                        Text("收起")
                                    }
                                }
                            }
                        }
                    }
                }
                val contentModifier = Modifier.fillMaxWidth().weight(1f)
                when {
                    screen == Screen.Import -> ImportScreen(contentModifier, state)
                    data == null -> Column(contentModifier.padding(22.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                        if (state.busy) {
                            LinearProgressIndicator(Modifier.fillMaxWidth())
                            state.status?.let { Text(it) }
                        } else {
                            Text(state.status ?: "支持通过 Root 自动从本机华为运动健康获取密钥并解密数据库，或手动导入 SQLite 快照。")
                            Button(onClick = { OfflineSession.syncFromHuaweiHealth() }) {
                                Text("从华为运动健康一键同步")
                            }
                            if (state.needsHuaweiHealth && canLaunchHuaweiHealth(context)) {
                                OutlinedButton(onClick = { launchHuaweiHealth(context) }) {
                                    Text("打开华为运动健康")
                                }
                            }
                            OutlinedButton(onClick = { screen = Screen.Import }) {
                                Text("手动导入数据库")
                            }
                        }
                    }
                    screen == Screen.Summary -> SummaryScreen(contentModifier, data.days, dark)
                    screen == Screen.Trends -> TrendsScreen(contentModifier, data.days, dark)
                    screen == Screen.Workouts -> WorkoutScreen(contentModifier, data.workouts, dark)
                }
            }
        }
    }
}

@Composable
private fun ImportScreen(modifier: Modifier, state: OfflineSession.State) {
    val context = LocalContext.current
    var source by rememberSaveable { mutableStateOf<String?>(null) }
    var filename by rememberSaveable { mutableStateOf("") }
    var key by remember { mutableStateOf("") }
    var showClear by rememberSaveable { mutableStateOf(false) }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) {
            source = uri.toString()
            filename = runCatching {
                context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use {
                    if (it.moveToFirst()) it.getString(0) else null
                }
            }.getOrNull() ?: "已选数据库"
            key = ""
        }
    }
    LazyColumn(
        modifier,
        contentPadding = PaddingValues(18.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        item {
            GlassCard("华为运动健康自动同步", dark = isSystemInDarkTheme()) {
                Text(
                    "通过 Root 直接读取本机华为运动健康数据库，并在首次或密钥变化时自动从后台进程内存恢复 SQLCipher 密钥后本地解密。",
                    style = MaterialTheme.typography.bodyMedium,
                )
                ValueRow("密钥状态", if (state.hasCachedKey) "已安全缓存" else "尚未缓存（同步时自动获取）")
                state.data?.syncedAtMs?.let { ts ->
                    ValueRow("最近同步", localDateTime(ts).format(syncTimeFormat))
                }
                Row(
                    Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween,
                ) {
                    Text("打开应用时自动同步", Modifier.weight(1f))
                    Switch(
                        checked = state.autoSyncOnOpen,
                        onCheckedChange = OfflineSession::setAutoSyncOnOpen,
                        enabled = !state.busy,
                    )
                }
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Button(
                        onClick = { OfflineSession.syncFromHuaweiHealth(forceRecoverKey = false) },
                        enabled = !state.busy,
                    ) {
                        Text(if (state.hasCachedKey) "一键同步" else "一键获取密钥并同步")
                    }
                    if (state.hasCachedKey) {
                        TextButton(
                            onClick = { OfflineSession.syncFromHuaweiHealth(forceRecoverKey = true) },
                            enabled = !state.busy,
                        ) {
                            Text("重新获取密钥")
                        }
                    }
                }
                if (state.needsHuaweiHealth && canLaunchHuaweiHealth(context)) {
                    OutlinedButton(
                        onClick = { launchHuaweiHealth(context) },
                        enabled = !state.busy,
                    ) {
                        Text("打开华为运动健康")
                    }
                }
            }
        }
        if (state.busy) item { LinearProgressIndicator(Modifier.fillMaxWidth()) }
        state.status?.let { item { Text(it, style = MaterialTheme.typography.bodyMedium) } }
        item {
            GlassCard("手动导入数据库快照", dark = isSystemInDarkTheme()) {
                Text(
                    "选择完整的本地 SQLite 数据库快照。加密数据库需要对应的 64 位十六进制 SQLCipher 原始密钥，明文数据库可留空。",
                    style = MaterialTheme.typography.bodyMedium,
                )
                OutlinedButton(
                    onClick = {
                        OfflineSession.suppressNextAutoSync()
                        picker.launch(arrayOf("*/*"))
                    },
                    enabled = !state.busy,
                ) {
                    Text(if (source == null) "选择数据库文件" else "更换数据库文件")
                }
                if (filename.isNotBlank()) Text(filename, style = MaterialTheme.typography.bodySmall)
                OutlinedTextField(
                    value = key,
                    onValueChange = { if (it.length <= 96) key = it },
                    label = { Text("数据库密钥（64 位十六进制）") },
                    visualTransformation = PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                    singleLine = true,
                    enabled = !state.busy,
                    modifier = Modifier.fillMaxWidth(),
                )
                Button(enabled = !state.busy && source != null, onClick = {
                    source?.let { OfflineSession.import(Uri.parse(it), key) }
                    key = ""
                }) { Text("导入并查看") }
            }
        }
        if (state.data != null || state.hasCachedKey) item {
            TextButton(onClick = { showClear = true }, enabled = !state.busy) { Text("清除已导入数据与缓存密钥") }
        }
    }
    if (showClear) AlertDialog(
        onDismissRequest = { showClear = false },
        title = { Text("清除本机记录？") },
        text = { Text("仅删除本 App 导入的数据及缓存密钥。原华为运动健康数据库文件不受影响。") },
        confirmButton = { TextButton(onClick = { showClear = false; OfflineSession.clear() }) { Text("清除") } },
        dismissButton = { TextButton(onClick = { showClear = false }) { Text("取消") } },
    )
}

private fun canLaunchHuaweiHealth(context: Context): Boolean =
    context.packageManager.getLaunchIntentForPackage(HuaweiHealthSync.HUAWEI_HEALTH_PACKAGE) != null

private fun launchHuaweiHealth(context: Context) {
    OfflineSession.resetAutoSyncCooldown()
    val intent = context.packageManager.getLaunchIntentForPackage(HuaweiHealthSync.HUAWEI_HEALTH_PACKAGE)
        ?: return
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    runCatching { context.startActivity(intent) }
}

@Composable
private fun SummaryScreen(modifier: Modifier, days: List<HealthDay>, dark: Boolean) {
    if (days.isEmpty()) {
        Box(modifier.padding(24.dp)) { Text("数据库没有每日健康统计") }
        return
    }
    var index by rememberSaveable { mutableIntStateOf(0) }
    val selected = index.coerceIn(0, days.lastIndex)
    val day = days[selected]
    val activity = day.stat(40003)?.div(1000)
    val activityGoal = day.stat(300002125)?.div(1000)?.takeIf { it > 0 } ?: 300.0
    LazyColumn(modifier, contentPadding = PaddingValues(18.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        item {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
                TextButton(enabled = selected < days.lastIndex, onClick = { index = selected + 1 }) { Text("前一条") }
                Text(day.date.toString(), fontWeight = FontWeight.SemiBold)
                TextButton(enabled = selected > 0, onClick = { index = selected - 1 }) { Text("后一条") }
            }
        }
        item {
            GlassCard("健身三环", dark) {
                FitnessRings(listOf(
                    FitnessRing("活动", activity, activityGoal, "千卡", Color(0xFFDB3E68)),
                    FitnessRing("锻炼", day.stat(47101, 300002182), 25.0, "分钟", Color(0xFF45A254)),
                    FitnessRing("活跃", day.stat(300002748, 200005921), 12.0, "小时", Color(0xFF208DB7)),
                ))
                ValueRow("步数", day.stat(40002).format("步"))
                ValueRow("距离", day.stat(40004)?.div(1000).format("公里", 2))
            }
        }
        item {
            GlassCard("睡眠", dark) {
                ValueRow("总时长", duration(day.stat(44105)?.times(60)))
                ValueRow("评分", day.stat(44203).format("分"))
                ValueRow("深睡", day.stat(44102).format("分钟"))
                ValueRow("核心睡眠", day.stat(44103).format("分钟"))
                ValueRow("快速眼动", day.stat(44101).format("分钟"))
                ValueRow("清醒", day.stat(44104).format("分钟"))
                ValueRow("小睡", day.stat(44107).format("分钟"))
            }
        }
        item {
            GlassCard("生命体征", dark) {
                ValueRow("静息心率", day.stat(46020).format("次/分"))
                ValueRow("夜间平均心率", day.stat(44219).format("次/分"))
                ValueRow("HRV", day.stat(44231, 500044710).format("ms"))
                ValueRow("血氧", day.stat(44223, 47203)?.let { "${it.roundToInt()}%" } ?: "—")
                ValueRow("夜间呼吸频率", day.stat(44227).format("次/分", 1))
                ValueRow("平均压力", day.stat(44306).format("分"))
            }
        }
    }
}

private data class FitnessRing(val label: String, val value: Double?, val goal: Double, val unit: String, val color: Color) {
    val completion get() = value?.div(goal)
}

@Composable
private fun FitnessRings(rings: List<FitnessRing>) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Canvas(Modifier.size(88.dp)) {
            val stroke = Stroke(8.dp.toPx(), cap = StrokeCap.Round)
            rings.forEachIndexed { i, ring ->
                val edge = stroke.width / 2 + i * 11.dp.toPx()
                val diameter = size.width - 2 * edge
                val origin = Offset(edge, edge)
                val extent = Size(diameter, diameter)
                drawArc(ring.color.copy(alpha = .22f), -90f, 360f, false, origin, extent, style = stroke)
                val sweep = (ring.completion ?: 0.0).coerceIn(0.0, 1.0).toFloat() * 360
                if (sweep > 0) drawArc(ring.color, -90f, sweep, false, origin, extent, style = stroke)
            }
        }
        Column(Modifier.weight(1f).padding(start = 16.dp), verticalArrangement = Arrangement.spacedBy(5.dp)) {
            rings.forEach { ring ->
                ValueRow(ring.label, ring.completion?.let { "${(it * 100).roundToInt()}%" } ?: "—")
                Text(
                    "${ring.value.format(ring.unit)} / ${ring.goal.roundToInt()} ${ring.unit}",
                    style = MaterialTheme.typography.bodySmall,
                )
            }
        }
    }
}

private enum class Metric(val label: String, val code: Int, val unit: String) {
    Steps("步数", 40002, "步"), Sleep("睡眠", 44105, "分钟"),
    Heart("静息心率", 46020, "次/分"), Stress("压力", 44306, "分")
}

@Composable
private fun TrendsScreen(modifier: Modifier, days: List<HealthDay>, dark: Boolean) {
    var metric by rememberSaveable { mutableStateOf(Metric.Steps) }
    var range by rememberSaveable { mutableIntStateOf(7) }
    val latest = days.firstOrNull()?.date
    val series = remember(days, range, metric) {
        val byDate = days.associateBy { it.date }
        latest?.let { date -> (range - 1 downTo 0).map { date.minusDays(it.toLong()) }.map {
            it to byDate[it]?.stat(metric.code)
        } }.orEmpty()
    }
    val values = series.mapNotNull { it.second }
    LazyColumn(modifier, contentPadding = PaddingValues(18.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        item {
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Metric.entries.forEach { option ->
                    FilterChip(selected = metric == option, onClick = { metric = option }, label = { Text(option.label) })
                }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                listOf(7, 30).forEach { days ->
                    FilterChip(selected = range == days, onClick = { range = days }, label = { Text("近 ${days} 天") })
                }
            }
        }
        item {
            GlassCard(metric.label, dark) {
                if (values.isEmpty()) Text("所选周期暂无记录")
                else {
                    ValueRow("平均", values.average().format(metric.unit, 1))
                    val color = MaterialTheme.colorScheme.primary
                    Canvas(Modifier.fillMaxWidth().height(130.dp)) {
                        val maximum = values.max().coerceAtLeast(1.0)
                        val slot = size.width / series.size
                        series.forEachIndexed { i, (_, value) ->
                            if (value != null) {
                                val x = slot * (i + .5f)
                                drawLine(color, Offset(x, size.height), Offset(x, size.height * (1 - value / maximum).toFloat()),
                                    strokeWidth = (slot * .56f).coerceAtMost(14.dp.toPx()), cap = StrokeCap.Round)
                            }
                        }
                    }
                }
            }
        }
        items(series.asReversed(), key = { it.first.toString() }) { (date, value) ->
            ValueRow(date.toString(), value.format(metric.unit))
        }
    }
}

@Composable
private fun WorkoutScreen(modifier: Modifier, workouts: List<Workout>, dark: Boolean) {
    var selected by rememberSaveable { mutableStateOf<Long?>(null) }
    val detail = workouts.firstOrNull { it.start == selected }
    LazyColumn(modifier, contentPadding = PaddingValues(18.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        if (workouts.isEmpty()) item { Text("数据库没有训练记录") }
        items(workouts, key = Workout::start) { workout ->
            GlassCard(sports[workout.sport] ?: "运动训练", dark) {
                ValueRow(localDateTime(workout.start).format(workoutDate), duration(workout.duration))
                if (workout.distance != null) ValueRow("距离", workout.distance.div(1000).format("公里", 2))
                TextButton(onClick = { selected = workout.start }) { Text("查看详情") }
            }
        }
    }
    if (detail != null) AlertDialog(
        onDismissRequest = { selected = null },
        title = { Text(sports[detail.sport] ?: "运动训练") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                ValueRow("开始", localDateTime(detail.start).format(workoutDate))
                ValueRow("时长", duration(detail.duration))
                ValueRow("距离", detail.distance?.div(1000).format("公里", 2))
                ValueRow("活动能量", detail.calories.format("千卡"))
                ValueRow("平均心率", detail.heartRate.format("次/分"))
                ValueRow("步数", detail.steps.format("步"))
            }
        },
        confirmButton = { TextButton(onClick = { selected = null }) { Text("完成") } },
    )
}

@Composable
private fun GlassCard(title: String, dark: Boolean, content: @Composable ColumnScope.() -> Unit) {
    val shape = RoundedCornerShape(24.dp)
    val (input, light) = rememberCouiSpotlight(
        interactive = true, preset = SpotlightPreset.TranslucentLarge1, dark = dark,
    )
    val palette = if (dark) listOf(Color(0xFF23233D), Color(0xFF15374A))
        else listOf(Color(0xFFF7EAF3), Color(0xFFE4F1FF))
    Column(
        Modifier.fillMaxWidth().clip(shape).background(Brush.linearGradient(palette))
            .border(1.dp, if (dark) Color(0x44FFFFFF) else Color(0x30304158), shape)
            .then(input).drawBehind { light?.invoke(this) }.padding(17.dp),
        verticalArrangement = Arrangement.spacedBy(9.dp),
    ) {
        Text(title, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
        content()
    }
}

@Composable
private fun ValueRow(label: String, value: String) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        Text(label, Modifier.weight(1f))
        Text(value, fontWeight = FontWeight.SemiBold)
    }
}

private fun Double?.format(unit: String, decimals: Int = 0): String =
    this?.let { String.format(Locale.getDefault(), "%.$decimals" + "f %s", it, unit) } ?: "—"

private fun duration(seconds: Double?): String {
    val minutes = seconds?.div(60)?.roundToInt() ?: return "—"
    return if (minutes < 60) "$minutes 分钟" else "${minutes / 60} 小时 ${minutes % 60} 分钟"
}

private val syncTimeFormat = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss")
private val workoutDate = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm")
private val sports = mapOf(
    140 to "力量训练", 210 to "攀岩", 257 to "户外步行", 258 to "户外跑步", 259 to "户外骑行",
    260 to "室内骑行", 262 to "泳池游泳", 264 to "室内跑步", 265 to "椭圆机", 266 to "开放水域游泳",
    273 to "徒步", 274 to "登山", 280 to "越野跑", 281 to "划船机", 282 to "跳绳", 283 to "自由训练",
    10001 to "HIIT",
)
