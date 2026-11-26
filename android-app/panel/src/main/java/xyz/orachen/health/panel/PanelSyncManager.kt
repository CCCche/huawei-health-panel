package xyz.orachen.health.panel

import android.content.Context
import android.content.Intent
import com.chaquo.python.PyException
import com.chaquo.python.PyObject
import com.chaquo.python.Python
import com.chaquo.python.android.AndroidPlatform
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.File
import java.io.IOException
import java.io.RandomAccessFile
import java.util.TimeZone
import java.util.concurrent.Executors

internal fun panelPython(context: Context): PyObject = synchronized(Python::class.java) {
    if (!Python.isStarted()) Python.start(AndroidPlatform(context.applicationContext))
    Python.getInstance().getModule("local_panel")
}

internal object PanelSyncManager {
    private const val PREFS_NAME = "panel_prefs"
    private const val KEY_AUTO_SYNC = "auto_sync_on_open"
    private const val KEY_SOURCE_SIG = "source_db_signature"
    private const val AUTO_SYNC_COOLDOWN_MS = 15_000L

    enum class SyncTrigger { AUTO, PULL, MANUAL }

    data class SyncState(
        val busy: Boolean = false,
        val message: String? = null,
        val shortLabel: String? = null,
        val error: Boolean = false,
        val needsHuaweiHealth: Boolean = false,
        val canLaunchHuaweiHealth: Boolean = false,
        val hasCachedKey: Boolean = false,
        val autoSyncOnOpen: Boolean = true,
        val revision: Int = 0,
        val syncResult: String? = null,
        val eventSeq: Int = 0,
    ) {
        fun toJson(): String = JSONObject().apply {
            put("busy", busy)
            put("message", message ?: JSONObject.NULL)
            put("short_label", shortLabel ?: JSONObject.NULL)
            put("error", error)
            put("needs_huawei_health", needsHuaweiHealth)
            put("can_launch_huawei_health", canLaunchHuaweiHealth)
            put("has_cached_key", hasCachedKey)
            put("auto_sync_on_open", autoSyncOnOpen)
            put("revision", revision)
            put("sync_result", syncResult ?: JSONObject.NULL)
            put("event_seq", eventSeq)
        }.toString()
    }

    private val syncExecutor = Executors.newSingleThreadExecutor()
    fun queueFileOperation(operation: () -> Unit) = syncExecutor.execute(operation)

    private var initialized = false
    private var hasAutoSyncedOnce = false
    private var lastAutoSyncAttemptMs = 0L
    private var suppressNextAutoSync = false
    private var listener: ((SyncState) -> Unit)? = null
    @Volatile
    private var state = SyncState()

    @Synchronized
    fun setListener(context: Context, cb: ((SyncState) -> Unit)?) {
        listener = cb
        if (cb != null) {
            cb(currentState(context))
        }
    }

    @Synchronized
    fun currentState(context: Context): SyncState {
        val appContext = context.applicationContext
        val prefs = appContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val hasKey = KeyCache(appContext).hasKey()
        val autoSync = prefs.getBoolean(KEY_AUTO_SYNC, true)
        val canLaunch = canLaunchHuaweiHealth(appContext)
        state = state.copy(
            hasCachedKey = hasKey,
            autoSyncOnOpen = autoSync,
            canLaunchHuaweiHealth = canLaunch,
        )
        return state
    }

    @Synchronized
    fun suppressNextAutoSync() {
        suppressNextAutoSync = true
    }

    @Synchronized
    fun resetAutoSyncCooldown() {
        lastAutoSyncAttemptMs = 0L
    }

    @Synchronized
    fun clearSourceDbSignature(context: Context) {
        context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .remove(KEY_SOURCE_SIG)
            .apply()
    }

    @Synchronized
    fun notifyExternalUpdate(context: Context, message: String) {
        val appContext = context.applicationContext
        updateState(
            currentState(appContext).copy(
                busy = false,
                message = message,
                shortLabel = null,
                error = false,
                needsHuaweiHealth = false,
                revision = state.revision + 1,
                syncResult = "updated",
                eventSeq = state.eventSeq + 1,
            ),
        )
    }

    @Synchronized
    fun setAutoSyncOnOpen(context: Context, enabled: Boolean): SyncState {
        val appContext = context.applicationContext
        appContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .putBoolean(KEY_AUTO_SYNC, enabled)
            .apply()
        val updated = currentState(appContext).copy(autoSyncOnOpen = enabled)
        updateState(updated)
        return updated
    }

