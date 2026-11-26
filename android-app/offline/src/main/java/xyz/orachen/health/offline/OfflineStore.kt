package xyz.orachen.health.offline

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteException
import android.net.Uri
import android.util.AtomicFile
import java.io.BufferedInputStream
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.io.RandomAccessFile
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import org.json.JSONArray
import org.json.JSONObject

internal data class HealthDay(val date: LocalDate, val stats: Map<Int, Double>) {
    fun stat(vararg codes: Int): Double? {
        for (code in codes) stats[code]?.let { return it }
        return null
    }
}

internal data class Workout(
    val start: Long, val duration: Double, val sport: Int, val distance: Double?,
    val calories: Double?, val heartRate: Double?, val steps: Double?,
)

internal data class HealthData(
    val days: List<HealthDay>,
    val workouts: List<Workout>,
    val syncedAtMs: Long? = null,
    val sourceDbSignature: String? = null,
)

internal data class AutoSyncResult(
    val data: HealthData,
    val keyStatus: String,
    val unchanged: Boolean = false,
)

internal class OfflineStore(private val context: Context) {
    private val file = AtomicFile(File(context.noBackupFilesDir, "health-summary.json"))
    private val staging = File(context.noBackupFilesDir, "import.sqlite")
    private val snapshot = File(context.noBackupFilesDir, "huawei-snapshot.db")
    private val keyCache = KeyCache(context)
    private val prefs = context.getSharedPreferences("offline_prefs", Context.MODE_PRIVATE)

    @Synchronized
    fun hasCachedKey(): Boolean = keyCache.hasKey()

    fun isAutoSyncOnOpen(): Boolean = prefs.getBoolean("auto_sync_on_open", true)

    fun setAutoSyncOnOpen(enabled: Boolean) {
        prefs.edit().putBoolean("auto_sync_on_open", enabled).apply()
    }

    @Synchronized
    fun restore(): HealthData? {
        removeStaging()
        if (!file.baseFile.exists()) return null
        return file.openRead().bufferedReader().use { decode(JSONObject(it.readText())) }
    }

    @Synchronized
    fun import(uri: Uri, keyHex: String, onProgress: ((String) -> Unit)? = null): HealthData {
        try {
            val totalBytes = context.contentResolver.openAssetFileDescriptor(uri, "r")?.use { afd ->
                afd.length.takeIf { it > 0L }
            } ?: -1L
            val source = context.contentResolver.openInputStream(uri)
                ?: throw ImportError("无法读取选中的文件")
            source.use { input ->
                decryptStreamToStaging(input, totalBytes = totalBytes, keyHex = keyHex, onProgress = onProgress)
            }
            onProgress?.invoke("正在解析健康记录…")
            return extractAndPersist(syncedAtMs = System.currentTimeMillis())
        } finally {
            removeStaging()
        }
    }

    @Synchronized
    fun syncFromHuaweiHealth(
        forceRecoverKey: Boolean = false,
        skipIfUnchanged: Boolean = false,
        existingData: HealthData? = null,
        onProgress: (String) -> Unit,
    ): AutoSyncResult {
        var lastTransient: Exception? = null
        val ifChangedMeta = if (!forceRecoverKey && skipIfUnchanged && existingData != null) {
            existingData.sourceDbSignature
        } else {
            null
        }
        for (attempt in 0..1) {
            try {
                val cachedHex = if (forceRecoverKey) null else keyCache.loadHex()
                val snapResult = HuaweiHealthSync.snapshotAndResolveKey(
                    context = context,
                    snapshotFile = snapshot,
                    cachedKeyHex = cachedHex,
                    forceRecoverKey = forceRecoverKey,
                    ifChangedMeta = ifChangedMeta,
                    onProgress = onProgress,
                )
                if (snapResult.unchanged && existingData != null) {
                    return AutoSyncResult(existingData, keyStatus = "数据库未变化", unchanged = true)
                }
                val effectiveHex = if (snapResult.isPlain) "" else snapResult.effectiveKeyHex.orEmpty()
                val totalBytes = snapResult.copiedBytes ?: snapshot.length()
                snapshot.inputStream().use { input ->
                    decryptStreamToStaging(input, totalBytes, effectiveHex, onProgress)
                }
                snapshot.delete()

                onProgress("正在解析健康记录…")
                val data = extractAndPersist(
                    syncedAtMs = System.currentTimeMillis(),
                    sourceDbSignature = snapResult.dbMeta,
                )
                if (snapResult.recoveredNewKey && effectiveHex.isNotEmpty()) {
                    keyCache.saveHex(effectiveHex)
                }
                val keyStatus = when {
                    snapResult.isPlain -> "明文数据库（无需密钥）"
                    snapResult.recoveredNewKey -> "已自动获取并缓存新密钥"
                    else -> "已使用缓存密钥解密"
                }
                return AutoSyncResult(data, keyStatus)
            } catch (e: ImportError) {
                // Retry once if Huawei Health flushed pages while the snapshot was being copied.
                if (attempt == 0 && !e.message.orEmpty().contains("密钥不正确")) {
                    lastTransient = e
                    removeStaging()
                    Thread.sleep(350)
                    continue
                }
                throw e
            } catch (e: SQLiteException) {
                if (attempt == 0) {
                    lastTransient = e
                    removeStaging()
                    Thread.sleep(350)
                    continue
                }
                throw e
            } finally {
                removeStaging()
            }
        }
        throw lastTransient ?: ImportError("同步失败")
    }

