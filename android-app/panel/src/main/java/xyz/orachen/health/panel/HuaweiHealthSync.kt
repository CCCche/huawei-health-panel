package xyz.orachen.health.panel

import android.content.Context
import java.io.File
import java.io.IOException
import java.util.concurrent.TimeUnit

internal class SyncError(
    message: String,
    val needsHuaweiHealth: Boolean = false,
) : Exception(message)

internal object HelperProtocol {
    private val hex64Regex = Regex("^[0-9a-fA-F]{64}$")

    data class ParsedResult(
        val isPlain: Boolean,
        val usedCachedKey: Boolean,
        val recoveredKeyHex: String?,
        val copiedBytes: Long?,
        val unchanged: Boolean = false,
        val dbMeta: String? = null,
    )

    fun shellQuote(value: String): String =
        "'" + value.replace("'", "'\"'\"'") + "'"

    fun parseLines(
        lines: List<String>,
        exitCode: Int,
        timedOut: Boolean = false,
        stderr: String = "",
    ): ParsedResult {
        val stderrSnippet = stderr.lineSequence()
            .map { it.trim() }
            .firstOrNull { it.isNotEmpty() }
            ?.take(160)

        if (timedOut) {
            val detail = stderrSnippet?.let { "（$it）" }.orEmpty()
            throw SyncError("同步操作超时，请确认 Root 管理器已响应授权后重试$detail")
        }

        var rootGranted = false
        var isPlain = false
        var usedCachedKey = false
        var unchanged = false
        var recoveredKeyHex: String? = null
        var errorCode: String? = null
        var copiedBytes: Long? = null
        var dbMeta: String? = null

        for (raw in lines) {
            val line = raw.trim()
            when {
                line == "HEALTH_ROOT_OK" -> rootGranted = true
                line == "RESULT:PLAIN" -> isPlain = true
                line == "RESULT:CACHED_OK" -> usedCachedKey = true
                line == "RESULT:UNCHANGED" -> unchanged = true
                line.startsWith("RESULT:KEY:") -> recoveredKeyHex = line.removePrefix("RESULT:KEY:")
                line.startsWith("ERR:") -> errorCode = line.removePrefix("ERR:")
                line.startsWith("STATUS:DB_META:") ->
                    dbMeta = line.removePrefix("STATUS:DB_META:").takeIf { it.isNotBlank() }
                line.startsWith("STATUS:COPY_DONE:") ->
                    copiedBytes = line.removePrefix("STATUS:COPY_DONE:").toLongOrNull()
            }
        }

        if (exitCode == 0) {
            return when {
                unchanged -> ParsedResult(
                    isPlain = false,
                    usedCachedKey = false,
                    recoveredKeyHex = null,
                    copiedBytes = null,
                    unchanged = true,
                    dbMeta = dbMeta,
                )
                isPlain -> ParsedResult(
                    isPlain = true,
                    usedCachedKey = false,
                    recoveredKeyHex = null,
                    copiedBytes = copiedBytes,
                    dbMeta = dbMeta,
                )
                usedCachedKey -> ParsedResult(
                    isPlain = false,
                    usedCachedKey = true,
                    recoveredKeyHex = null,
                    copiedBytes = copiedBytes,
                    dbMeta = dbMeta,
                )
                recoveredKeyHex != null && hex64Regex.matches(recoveredKeyHex) ->
                    ParsedResult(
                        isPlain = false,
                        usedCachedKey = false,
                        recoveredKeyHex = recoveredKeyHex.lowercase(),
                        copiedBytes = copiedBytes,
                        dbMeta = dbMeta,
                    )
                else -> throw SyncError("密钥恢复组件返回了无效结果")
            }
        }

        if (errorCode != null) {
            throw mapErrorCode(errorCode, stderrSnippet)
        }
        val extra = stderrSnippet?.let { "：$it" }.orEmpty()
        if (!rootGranted || exitCode == 77) {
            throw SyncError("未取得 Root 权限，请在 Root 管理器（KernelSU / Magisk）中为本 App 授权$extra")
        }
        if (exitCode == 78) {
            throw SyncError("未找到内置密钥恢复组件，请重新安装本 APK$extra")
        }
        throw SyncError("自动读取或解密失败（退出码 $exitCode$extra）")
    }