    @Synchronized
    fun onAppStart(context: Context) {
        val appContext = context.applicationContext
        if (!initialized) {
            initialized = true
            cleanupTempFiles(appContext)
            appContext.cacheDir.listFiles()?.filter { it.name.startsWith("panel-export-") }?.forEach(File::delete)
            currentState(appContext)
        }
        val wasSuppressed = suppressNextAutoSync
        suppressNextAutoSync = false
        if (wasSuppressed) return

        val cur = currentState(appContext)
        if (!cur.autoSyncOnOpen || cur.busy) return

        val now = System.currentTimeMillis()
        if (!hasAutoSyncedOnce || cur.needsHuaweiHealth || (now - lastAutoSyncAttemptMs >= AUTO_SYNC_COOLDOWN_MS)) {
            hasAutoSyncedOnce = true
            lastAutoSyncAttemptMs = now
            startSync(appContext, forceRecoverKey = false, trigger = SyncTrigger.AUTO)
        }
    }

    @Synchronized
    fun startSync(
        context: Context,
        forceRecoverKey: Boolean = false,
        trigger: SyncTrigger = SyncTrigger.MANUAL,
    ): SyncState {
        val appContext = context.applicationContext
        val cur = currentState(appContext)
        if (cur.busy) return cur
        lastAutoSyncAttemptMs = System.currentTimeMillis()
        hasAutoSyncedOnce = true

        val initialMsg = when (trigger) {
            SyncTrigger.AUTO -> "正在检查华为运动健康数据更新…"
            SyncTrigger.PULL -> "正在增量检查数据更新…"
            SyncTrigger.MANUAL -> "正在准备自动同步…"
        }
        val initialShort = when (trigger) {
            SyncTrigger.AUTO, SyncTrigger.PULL -> "检查更新"
            SyncTrigger.MANUAL -> "准备同步"
        }
        val pending = cur.copy(
            busy = true,
            message = initialMsg,
            shortLabel = initialShort,
            error = false,
            needsHuaweiHealth = false,
            syncResult = null,
        )
        updateState(pending)

        syncExecutor.execute {
            runSyncWorker(appContext, forceRecoverKey = forceRecoverKey, trigger = trigger)
        }
        return pending
    }

    fun clearAll(context: Context, onDone: (SyncState) -> Unit) {
        val appContext = context.applicationContext
        syncExecutor.execute {
            val database = File(appContext.noBackupFilesDir, "panel.sqlite")
            runCatching { panelPython(appContext).callAttr("clear_database", database.path) }
            KeyCache(appContext).clear()
            clearSourceDbSignature(appContext)
            cleanupTempFiles(appContext)
            val next = synchronized(this) {
                val updated = currentState(appContext).copy(
                    busy = false,
                    message = "已清除本机健康数据与缓存密钥",
                    shortLabel = null,
                    error = false,
                    needsHuaweiHealth = false,
                    hasCachedKey = false,
                    revision = state.revision + 1,
                    syncResult = "updated",
                    eventSeq = state.eventSeq + 1,
                )
                updateState(updated)
                updated
            }
            onDone(next)
        }
    }

    fun launchHuaweiHealth(context: Context): Boolean {
        resetAutoSyncCooldown()
        val intent = context.packageManager.getLaunchIntentForPackage(HuaweiHealthSync.HUAWEI_HEALTH_PACKAGE)
            ?: return false
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return runCatching { context.startActivity(intent) }.isSuccess
    }

    fun canLaunchHuaweiHealth(context: Context): Boolean =
        context.packageManager.getLaunchIntentForPackage(HuaweiHealthSync.HUAWEI_HEALTH_PACKAGE) != null

    fun normalizeSqliteHeader(file: File) {
        if (!file.isFile) return
        RandomAccessFile(file, "rw").use { raf ->
            if (raf.length() < 20L) return
            val header = ByteArray(20)
            raf.readFully(header)
            if (DatabaseDecryptor.isPlain(header.copyOfRange(0, 16)) &&
                header[18] == 2.toByte() &&
                header[19] == 2.toByte()
            ) {
                raf.seek(18L)
                raf.write(1)
                raf.write(1)
            }
        }
    }

