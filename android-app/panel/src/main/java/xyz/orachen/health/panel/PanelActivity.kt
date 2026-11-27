package xyz.orachen.health.panel

import android.annotation.SuppressLint
import android.app.AlertDialog
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.BitmapFactory
import android.graphics.Paint
import android.graphics.Rect
import android.graphics.RectF
import android.graphics.pdf.PdfDocument
import android.util.Base64
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.VibrationAttributes
import android.os.VibrationEffect
import android.os.VibratorManager
import android.text.InputType
import android.view.MotionEvent
import android.view.HapticFeedbackConstants
import android.view.View
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.util.TimeZone
import java.util.concurrent.Executors

private const val panelHost = "health-panel.local"
private const val panelHome = "https://$panelHost/"
private val worker = Executors.newSingleThreadExecutor()

class PanelActivity : ComponentActivity() {
    private lateinit var web: WebView
    private lateinit var database: File
    private var rootContainer: FrameLayout? = null
    private var lastInsetsPx = intArrayOf(0, 0, 0, 0)
    private var isDarkUi = false
    private var pendingExport: String? = null
    private var pendingPanelExport: PanelExport? = null
    private var pendingEcgExportFile: String? = null
    private var ecgPickerLaunched = false
    private var inProgress = false
    private var progressDialog: AlertDialog? = null
    private lateinit var backCallback: OnBackPressedCallback