    private fun mapErrorCode(code: String, stderrSnippet: String?): SyncError {
        val extra = stderrSnippet?.let { "（$it）" }.orEmpty()
        return when (code) {
            "DB_NOT_FOUND" -> SyncError("未找到华为运动健康数据库，请确认已安装并登录华为运动健康")
            "DB_NO_ACCESS", "DB_READ_FAILED" -> SyncError("读取华为运动健康数据库失败$extra")
            "DST_OPEN_FAILED" -> SyncError("无法写入本地快照文件$extra")
            "MEM_NO_ACCESS" -> SyncError("无法读取华为运动健康进程内存（权限不足）$extra")
            "DB_TOO_SMALL" -> SyncError("华为运动健康数据库文件不完整")
            "NO_DAEMON" -> SyncError(
                "未检测到华为运动健康后台进程，请先打开一次「华为运动健康」再重试",
                needsHuaweiHealth = true,
            )
            "NO_LIBSQLCIPHER", "NO_SALT" -> SyncError(
                "华为运动健康尚未打开数据库，请先打开「华为运动健康」首页后再试",
                needsHuaweiHealth = true,
            )
            "NO_CTX", "UNMASK_FAILED" -> SyncError(
                "未能从华为运动健康内存恢复密钥，请重启华为运动健康后重试",
                needsHuaweiHealth = true,
            )
            else -> SyncError("内置密钥恢复组件执行失败（$code$extra）")
        }
    }
}

internal object HuaweiHealthSync {
    const val HUAWEI_HEALTH_PACKAGE = "com.huawei.health"
    private const val HUAWEI_DB_PATH = "/data/data/com.huawei.health/databases/hihealth_003.db"
    private const val HELPER_NAME = "libhwh_keyrecover.so"
    private const val TIMEOUT_SECONDS = 60L

    data class SnapshotResult(
        val isPlain: Boolean,
        val effectiveKeyHex: String?,
        val recoveredNewKey: Boolean,
        val copiedBytes: Long?,
        val unchanged: Boolean = false,
        val dbMeta: String? = null,
    )

    fun copySourceSnapshot(context: Context, destination: File) {
        val helper = File(context.applicationInfo.nativeLibraryDir, HELPER_NAME)
        val args = listOf(helper.path, HUAWEI_DB_PATH, destination.path, "--snapshot-only")
        val command = args.joinToString(" ", transform = HelperProtocol::shellQuote)
        val process = ProcessBuilder("su", "-M", "-c", command)
            .redirectOutput(ProcessBuilder.Redirect.to(File("/dev/null")))
            .redirectError(ProcessBuilder.Redirect.to(File("/dev/null")))
            .start()
        process.outputStream.close()
        try {
            if (!process.waitFor(TIMEOUT_SECONDS, TimeUnit.SECONDS) ||
                process.exitValue() != 0 || destination.length() == 0L
            ) throw SyncError("无法读取华为运动健康数据库快照")
        } finally {
            if (process.isAlive) process.destroyForcibly()
        }
    }

