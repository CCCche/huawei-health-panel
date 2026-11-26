package xyz.orachen.health.panel

import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.PersistableBundle
import java.io.File
import java.io.IOException
import java.time.LocalDate
import java.time.format.DateTimeFormatter

internal fun copySensitive(context: Context, label: String, text: String) {
    val clip = ClipData.newPlainText(label, text)
    clip.description.extras = PersistableBundle().apply {
        putBoolean(
            if (Build.VERSION.SDK_INT >= 33) ClipDescription.EXTRA_IS_SENSITIVE
            else "android.content.extra.IS_SENSITIVE",
            true,
        )
    }
    context.getSystemService(ClipboardManager::class.java).setPrimaryClip(clip)
}

internal enum class PanelExport(val label: String, val prefix: String, val extension: String) {
    DECRYPTED("导出已解密全量数据库", "hihealth_003_decrypted", "sqlite"),
    ENCRYPTED("导出原始数据库快照", "hihealth_003", "db"),
    PANEL("导出面板数据库", "panel", "sqlite"),
    KEY("导出 SQLCipher 密钥文件", "hihealth_sqlcipher_key", "txt");

    fun filename() = "${prefix}_${LocalDate.now().format(DateTimeFormatter.BASIC_ISO_DATE)}.$extension"

    fun write(context: Context, uri: Uri) {
        if (this == KEY) {
            val hex = resolveKey(context)
            val instructions = "PRAGMA key = \"x'$hex'\";\nPRAGMA cipher_compatibility = 4;\n"
            (context.contentResolver.openOutputStream(uri, "wt") ?: throw IOException()).use {
                it.write(instructions.toByteArray(Charsets.UTF_8))
            }
            return
        }
        withTemp(context) { file ->
            when (this) {
                PANEL -> panelPython(context).callAttr(
                    "export_panel_database", File(context.noBackupFilesDir, "panel.sqlite").path, file.path,
                )
                ENCRYPTED -> HuaweiHealthSync.copySourceSnapshot(context, file)
                DECRYPTED -> writeDecrypted(context, file)
                KEY -> error("Key export is handled separately")
            }
            (context.contentResolver.openOutputStream(uri, "wt") ?: throw IOException()).use { output ->
                file.inputStream().use { it.copyTo(output) }
            }
        }
    }

    companion object {
        private fun <T> withTemp(context: Context, block: (File) -> T): T {
            val file = File.createTempFile("panel-export-", ".sqlite", context.cacheDir)
            return try { block(file) } finally { file.delete() }
        }

        fun resolveKey(context: Context): String {
            val cache = KeyCache(context)
            return cache.loadHex() ?: withTemp(context) { snapshot ->
                val result = HuaweiHealthSync.snapshotAndResolveKey(context, snapshot, null, false) {}
                val key = result.effectiveKeyHex ?: throw SyncError("当前数据库没有可导出的密钥")
                cache.saveHex(key)
                key
            }
        }

        private fun writeDecrypted(context: Context, output: File) = withTemp(context) { snapshot ->
            val cache = KeyCache(context)
            val result = HuaweiHealthSync.snapshotAndResolveKey(context, snapshot, cache.loadHex(), false) {}
            snapshot.inputStream().buffered().use { source ->
                output.outputStream().buffered().use { target ->
                    if (result.isPlain) {
                        source.copyTo(target)
                    } else {
                        val raw = DatabaseDecryptor.rawKey(result.effectiveKeyHex.orEmpty())
                        try {
                            DatabaseDecryptor.decrypt(source, target, raw)
                        } finally {
                            raw.fill(0)
                        }
                    }
                }
            }
            PanelSyncManager.normalizeSqliteHeader(output)
            panelPython(context).callAttr("verify_exported_sqlite", output.path)
            if (result.recoveredNewKey) result.effectiveKeyHex?.let(cache::saveHex)
        }
    }
}