    private val picker = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) inspectSource(uri)
    }

    private val exporter = registerForActivityResult(ActivityResultContracts.CreateDocument("application/gpx+xml")) { uri ->
        val query = pendingExport
        pendingExport = null
        if (uri != null && query != null) worker.execute {
            val written = runCatching {
                val result = api("/api/v1/dashboard/workout.gpx", query)
                if (result.getInt(0) != 200) throw IOException()
                val out = contentResolver.openOutputStream(uri) ?: throw IOException()
                out.use { it.write(result.getString(3).toByteArray(Charsets.UTF_8)) }
            }.isSuccess
            notifyUser(if (written) "已导出 GPX 路线" else "无法保存 GPX 文件")
        }
    }

    private val databaseExporter = registerForActivityResult(
        ActivityResultContracts.CreateDocument("application/octet-stream"),
    ) { uri -> finishPanelExport(uri) }

    private val keyExporter = registerForActivityResult(
        ActivityResultContracts.CreateDocument("text/plain"),
    ) { uri -> finishPanelExport(uri) }

    private val ecgExporter = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val file = pendingEcgExportFile?.let { File(cacheDir, it) }
        pendingEcgExportFile = null
        ecgPickerLaunched = false
        val uri = result.data?.data
        if (file != null) worker.execute {
            try {
                if (uri != null) {
                    val written = runCatching {
                        (contentResolver.openOutputStream(uri, "wt") ?: throw IOException()).use { output ->
                            file.inputStream().use { it.copyTo(output) }
                        }
                    }.isSuccess
                    notifyUser(if (written) "心电图已导出" else "无法保存心电图报告")
                }
            } finally {
                file.delete()
            }
        }
    }

    private fun finishPanelExport(uri: Uri?) {
        val selection = pendingPanelExport
        pendingPanelExport = null
        if (uri == null || selection == null) return
        notifyUser("正在准备导出…")
        PanelSyncManager.queueFileOperation {
            val saved = runCatching { selection.write(applicationContext, uri) }.isSuccess
            notifyUser(if (saved) "已保存导出文件" else "导出失败，请检查数据、Root 权限和存储空间")
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        isDarkUi = getSharedPreferences("panel_prefs", Context.MODE_PRIVATE)
            .getString("ui_theme", "light") == "dark"
        window.attributes = window.attributes.apply {
            layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
        }
        applySystemBarAppearance(isDarkUi)
        database = File(noBackupFilesDir, "panel.sqlite")
        pendingExport = savedInstanceState?.getString("pendingGpx")
        pendingEcgExportFile = savedInstanceState?.getString("pendingEcgExportFile")
        ecgPickerLaunched = pendingEcgExportFile != null
        pendingPanelExport = savedInstanceState?.getString("pendingPanelExport")?.let(PanelExport::valueOf)
        backCallback = object : OnBackPressedCallback(false) {
            override fun handleOnBackPressed() {
                if (::web.isInitialized) {
                    web.evaluateJavascript(NativeBackBridge.BACK_PRESS_JS, null)
                } else {
                    finish()
                }
            }
        }
        onBackPressedDispatcher.addCallback(this, backCallback)
        configurePanel()
        val root = FrameLayout(this).apply {
            setBackgroundColor(if (isDarkUi) Color.BLACK else Color.parseColor("#F2F2F7"))
            addView(web, FrameLayout.LayoutParams(-1, -1))
        }
        rootContainer = root
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val safe = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout(),
            )
            view.setPadding(0, 0, 0, 0)
            lastInsetsPx = intArrayOf(safe.top, safe.right, safe.bottom, safe.left)
            pushSafeInsetsToWeb()
            insets
        }
        setContentView(root)
        applySystemBarAppearance(isDarkUi)
        ViewCompat.requestApplyInsets(root)
        if (savedInstanceState == null || web.restoreState(savedInstanceState) == null) web.loadUrl(panelHome)
    }

    override fun onStart() {
        super.onStart()
        PanelSyncManager.setListener(applicationContext) { state ->
            runOnUiThread {
                if (!isDestroyed && !isFinishing) pushSyncStateToWeb(state)
            }
        }
        PanelSyncManager.onAppStart(applicationContext)
    }

    override fun onStop() {
        PanelSyncManager.setListener(applicationContext, null)
        super.onStop()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        web.saveState(outState)
        pendingExport?.let { outState.putString("pendingGpx", it) }
        if (ecgPickerLaunched) pendingEcgExportFile?.let { outState.putString("pendingEcgExportFile", it) }
        pendingPanelExport?.let { outState.putString("pendingPanelExport", it.name) }
        super.onSaveInstanceState(outState)
    }

    override fun onDestroy() {
        progressDialog?.dismiss()
        if (::web.isInitialized) {
            web.removeJavascriptInterface("__panelNative")
            (web.parent as? FrameLayout)?.removeView(web)
            web.destroy()
        }
        super.onDestroy()
    }

    private fun applySystemBarAppearance(dark: Boolean) {
        isDarkUi = dark
        val barStyle = if (dark) {
            SystemBarStyle.dark(Color.TRANSPARENT)
        } else {
            SystemBarStyle.light(Color.TRANSPARENT, Color.TRANSPARENT)
        }
        enableEdgeToEdge(statusBarStyle = barStyle, navigationBarStyle = barStyle)
        window.isNavigationBarContrastEnforced = false
        WindowCompat.getInsetsController(window, window.decorView).apply {
            isAppearanceLightStatusBars = !dark
            isAppearanceLightNavigationBars = !dark
        }
        val bg = if (dark) Color.BLACK else Color.parseColor("#F2F2F7")
        window.decorView.setBackgroundColor(bg)
        rootContainer?.setBackgroundColor(bg)
        if (::web.isInitialized) web.setBackgroundColor(bg)
    }

    private fun pushSafeInsetsToWeb() {
        if (!::web.isInitialized) return
        val (top, right, bottom, left) = lastInsetsPx
        web.evaluateJavascript(
            "window.__applySafeAreaInsets && window.__applySafeAreaInsets($top,$right,$bottom,$left)",
            null,
        )
    }

    private fun pushSyncStateToWeb(state: PanelSyncManager.SyncState) {
        if (!::web.isInitialized) return
        val json = state.toJson()
        web.evaluateJavascript("window.__onLocalSyncStatus && window.__onLocalSyncStatus($json)", null)
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun configurePanel() {
        web = WebView(this).apply {
            setBackgroundColor(if (isDarkUi) Color.BLACK else Color.parseColor("#F2F2F7"))
            isVerticalScrollBarEnabled = false
            isHorizontalScrollBarEnabled = false
            scrollBarStyle = View.SCROLLBARS_INSIDE_OVERLAY
            overScrollMode = View.OVER_SCROLL_NEVER
            // Chromium coalesces DOM touchmove events during compositor scrolling.
            // Keep only the latest native sample and at most one outstanding delivery.
            var latestX = 0f
            var latestY = 0f
            var dirty = false
            var scheduled = false
            var inFlight = false
            fun scheduleLightSample() {
                if (!dirty || scheduled || inFlight) return
                scheduled = true
                postOnAnimation {
                    scheduled = false
                    if (!dirty || width <= 0 || height <= 0 || !isAttachedToWindow) return@postOnAnimation
                    dirty = false
                    inFlight = true
                    evaluateJavascript("window.__panelLightSample?.(${latestX / width},${latestY / height})") {
                        inFlight = false
                        scheduleLightSample()
                    }
                }
            }
            setOnTouchListener { _, event ->
                if (event.actionMasked == MotionEvent.ACTION_MOVE && event.pointerCount == 1 &&
                    event.getToolType(0) == MotionEvent.TOOL_TYPE_FINGER) {
                    latestX = event.x
                    latestY = event.y
                    dirty = true
                    scheduleLightSample()
                } else {
                    dirty = false
                }
                false
            }
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            settings.setSupportZoom(false)
            settings.mediaPlaybackRequiresUserGesture = true
            clearCacheIfAppUpgraded(this)
            addJavascriptInterface(PanelNativeBridge(), "__panelNative")
            webViewClient = object : WebViewClient() {
                override fun onPageFinished(view: WebView, url: String?) {
                    super.onPageFinished(view, url)
                    pushSafeInsetsToWeb()
                    pushSyncStateToWeb(PanelSyncManager.currentState(applicationContext))
                    view.evaluateJavascript(NativeBackBridge.SYNC_STATE_JS, null)
                }

                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    val uri = request.url
                    if (!uri.localPanel()) return true
                    if (!request.isForMainFrame) return false
                    return when (uri.path) {
                        "/local/import" -> {
                            launchManualImportPicker()
                            true
                        }
                        "/api/v1/dashboard/workout.gpx" -> {
                            exportRoute(uri)
                            true
                        }
                        null, "/", "/index.html" -> false
                        else -> true
                    }
                }

                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                    val uri = request.url
                    if (!uri.localPanel()) {
                        return if (request.method == "GET" && uri.allowedMapTile()) null
                        else response(403, "text/plain", "Blocked")
                    }
                    val path = uri.path ?: "/"
                    if (path.startsWith("/api/v1/local/") && request.method in setOf("GET", "POST")) {
                        return handleLocalApi(path, uri)
                    }
                    if (request.method != "GET") return response(403, "text/plain", "Blocked")
                    if (path.startsWith("/api/v1/dashboard/")) {
                        return runCatching {
                            val result = api(path, uri.encodedQuery.orEmpty())
                            response(result.getInt(0), result.getString(1), result.getString(3))
                        }.getOrElse {
                            response(500, "application/json", """{"error":"离线面板暂时无法读取数据"}""")
                        }
                    }
                    return asset(path)
                }
            }
        }
    }

    private inner class PanelNativeBridge {
        @JavascriptInterface
        fun exportEcg(id: String, format: String, image: String) {
            val recordId = id.toLongOrNull()?.takeIf { it > 0 } ?: return
            if (format !in setOf("PNG", "PDF", "CSV") || image.length > 6_000_000) return
            runOnUiThread {
                if (isDestroyed || isFinishing || pendingEcgExportFile != null) return@runOnUiThread
                prepareEcgExport(recordId, format, image)
            }
        }

        @JavascriptInterface
        fun exportData(kind: String) = runOnUiThread {
            if (isDestroyed || isFinishing) return@runOnUiThread
            if (kind == "COPY_KEY") copyDatabaseKey()
            else PanelExport.entries.firstOrNull { it.name == kind }?.let(::launchPanelExport)
        }

        @JavascriptInterface
        fun mcpState(): String {
            val config = PanelMcpSettings.config(applicationContext)
            val status = PanelMcpService.status
            val url = config.host()?.let { "http://$it:${config.port}/mcp" }
            return JSONObject().put("port", config.port).put("lan", config.lan)
                .put("active", status == PanelMcpService.Status.RUNNING || status == PanelMcpService.Status.STARTING)
                .put("status", status.label).put("url", url ?: JSONObject.NULL).toString()
        }

        @JavascriptInterface
        fun mcpAction(action: String) = runOnUiThread {
            if (!isDestroyed && !isFinishing) performMcpAction(action)
        }

        @JavascriptInterface
        fun saveMcpConfig(port: Int, lan: Boolean) = runOnUiThread {
            if (isDestroyed || isFinishing || port !in 1024..65535) return@runOnUiThread
            if (PanelMcpService.status in setOf(PanelMcpService.Status.RUNNING, PanelMcpService.Status.STARTING)) {
                notifyUser("请先停止 MCP 服务")
            } else {
                PanelMcpSettings.save(this@PanelActivity, PanelMcpSettings.Config(port, lan))
                notifyUser("MCP 设置已保存")
            }
        }

        @JavascriptInterface
        fun vibrate(durationMs: Int) {
            val ms = durationMs.coerceIn(4, 30).toLong()
            val vm = getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager
            val vibrator = vm?.defaultVibrator
            if (vibrator != null && vibrator.hasVibrator()) {
                val effect = VibrationEffect.createOneShot(ms, VibrationEffect.DEFAULT_AMPLITUDE)
                runCatching {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                        val attrs = VibrationAttributes.createForUsage(VibrationAttributes.USAGE_TOUCH)
                        vibrator.vibrate(effect, attrs)
                    } else {
                        vibrator.vibrate(effect)
                    }
                }
            } else {
                runOnUiThread {
                    if (!isDestroyed && !isFinishing && ::web.isInitialized) {
                        web.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
                    }
                }
            }
        }
        @JavascriptInterface
        fun setCanGoBack(canGoBack: Boolean) {
            runOnUiThread {
                if (!isDestroyed && !isFinishing && ::backCallback.isInitialized) {
                    backCallback.isEnabled = canGoBack
                }
            }
        }

        @JavascriptInterface
        fun finishFromBack() {
            runOnUiThread {
                if (!isDestroyed && !isFinishing) {
                    if (::backCallback.isInitialized) backCallback.isEnabled = false
                    finish()
                }
            }
        }
    }

    private fun handleLocalApi(path: String, uri: Uri): WebResourceResponse {
        val state = when (path) {
            "/api/v1/local/sync-status" -> PanelSyncManager.currentState(applicationContext)
            "/api/v1/local/sync" -> {
                val forceKey = uri.getQueryParameter("force_key") == "1"
                val trigger = when (uri.getQueryParameter("mode")) {
                    "pull" -> PanelSyncManager.SyncTrigger.PULL
                    "auto" -> PanelSyncManager.SyncTrigger.AUTO
                    else -> PanelSyncManager.SyncTrigger.MANUAL
                }
                PanelSyncManager.startSync(applicationContext, forceRecoverKey = forceKey, trigger = trigger)
            }
            "/api/v1/local/theme" -> {
                val mode = if (uri.getQueryParameter("mode") == "dark") "dark" else "light"
                getSharedPreferences("panel_prefs", Context.MODE_PRIVATE)
                    .edit()
                    .putString("ui_theme", mode)
                    .apply()
                runOnUiThread {
                    if (!isDestroyed && !isFinishing) applySystemBarAppearance(mode == "dark")
                }
                return response(200, "application/json", """{"theme":"$mode"}""")
            }
            "/api/v1/local/haptic" -> {
                val kind = uri.getQueryParameter("kind") ?: "tick"
                runOnUiThread {
                    if (!isDestroyed && !isFinishing && ::web.isInitialized) {
                        val code = when (kind) {
                            "confirm" -> HapticFeedbackConstants.CONFIRM
                            "reject" -> HapticFeedbackConstants.REJECT
                            else -> HapticFeedbackConstants.CLOCK_TICK
                        }
                        web.performHapticFeedback(code)
                    }
                }
                return response(200, "application/json", """{"ok":true}""")
            }
            "/api/v1/local/auto-sync" -> {
                val enabled = uri.getQueryParameter("enabled") != "0"
                PanelSyncManager.setAutoSyncOnOpen(applicationContext, enabled)
            }
            "/api/v1/local/open-huawei-health" -> {
                runOnUiThread {
                    if (!isDestroyed && !isFinishing) {
                        if (!PanelSyncManager.launchHuaweiHealth(this)) {
                            notifyUser("未找到「华为运动健康」应用")
                        }
                    }
                }
                PanelSyncManager.currentState(applicationContext)
            }
            "/api/v1/local/import" -> {
                runOnUiThread {
                    if (!isDestroyed && !isFinishing) launchManualImportPicker()
                }
                PanelSyncManager.currentState(applicationContext)
            }
            "/api/v1/local/clear" -> {
                runOnUiThread {
                    if (!isDestroyed && !isFinishing) confirmAndClear()
                }
                PanelSyncManager.currentState(applicationContext)
            }
            else -> return response(404, "application/json", """{"error":"未知的本地接口"}""")
        }
        return response(200, "application/json", state.toJson())
    }

    private fun prepareEcgExport(recordId: Long, format: String, image: String) {
        val temp = try {
            File.createTempFile("ecg-export-", ".tmp", cacheDir)
        } catch (_: IOException) {
            notifyUser("无法创建心电图导出文件")
            return
        }
        pendingEcgExportFile = temp.name
        worker.execute {
            val prepared = runCatching {
                when (format) {
                    "CSV" -> {
                        val csv = api("/api/v1/dashboard/ecg.csv", "id=$recordId")
                        if (csv.getInt(0) != 200) throw IOException()
                        temp.writeText(csv.getString(3))
                    }
                    "PNG" -> temp.writeBytes(Base64.decode(image, Base64.DEFAULT))
                    "PDF" -> writeEcgPdf(temp, image)
                }
            }.isSuccess
            runOnUiThread {
                if (!prepared || isFinishing || isDestroyed) {
                    pendingEcgExportFile = null
                    temp.delete()
                    if (!prepared) notifyUser("无法生成心电图报告")
                    return@runOnUiThread
                }
                PanelSyncManager.suppressNextAutoSync()
                val mime = when (format) {
                    "CSV" -> "text/csv"
                    "PNG" -> "image/png"
                    else -> "application/pdf"
                }
                val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                    .setType(mime).putExtra(Intent.EXTRA_TITLE, "ECG_$recordId.${format.lowercase()}")
                ecgPickerLaunched = true
                runCatching { ecgExporter.launch(intent) }.onFailure {
                    pendingEcgExportFile = null
                    ecgPickerLaunched = false
                    temp.delete()
                    notifyUser("无法打开文件选择器")
                }
            }
        }
    }

    private fun writeEcgPdf(file: File, image: String) {
        val bytes = Base64.decode(image, Base64.DEFAULT)
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        if (bounds.outWidth !in 1..6144 || bounds.outHeight !in 1..1000) throw IOException()
        val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: throw IOException()
        val document = PdfDocument()
        try {
            val paint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG).apply { textSize = 12f }
            val pointsPerPixel = (50 * 72f / 25.4f) / bitmap.height
            val sliceWidth = (720 / pointsPerPixel).toInt()
            var left = 0
            var pageNumber = 1
            while (left < bitmap.width) {
                val right = minOf(bitmap.width, left + sliceWidth)
                val page = document.startPage(PdfDocument.PageInfo.Builder(792, 612, pageNumber++).create())
                page.canvas.drawText("ECG · Lead I · 25 mm/s · 10 mm/mV", 36f, 42f, paint)
                page.canvas.drawBitmap(bitmap, Rect(left, 0, right, bitmap.height),
                    RectF(36f, 62f, 36f + (right - left) * pointsPerPixel, 62f + bitmap.height * pointsPerPixel), paint)
                document.finishPage(page)
                left = right
            }
            file.outputStream().use(document::writeTo)
        } finally {
            document.close()
            bitmap.recycle()
        }
    }

    private fun launchPanelExport(selection: PanelExport) {
        if (pendingPanelExport != null) return
        pendingPanelExport = selection
        PanelSyncManager.suppressNextAutoSync()
        val launcher = if (selection == PanelExport.KEY) keyExporter else databaseExporter
        launcher.launch(selection.filename())
    }

    private fun copyDatabaseKey() {
        PanelSyncManager.queueFileOperation {
            val key = runCatching { PanelExport.resolveKey(applicationContext) }.getOrNull()
            runOnUiThread {
                if (isDestroyed || isFinishing) return@runOnUiThread
                if (key == null) notifyUser("无法获取密钥，请检查 Root 权限和华为运动健康是否已启动")
                else {
                    copySensitive(this, "SQLCipher 密钥", key)
                    notifyUser("密钥已复制")
                }
            }
        }
    }

    private fun performMcpAction(action: String) {
        val service = Intent(this, PanelMcpService::class.java)
        when (action) {
            "start" -> runCatching { startForegroundService(service) }
                .onSuccess {
                    if (Build.VERSION.SDK_INT >= 33 &&
                        checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
                    ) requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 18765)
                }
                .onFailure { notifyUser("无法启动 MCP 服务") }
            "stop" -> {
                stopService(service)
                notifyUser("正在停止 MCP 服务")
            }
            "copy-token" -> {
                copySensitive(this, "MCP Token", PanelMcpSettings.token(this))
                notifyUser("Token 已复制")
            }
            "copy-config" -> {
                val config = PanelMcpSettings.config(this)
                val host = config.host()
                if (host == null) {
                    notifyUser("当前没有可用的局域网 IPv4 地址")
                    return
                }
                val server = JSONObject().put("type", "http").put("url", "http://$host:${config.port}/mcp")
                    .put("headers", JSONObject().put("Authorization", "Bearer ${PanelMcpSettings.token(this)}"))
                val json = JSONObject().put("mcpServers", JSONObject().put("huawei-health", server))
                copySensitive(this, "MCP 客户端配置", json.toString(2))
                notifyUser("MCP 客户端配置已复制")
            }
            "reset" -> {
                stopService(service)
                PanelMcpSettings.resetToken(this)
                notifyUser("Token 已重置")
            }
        }
    }

    private fun launchManualImportPicker() {
        if (inProgress) return
        PanelSyncManager.suppressNextAutoSync()
        picker.launch(arrayOf("*/*"))
    }

    private fun confirmAndClear() {
        AlertDialog.Builder(this)
            .setTitle("清除本地健康数据？")
            .setMessage("将删除本 App 内已同步的健康数据库和缓存密钥，原华为运动健康数据不受影响。")
            .setNegativeButton("取消", null)
            .setPositiveButton("清除") { _, _ ->
                PanelSyncManager.clearAll(applicationContext) { state ->
                    runOnUiThread {
                        if (!isDestroyed && !isFinishing) {
                            pushSyncStateToWeb(state)
                            notifyUser(state.message ?: "已清除本地数据")
                        }
                    }
                }
            }
            .show()
    }

    private fun asset(path: String): WebResourceResponse {
        val name = if (path == "/") "index.html" else path.removePrefix("/")
        if (!name.matches(Regex("[A-Za-z0-9._/-]+")) || name.split('/').any { it == "." || it == ".." }
            || (name !in setOf("index.html", "icon.svg", "icon.png", "manifest.json") && !name.startsWith("static/"))) {
            return response(404, "text/plain", "Not found")
        }
        val mime = when (name.substringAfterLast('.')) {
            "html" -> "text/html"
            "js" -> "application/javascript"
            "css" -> "text/css"
            "svg" -> "image/svg+xml"
            "png" -> "image/png"
            "json" -> "application/json"
            else -> "text/plain"
        }
        return try {
            WebResourceResponse(
                mime,
                if (mime == "image/png") null else "UTF-8",
                200,
                "OK",
                NativeBackBridge.NO_CACHE_HEADERS,
                assets.open(name),
            )
        } catch (_: IOException) {
            response(404, "text/plain", "Not found")
        }
    }

    private fun inspectSource(uri: Uri) {
        if (inProgress) return
        inProgress = true
        worker.execute {
            val plain = runCatching { open(uri).use { input ->
                val header = ByteArray(16)
                if (readBlock(input, header) != header.size) throw ImportError("数据库文件不完整")
                DatabaseDecryptor.isPlain(header)
            } }
            runOnUiThread {
                if (isDestroyed || isFinishing) return@runOnUiThread
                inProgress = false
                plain.onSuccess { if (it) importSnapshot(uri, null) else promptForKey(uri) }
                    .onFailure { notifyUser(it.message ?: "无法读取选中的文件") }
            }
        }
    }

    private fun promptForKey(uri: Uri) {
        val input = EditText(this).apply {
            hint = "64 位十六进制密钥"
            setSingleLine()
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
        }
        val field = FrameLayout(this).apply {
            val pad = (24 * resources.displayMetrics.density).toInt()
            setPadding(pad, 0, pad, 0)
            addView(input, FrameLayout.LayoutParams(-1, -2))
        }
        val dialog = AlertDialog.Builder(this).setTitle("输入数据库密钥").setView(field)
            .setNegativeButton("取消", null).setPositiveButton("导入", null).create()
        dialog.setOnShowListener {
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                try {
                    val key = DatabaseDecryptor.rawKey(input.text.toString())
                    input.text.clear()
                    dialog.dismiss()
                    importSnapshot(uri, key)
                } catch (error: IllegalArgumentException) {
                    input.error = error.message
                }
            }
        }
        dialog.show()
    }

    private fun importSnapshot(uri: Uri, key: ByteArray?) {
        if (inProgress) { key?.fill(0); return }
        inProgress = true
        progressDialog = AlertDialog.Builder(this).setMessage("正在导入本地健康数据…")
            .setCancelable(false).show()
        worker.execute {
            val result = runCatching {
                val inputFile = File.createTempFile("health-import-", ".sqlite", cacheDir)
                try {
                    val totalBytes = contentResolver.openAssetFileDescriptor(uri, "r")?.use { afd ->
                        afd.length.takeIf { it > 0L }
                    } ?: -1L
                    BufferedInputStream(open(uri)).use { source ->
                        inputFile.outputStream().buffered().use { target ->
                            if (key == null) source.copyTo(target)
                            else DatabaseDecryptor.decrypt(source, target, key, totalBytes)
                        }
                    }
                    PanelSyncManager.normalizeSqliteHeader(inputFile)
                    PanelSyncManager.clearSourceDbSignature(applicationContext)
                    val offsetMinutes = TimeZone.getDefault().getOffset(System.currentTimeMillis()) / 60000
                    panelPython(applicationContext).callAttr(
                        "import_snapshot",
                        inputFile.path,
                        database.path,
                        offsetMinutes,
                        "手动导入",
                        "",
                        false,
                    )
                } finally {
                    inputFile.delete()
                }
            }
            key?.fill(0)
            runOnUiThread {
                if (isDestroyed || isFinishing) return@runOnUiThread
                progressDialog?.dismiss()
                progressDialog = null
                inProgress = false
                result.onSuccess {
                    PanelSyncManager.notifyExternalUpdate(applicationContext, "已导入本地健康数据库")
                    if (::backCallback.isInitialized) backCallback.isEnabled = false
                    web.loadUrl(panelHome)
                    notifyUser("已更新离线面板")
                }.onFailure {
                    notifyUser(if (it is ImportError) it.message.orEmpty() else "无法导入，请确认文件是完整的数据库快照")
                }
            }
        }
    }

    private fun exportRoute(uri: Uri) {
        if (pendingExport != null) return
        worker.execute {
            val result = runCatching { api(uri.path.orEmpty(), uri.encodedQuery.orEmpty()) }.getOrNull()
            runOnUiThread {
                if (isDestroyed || isFinishing || pendingExport != null) return@runOnUiThread
                if (result == null || result.getInt(0) != 200) notifyUser("这条训练暂无可导出的路线")
                else {
                    pendingExport = uri.encodedQuery.orEmpty()
                    exporter.launch(result.getString(2).takeIf { it.endsWith(".gpx") } ?: "route.gpx")
                }
            }
        }
    }

    private fun open(uri: Uri): InputStream =
        contentResolver.openInputStream(uri) ?: throw ImportError("无法打开数据库文件")

    private fun api(path: String, query: String) =
        JSONArray(panelPython(applicationContext).callAttr("request", database.path, path, query).toString())

    private fun notifyUser(message: String) = runOnUiThread {
        if (!isDestroyed && !isFinishing) Toast.makeText(this, message, Toast.LENGTH_LONG).show()
    }

    @Suppress("DEPRECATION")
    private fun currentAppVersionCode(): Long =
        runCatching { packageManager.getPackageInfo(packageName, 0).longVersionCode }.getOrDefault(-1L)

    private fun clearCacheIfAppUpgraded(target: WebView) {
        val prefs = getSharedPreferences("panel_prefs", Context.MODE_PRIVATE)
        val currentVersion = currentAppVersionCode()
        if (currentVersion > 0L && prefs.getLong("last_asset_version", -1L) != currentVersion) {
            target.clearCache(true)
            prefs.edit().putLong("last_asset_version", currentVersion).apply()
        }
    }
}

