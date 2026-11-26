package xyz.orachen.health.panel

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder
import java.io.File
import java.net.Inet4Address
import java.net.NetworkInterface
import java.security.SecureRandom
import java.util.concurrent.Executors

internal object PanelMcpSettings {
    private const val DEFAULT_PORT = 18765
    data class Config(val port: Int, val lan: Boolean) {
        fun host(): String? = if (lan) {
            runCatching {
                NetworkInterface.getNetworkInterfaces().toList().asSequence()
                    .filter { it.isUp && !it.isLoopback }
                    .flatMap { it.inetAddresses.toList().asSequence() }
                    .firstOrNull { it is Inet4Address && it.isSiteLocalAddress }?.hostAddress
            }.getOrNull()
        } else "127.0.0.1"
    }

    private fun prefs(context: Context) = context.getSharedPreferences("panel_mcp", Context.MODE_PRIVATE)

    fun config(context: Context) = prefs(context).let {
        Config(it.getInt("port", DEFAULT_PORT), it.getBoolean("lan", false))
    }

    fun save(context: Context, config: Config) {
        prefs(context).edit().putInt("port", config.port).putBoolean("lan", config.lan).apply()
    }

    @Synchronized
    fun token(context: Context): String =
        prefs(context).getString("token", null) ?: resetToken(context)

    @Synchronized
    fun resetToken(context: Context): String {
        val bytes = ByteArray(32).also(SecureRandom()::nextBytes)
        val token = android.util.Base64.encodeToString(
            bytes, android.util.Base64.URL_SAFE or android.util.Base64.NO_WRAP or android.util.Base64.NO_PADDING,
        )
        prefs(context).edit().putString("token", token).apply()
        return token
    }
}

class PanelMcpService : Service() {
    private val worker = Executors.newSingleThreadExecutor()
    private val lock = Any()
    private var stopped = false
    private var server: PanelMcpServer? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopSelf()
            return START_NOT_STICKY
        }
        if (status == Status.STARTING || status == Status.RUNNING) return START_NOT_STICKY
        val config = PanelMcpSettings.config(this)
        startForeground(NOTIFICATION_ID, notification("正在启动 · 端口 ${config.port}"),
            ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        status = Status.STARTING
        worker.execute {
            val host = config.host()
            val opened = runCatching {
                requireNotNull(host)
                val database = File(noBackupFilesDir, "panel.sqlite")
                val protocol = PanelMcpProtocol { name, arguments ->
                    panelPython(this).callAttr("mcp_read", database.path, name, arguments.toString()).toString()
                }
                PanelMcpServer(host, config.port, PanelMcpSettings.token(this), protocol)
            }
            synchronized(lock) {
                if (stopped) {
                    opened.getOrNull()?.close()
                    return@execute
                }
                val running = opened.getOrNull()
                if (running == null) {
                    status = Status.FAILED
                    stopSelf()
                } else {
                    server = running
                    running.start()
                    status = Status.RUNNING
                    getSystemService(NotificationManager::class.java).notify(
                        NOTIFICATION_ID, notification("运行中 · $host:${config.port}"),
                    )
                }
            }
        }
        return START_NOT_STICKY
    }

    private fun notification(message: String): Notification {
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel(CHANNEL_ID, "本地 MCP 服务", NotificationManager.IMPORTANCE_LOW))
        val flags = PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        val stop = PendingIntent.getService(this, 1, Intent(this, PanelMcpService::class.java).setAction(ACTION_STOP), flags)
        val open = PendingIntent.getActivity(this, 2, Intent(this, PanelActivity::class.java), flags)
        return Notification.Builder(this, CHANNEL_ID).setSmallIcon(R.drawable.ic_health)
            .setContentTitle("Health Panel · 本地 MCP 服务").setContentText(message).setContentIntent(open)
            .setOngoing(true).addAction(Notification.Action.Builder(null, "停止服务", stop).build()).build()
    }

    override fun onDestroy() {
        synchronized(lock) {
            stopped = true
            server?.close()
            server = null
            if (status != Status.FAILED) status = Status.STOPPED
        }
        worker.shutdownNow()
        stopForeground(STOP_FOREGROUND_REMOVE)
        super.onDestroy()
    }

    override fun onTimeout(startId: Int, fgsType: Int) {
        stopSelf(startId)
    }

    enum class Status(val label: String) {
        STOPPED("已停止"), STARTING("正在启动"), RUNNING("运行中"), FAILED("启动失败，请检查端口和网络"),
    }

    companion object {
        private const val CHANNEL_ID = "panel_mcp"
        private const val NOTIFICATION_ID = 18765
        private const val ACTION_STOP = "xyz.orachen.health.panel.STOP_MCP"
        @Volatile var status = Status.STOPPED
            private set
    }
}
