package xyz.orachen.health

import java.io.IOException
import java.util.concurrent.Executors
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow

internal object SyncRunner {
    private const val script =
        "/path/to/huawei-health-panel/sync_now.sh"

    data class Status(
        val message: String,
        val running: Boolean = false,
        val revision: Int = 0,
    )

    private val executor = Executors.newSingleThreadExecutor()
    private val current = MutableStateFlow(Status("尚未从 App 发起同步"))
    val status = current.asStateFlow()

    @Synchronized
    fun start() {
        val previous = current.value
        if (previous.running) return
        current.value = previous.copy(message = "正在请求 Root 并准备同步…", running = true)
        executor.execute {
            var completed = false
            var alreadyRunning = false
            var rootGranted = false
            try {
                // Only invoke the existing on-device worker. Never pass request data or credentials to su.
                val command = """if [ "$(id -u)" != 0 ]; then exit 77; fi
                    |printf 'HEALTH_ROOT_OK\n'
                    |if [ ! -r '$script' ]; then exit 78; fi
                    |exec /system/bin/sh '$script'""".trimMargin()
                val process = ProcessBuilder("su", "-c", command)
                    .redirectErrorStream(true)
                    .start()
                process.inputStream.bufferedReader().useLines { lines ->
                    lines.forEach { line ->
                        when {
                            line == "HEALTH_ROOT_OK" -> rootGranted = true
                            line.contains("Another sync is running") ||
                                line.contains("Lock exists without pid") -> alreadyRunning = true
                            line.contains("Decrypted ") -> update("数据库已解密，正在提取数据…")
                            line.contains("Batch ") -> update("正在上传健康记录…")
                            line.contains("Sync finished successfully.") -> completed = true
                        }
                    }
                }
                val exit = process.waitFor()
                val message = when {
                    exit == 0 && completed -> "同步完成"
                    exit == 0 && alreadyRunning -> "已有同步任务在运行"
                    !rootGranted -> "未取得 Root 权限，请检查 Root 管理器是否授权"
                    exit == 78 -> "未找到本机的 AntiGem 同步脚本"
                    else -> "同步未完成，请查看现有同步日志（退出码 $exit）"
                }
                current.value = Status(message, revision = previous.revision + if (completed && exit == 0) 1 else 0)
            } catch (_: IOException) {
                current.value = previous.copy(message = "无法启动 Root 同步进程")
            } catch (_: InterruptedException) {
                Thread.currentThread().interrupt()
                current.value = previous.copy(message = "同步等待已中断")
            }
        }
    }

    private fun update(message: String) {
        current.value = current.value.copy(message = message)
    }
}