internal object MapTilePolicy {
    private val autonaviHost = Regex("""web(?:rd|st)0[1-4]\.is\.autonavi\.com""")

    fun isAllowed(scheme: String?, host: String?, port: Int = -1): Boolean {
        if (!scheme.equals("https", ignoreCase = true)) return false
        if (port != -1 && port != 443) return false
        val normalized = host?.lowercase() ?: return false
        return autonaviHost.matches(normalized)
    }
}

internal object NativeBackBridge {
    const val BACK_PRESS_JS = "window.__onNativeBackPress && window.__onNativeBackPress()"
    const val SYNC_STATE_JS = "window.__syncNativeBackState && window.__syncNativeBackState(true)"
    val NO_CACHE_HEADERS = mapOf(
        "Cache-Control" to "no-store, no-cache, must-revalidate",
        "Pragma" to "no-cache",
    )
}

private fun Uri.localPanel(): Boolean = scheme == "https" && host == panelHost && (port == -1 || port == 443)

private fun Uri.allowedMapTile(): Boolean = MapTilePolicy.isAllowed(scheme, host, port)

private fun response(code: Int, mime: String, body: String): WebResourceResponse {
    val reason = when (code) {
        200 -> "OK"
        400 -> "Bad Request"
        403 -> "Forbidden"
        404 -> "Not Found"
        else -> "Internal Server Error"
    }
    return WebResourceResponse(
        mime,
        "UTF-8",
        code,
        reason,
        NativeBackBridge.NO_CACHE_HEADERS,
        body.byteInputStream(Charsets.UTF_8),
    )
}