    private fun runSyncWorker(context: Context, forceRecoverKey: Boolean, trigger: SyncTrigger) {
        val database = File(context.noBackupFilesDir, "panel.sqlite")
        val snapshotFile = File(context.noBackupFilesDir, "huawei-snapshot.db")
        val keyCache = KeyCache(context)
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val ifChangedMeta = if (!forceRecoverKey && trigger != SyncTrigger.MANUAL && database.exists()) {
            prefs.getString(KEY_SOURCE_SIG, null)
        } else {
            null
        }

        var finalState: SyncState? = null
        for (attempt in 0..1) {
            var decryptedTemp: File? = null
            try {
                val cachedHex = if (forceRecoverKey) null else keyCache.loadHex()
                val snapResult = HuaweiHealthSync.snapshotAndResolveKey(
                    context = context,
                    snapshotFile = snapshotFile,
                    cachedKeyHex = cachedHex,
                    forceRecoverKey = forceRecoverKey,
                    ifChangedMeta = ifChangedMeta,
                    onProgress = { msg -> publishProgress(msg) },
                )

                if (snapResult.unchanged && database.exists()) {
                    val unchangedMsg = if (trigger == SyncTrigger.PULL) "已是最新健康数据" else null
                    val unchangedShort = if (trigger == SyncTrigger.PULL) "已是最新" else null
                    finalState = currentState(context).copy(
                        busy = false,
                        message = unchangedMsg,
                        shortLabel = unchangedShort,
                        error = false,
                        needsHuaweiHealth = false,
                        syncResult = "unchanged",
                        eventSeq = state.eventSeq + 1,
                    )
                    break
                }

                val effectiveHex = if (snapResult.isPlain) "" else snapResult.effectiveKeyHex.orEmpty()
                val totalBytes = snapResult.copiedBytes ?: snapshotFile.length()
                decryptedTemp = File.createTempFile("health-import-", ".sqlite", context.cacheDir)

                BufferedInputStream(snapshotFile.inputStream()).use { input ->
                    input.mark(16)
                    val header = ByteArray(16)
                    if (readBlock(input, header) != header.size) throw ImportError("数据库文件不完整")
                    input.reset()
                    decryptedTemp.outputStream().buffered().use { output ->
                        if (DatabaseDecryptor.isPlain(header)) {
                            publishProgress("检测到明文数据库，正在读取…")
                            input.copyTo(output)
                        } else {
                            val key = DatabaseDecryptor.rawKey(effectiveHex)
                            try {
                                DatabaseDecryptor.decrypt(input, output, key, totalBytes) { done, total ->
                                    if (total > 0) {
                                        val pct = ((done * 100L) / total).coerceIn(0L, 100L)
                                        publishProgress("正在解密数据库… $pct%", "解密 $pct%")
                                    }
                                }
                            } finally {
                                key.fill(0)
                            }
                        }
                    }
                }
                snapshotFile.delete()
                normalizeSqliteHeader(decryptedTemp)

                publishProgress("正在解析健康记录…", "解析数据")
                val offsetMinutes = TimeZone.getDefault().getOffset(System.currentTimeMillis()) / 60000
                val modeLabel = when (trigger) {
                    SyncTrigger.AUTO -> "自动同步"
                    SyncTrigger.PULL -> "下拉增量同步"
                    SyncTrigger.MANUAL -> "一键同步"
                }
                val allowIncremental = !forceRecoverKey
                val resultJson = JSONObject(
                    panelPython(context).callAttr(
                        "import_snapshot",
                        decryptedTemp.path,
                        database.path,
                        offsetMinutes,
                        modeLabel,
                        snapResult.dbMeta.orEmpty(),
                        allowIncremental,
                    ).toString(),
                )

                if (snapResult.recoveredNewKey && effectiveHex.isNotEmpty()) {
                    keyCache.saveHex(effectiveHex)
                }
                if (!snapResult.dbMeta.isNullOrBlank()) {
                    prefs.edit().putString(KEY_SOURCE_SIG, snapResult.dbMeta).apply()
                }

                val dailyCount = resultJson.optInt("daily", 0)
                val workoutCount = resultJson.optInt("workouts", 0)
                val usedIncremental = resultJson.optBoolean("incremental", false)
                val keyStatus = when {
                    snapResult.isPlain -> "明文数据库"
                    snapResult.recoveredNewKey -> "已自动获取并缓存新密钥"
                    else -> "已使用缓存密钥"
                }
                val prefix = when (trigger) {
                    SyncTrigger.AUTO -> "已自动同步"
                    SyncTrigger.PULL -> if (usedIncremental) "增量同步完成" else "同步完成"
                    SyncTrigger.MANUAL -> "同步完成"
                }
                finalState = currentState(context).copy(
                    busy = false,
                    message = "$prefix（$keyStatus）：$dailyCount 天记录，$workoutCount 项训练",
                    shortLabel = null,
                    error = false,
                    needsHuaweiHealth = false,
                    hasCachedKey = keyCache.hasKey(),
                    revision = state.revision + 1,
                    syncResult = "updated",
                    eventSeq = state.eventSeq + 1,
                )
                break
            } catch (e: SyncError) {
                finalState = currentState(context).copy(
                    busy = false,
                    message = e.message,
                    shortLabel = "同步失败",
                    error = true,
                    needsHuaweiHealth = e.needsHuaweiHealth,
                    syncResult = "error",
                    eventSeq = state.eventSeq + 1,
                )
                break
            } catch (e: ImportError) {
                if (attempt == 0 && !e.message.orEmpty().contains("密钥不正确")) {
                    Thread.sleep(350)
                    continue
                }
                finalState = currentState(context).copy(
                    busy = false,
                    message = e.message,
                    shortLabel = "同步失败",
                    error = true,
                    needsHuaweiHealth = false,
                    syncResult = "error",
                    eventSeq = state.eventSeq + 1,
                )
                break
            } catch (e: PyException) {
                val msg = e.message.orEmpty()
                if (attempt == 0 && (msg.contains("完整性") || msg.contains("malformed") || msg.contains("disk image"))) {
                    Thread.sleep(350)
                    continue
                }
                finalState = currentState(context).copy(
                    busy = false,
                    message = "解析数据库失败（${formatExceptionDetail(e)}）",
                    shortLabel = "同步失败",
                    error = true,
                    needsHuaweiHealth = false,
                    syncResult = "error",
                    eventSeq = state.eventSeq + 1,
                )
                break
            } catch (e: IOException) {
                finalState = currentState(context).copy(
                    busy = false,
                    message = "同步失败，请检查存储空间和文件权限（${formatExceptionDetail(e)}）",
                    shortLabel = "同步失败",
                    error = true,
                    needsHuaweiHealth = false,
                    syncResult = "error",
                    eventSeq = state.eventSeq + 1,
                )
                break
            } catch (e: Exception) {
                finalState = currentState(context).copy(
                    busy = false,
                    message = "自动同步失败（${formatExceptionDetail(e)}）",
                    shortLabel = "同步失败",
                    error = true,
                    needsHuaweiHealth = false,
                    syncResult = "error",
                    eventSeq = state.eventSeq + 1,
                )
                break
            } finally {
                snapshotFile.delete()
                decryptedTemp?.delete()
            }
        }

        finalState?.let { updateState(it) }
    }