    fun snapshotAndResolveKey(
        context: Context,
        snapshotFile: File,
        cachedKeyHex: String?,
        forceRecoverKey: Boolean,
        ifChangedMeta: String? = null,
        onProgress: (String) -> Unit,
    ): SnapshotResult {
        val nativeDir = context.applicationInfo.nativeLibraryDir
        val helper = File(nativeDir, HELPER_NAME)
        if (!helper.isFile) {
            throw SyncError("未找到内置密钥恢复组件（$nativeDir），请重新安装本 APK")
        }

        // Pre-create the snapshot file as the app user so UID/GID and SELinux MLS labels stay owned by this app.
        snapshotFile.parentFile?.mkdirs()
        snapshotFile.outputStream().close()

        val forceFlag = if (forceRecoverKey) " --force-recover" else ""
        val ifChangedFlag = if (!forceRecoverKey && !ifChangedMeta.isNullOrBlank()) {
            " --if-changed ${HelperProtocol.shellQuote(ifChangedMeta)}"
        } else {
            ""
        }
        val command = """if [ "$(id -u)" != 0 ]; then exit 77; fi
            |printf 'HEALTH_ROOT_OK\n'
            |if [ ! -x ${HelperProtocol.shellQuote(helper.absolutePath)} ]; then exit 78; fi
            |exec ${HelperProtocol.shellQuote(helper.absolutePath)} ${HelperProtocol.shellQuote(HUAWEI_DB_PATH)} ${HelperProtocol.shellQuote(snapshotFile.absolutePath)}$forceFlag$ifChangedFlag""".trimMargin()

        onProgress("正在请求 Root 权限并检查数据库…")
        val process = try {
            ProcessBuilder("su", "-M", "-c", command)
                .redirectErrorStream(false)
                .start()
        } catch (e: IOException) {
            throw SyncError("无法启动 Root 权限请求（未找到 su）")
        }

        val stderrBuf = StringBuilder()
        val stderrDrain = Thread {
            runCatching {
                process.errorStream.bufferedReader(Charsets.UTF_8).useLines { lines ->
                    lines.forEach { line ->
                        if (stderrBuf.length < 1024) {
                            if (stderrBuf.isNotEmpty()) stderrBuf.append('\n')
                            stderrBuf.append(line.take(1024 - stderrBuf.length))
                        }
                    }
                }
            }
        }.apply {
            isDaemon = true
            start()
        }

        runCatching {
            process.outputStream.bufferedWriter(Charsets.UTF_8).use { writer ->
                if (!forceRecoverKey && !cachedKeyHex.isNullOrBlank()) {
                    writer.write(cachedKeyHex.trim())
                }
                writer.newLine()
                writer.flush()
            }
        }

        val lines = mutableListOf<String>()
        process.inputStream.bufferedReader(Charsets.UTF_8).useLines { seq ->
            seq.forEach { line ->
                lines += line
                when {
                    line == "HEALTH_ROOT_OK" -> onProgress("已获取 Root 权限，正在检查数据库快照…")
                    line.startsWith("STATUS:COPY_DONE:") -> onProgress("数据库快照已复制，正在校验密钥…")
                    line == "STATUS:CACHED_KEY_INVALID" -> onProgress("缓存密钥已失效，正在从华为运动健康内存恢复…")
                    line == "STATUS:RECOVERING_KEY" -> onProgress("正在从华为运动健康内存恢复密钥…")
                }
            }
        }

        val finished = process.waitFor(TIMEOUT_SECONDS, TimeUnit.SECONDS)
        if (!finished) {
            process.destroyForcibly()
        }
        runCatching { stderrDrain.join(500) }

        val exitCode = if (finished) process.exitValue() else -1
        val parsed = HelperProtocol.parseLines(
            lines = lines,
            exitCode = exitCode,
            timedOut = !finished,
            stderr = stderrBuf.toString(),
        )

        return when {
            parsed.unchanged -> SnapshotResult(
                isPlain = false,
                effectiveKeyHex = null,
                recoveredNewKey = false,
                copiedBytes = null,
                unchanged = true,
                dbMeta = parsed.dbMeta,
            )
            parsed.isPlain -> SnapshotResult(
                isPlain = true,
                effectiveKeyHex = null,
                recoveredNewKey = false,
                copiedBytes = parsed.copiedBytes,
                dbMeta = parsed.dbMeta,
            )
            parsed.usedCachedKey -> SnapshotResult(
                isPlain = false,
                effectiveKeyHex = cachedKeyHex?.trim(),
                recoveredNewKey = false,
                copiedBytes = parsed.copiedBytes,
                dbMeta = parsed.dbMeta,
            )
            else -> SnapshotResult(
                isPlain = false,
                effectiveKeyHex = parsed.recoveredKeyHex,
                recoveredNewKey = true,
                copiedBytes = parsed.copiedBytes,
                dbMeta = parsed.dbMeta,
            )
        }
    }
}