    @Synchronized
    fun clear() {
        file.delete()
        keyCache.clear()
        removeStaging()
    }

    private fun decryptStreamToStaging(
        input: InputStream,
        totalBytes: Long,
        keyHex: String,
        onProgress: ((String) -> Unit)?,
    ) {
        BufferedInputStream(input).use { buffered ->
            buffered.mark(16)
            val header = ByteArray(16)
            if (readBlock(buffered, header) != header.size) throw ImportError("数据库文件不完整")
            buffered.reset()
            staging.outputStream().buffered().use { output ->
                if (DatabaseDecryptor.isPlain(header)) {
                    onProgress?.invoke("检测到明文数据库，正在读取…")
                    buffered.copyTo(output)
                } else {
                    val key = DatabaseDecryptor.rawKey(keyHex)
                    try {
                        DatabaseDecryptor.decrypt(buffered, output, key, totalBytes) { done, total ->
                            if (onProgress != null && total > 0) {
                                val pct = ((done * 100L) / total).coerceIn(0L, 100L)
                                onProgress("正在解密数据库… $pct%")
                            }
                        }
                    } finally {
                        key.fill(0)
                    }
                }
            }
        }
    }

    private fun normalizeStagingHeader() {
        RandomAccessFile(staging, "rw").use { raf ->
            if (raf.length() < 20L) return
            val header = ByteArray(20)
            raf.readFully(header)
            if (DatabaseDecryptor.isPlain(header.copyOfRange(0, 16)) &&
                header[18] == 2.toByte() &&
                header[19] == 2.toByte()
            ) {
                // Single-file WAL snapshots without -wal/-shm sidecars need legacy journal version bytes to open read-only.
                raf.seek(18L)
                raf.write(1)
                raf.write(1)
            }
        }
    }

    private fun extractAndPersist(syncedAtMs: Long?, sourceDbSignature: String? = null): HealthData {
        normalizeStagingHeader()
        val data = SQLiteDatabase.openDatabase(
            staging.path,
            null,
            SQLiteDatabase.OPEN_READONLY or SQLiteDatabase.NO_LOCALIZED_COLLATORS,
        ).use { db ->
            extract(db, syncedAtMs, sourceDbSignature)
        }
        if (data.days.isEmpty() && data.workouts.isEmpty()) {
            throw ImportError("没有找到可显示的华为运动健康记录")
        }
        val bytes = encode(data).toString().toByteArray(Charsets.UTF_8)
        val stream = file.startWrite()
        try {
            stream.write(bytes)
            file.finishWrite(stream)
        } catch (error: IOException) {
            file.failWrite(stream)
            throw error
        }
        return data
    }

    private fun removeStaging() {
        snapshot.delete()
        staging.delete()
        File(staging.path + "-wal").delete()
        File(staging.path + "-shm").delete()
        File(staging.path + "-journal").delete()
    }