    private fun publishProgress(message: String, explicitShort: String? = null) {
        val shortText = explicitShort ?: when {
            message.contains("Root") && message.contains("请求") -> "请求权限"
            message.contains("检查数据库快照") || message.contains("复制数据库") -> "读取快照"
            message.contains("校验密钥") -> "校验密钥"
            message.contains("内存恢复") -> "恢复密钥"
            message.contains("明文") -> "读取明文"
            message.contains("解析") -> "解析数据"
            else -> "同步中"
        }
        synchronized(this) {
            updateState(state.copy(busy = true, message = message, shortLabel = shortText, error = false))
        }
    }

    @Synchronized
    private fun updateState(next: SyncState) {
        state = next
        listener?.invoke(next)
    }

    private fun cleanupTempFiles(context: Context) {
        runCatching { File(context.noBackupFilesDir, "huawei-snapshot.db").delete() }
        runCatching {
            context.cacheDir.listFiles()
                ?.filter { it.name.startsWith("health-import-") && it.name.endsWith(".sqlite") }
                ?.forEach(File::delete)
        }
    }

    private fun formatExceptionDetail(error: Throwable): String {
        val msg = error.message?.trim()?.lineSequence()?.firstOrNull()?.take(140).orEmpty()
        return if (msg.isNotEmpty()) "${error.javaClass.simpleName}: $msg" else error.javaClass.simpleName
    }
}