    private fun extract(db: SQLiteDatabase, syncedAtMs: Long?, sourceDbSignature: String? = null): HealthData {
        db.execSQL("PRAGMA trusted_schema=OFF")
        db.rawQuery("PRAGMA quick_check(1)", null).use { rows ->
            if (!rows.moveToFirst() || rows.getString(0) != "ok") {
                throw ImportError("数据库完整性检查失败，请导入完整快照")
            }
        }
        val tables = db.rawQuery("SELECT name FROM sqlite_master WHERE type = 'table'", null).use { rows ->
            buildSet { while (rows.moveToNext()) add(rows.getString(0)) }
        }
        val stats = mutableMapOf<LocalDate, MutableMap<Int, Double>>()
        val workouts = mutableListOf<Workout>()
        if ("hihealth_stat_day" in tables) {
            db.rawQuery(
                "SELECT date, stat_type, value FROM hihealth_stat_day ORDER BY date, modified_time, _id",
                null,
            ).use { rows ->
                while (rows.moveToNext()) {
                    if (rows.isNull(0) || rows.isNull(2)) continue
                    val date = runCatching {
                        LocalDate.parse(rows.getString(0), java.time.format.DateTimeFormatter.BASIC_ISO_DATE)
                    }.getOrNull() ?: continue
                    val code = rows.getInt(1)
                    if (code !in dailyCodes) continue
                    val value = rows.getString(2)?.toDoubleOrNull()?.takeIf { it.isFinite() && it >= 0 }
                    if (value != null) stats.getOrPut(date, ::mutableMapOf)[code] = value
                }
            }
        }
        if ("sample_sequence" in tables) {
            db.rawQuery(
                """SELECT start_time, end_time, sub_type_id, meta_data FROM sample_sequence
                    WHERE type_id = 30001 AND merged = 0 ORDER BY start_time DESC""", null,
            ).use { rows ->
                val seen = mutableSetOf<Long>()
                while (rows.moveToNext()) {
                    val start = rows.getLong(0)
                    if (start <= 0L || !seen.add(start)) continue
                    val meta = runCatching { JSONObject(rows.getString(3) ?: "{}") }.getOrElse { JSONObject() }
                    val duration = (meta.value("totalTime")?.takeIf { it > 0 }
                        ?: (rows.getLong(1) - start).toDouble().coerceAtLeast(0.0)) / 1000
                    workouts += Workout(
                        start, duration, rows.getInt(2), meta.value("totalDistance"),
                        meta.value("totalCalories")?.div(1000), meta.value("avgHeartRate"), meta.value("totalSteps"),
                    )
                }
            }
        }
        return HealthData(
            days = stats.map { (date, values) -> HealthDay(date, values) }.sortedByDescending { it.date },
            workouts = workouts,
            syncedAtMs = syncedAtMs,
            sourceDbSignature = sourceDbSignature,
        )
    }

    private fun encode(data: HealthData) = JSONObject().apply {
        data.syncedAtMs?.let { put("syncedAtMs", it) }
        data.sourceDbSignature?.let { put("sourceDbSignature", it) }
        put("days", JSONArray().apply {
            data.days.forEach { day ->
                put(JSONObject().put("date", day.date.toString()).put("stats", JSONObject().apply {
                    day.stats.forEach { (code, value) -> put(code.toString(), value) }
                }))
            }
        })
        put("workouts", JSONArray().apply {
            data.workouts.forEach { w ->
                put(JSONObject().put("start", w.start).put("duration", w.duration).put("sport", w.sport)
                    .put("distance", w.distance).put("calories", w.calories).put("heartRate", w.heartRate).put("steps", w.steps))
            }
        })
    }

    private fun decode(json: JSONObject): HealthData {
        val days = json.getJSONArray("days")
        val workouts = json.getJSONArray("workouts")
        val syncedAtMs = json.optLong("syncedAtMs", -1L).takeIf { it > 0L }
        val sourceDbSignature = json.optString("sourceDbSignature", "").takeIf { it.isNotBlank() }
        return HealthData(
            days = List(days.length()) {
                val row = days.getJSONObject(it)
                val values = row.getJSONObject("stats")
                HealthDay(LocalDate.parse(row.getString("date")), values.keys().asSequence().associate { key ->
                    key.toInt() to values.getDouble(key)
                })
            },
            workouts = List(workouts.length()) {
                val w = workouts.getJSONObject(it)
                Workout(w.getLong("start"), w.getDouble("duration"), w.getInt("sport"),
                    w.value("distance"), w.value("calories"), w.value("heartRate"), w.value("steps"))
            },
            syncedAtMs = syncedAtMs,
            sourceDbSignature = sourceDbSignature,
        )
    }

    private companion object {
        val dailyCodes = setOf(
            40002, 40003, 40004, 300002748, 200005921, 47101, 300002182, 300002125, 300002058,
            46020, 46017, 46016, 500044710, 47202, 47203, 44306, 44203, 44105, 44102,
            44103, 44101, 44104, 44107, 44207, 44219, 44231, 44223, 44227,
        )
    }
}

internal fun JSONObject.value(key: String): Double? = optDouble(key).takeIf { it.isFinite() && it >= 0 }

internal fun localDateTime(epochMs: Long) = Instant.ofEpochMilli(epochMs).atZone(ZoneId.systemDefault())
