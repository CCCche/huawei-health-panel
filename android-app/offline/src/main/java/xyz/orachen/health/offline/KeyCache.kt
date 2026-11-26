package xyz.orachen.health.offline

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

internal class KeyCache(context: Context) {
    private val file = AtomicFile(File(context.noBackupFilesDir, "auto-key.bin"))

    @Synchronized
    fun hasKey(): Boolean = file.baseFile.exists() && loadHex() != null

    @Synchronized
    fun loadHex(): String? = runCatching {
        if (!file.baseFile.exists()) return null
        val blob = file.readFully()
        if (blob.size < 3 || blob[0] != VERSION) return null
        val ivLen = blob[1].toInt() and 0xFF
        if (ivLen < 8 || blob.size <= 2 + ivLen) return null
        val iv = blob.copyOfRange(2, 2 + ivLen)
        val ciphertext = blob.copyOfRange(2 + ivLen, blob.size)
        val key = existingSecretKey() ?: return null
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(GCM_TAG_BITS, iv))
        val raw = cipher.doFinal(ciphertext)
        try {
            if (raw.size != 32) return null
            raw.joinToString("") { "%02x".format(it) }
        } finally {
            raw.fill(0)
        }
    }.getOrNull()

    @Synchronized
    fun saveHex(hex: String) {
        val raw = DatabaseDecryptor.rawKey(hex)
        try {
            runCatching {
                val key = getOrCreateSecretKey()
                val cipher = Cipher.getInstance(TRANSFORMATION)
                cipher.init(Cipher.ENCRYPT_MODE, key)
                val iv = cipher.iv
                val encrypted = cipher.doFinal(raw)
                val blob = ByteArray(2 + iv.size + encrypted.size)
                blob[0] = VERSION
                blob[1] = iv.size.toByte()
                System.arraycopy(iv, 0, blob, 2, iv.size)
                System.arraycopy(encrypted, 0, blob, 2 + iv.size, encrypted.size)
                val stream = file.startWrite()
                try {
                    stream.write(blob)
                    file.finishWrite(stream)
                } catch (t: Throwable) {
                    file.failWrite(stream)
                    throw t
                } finally {
                    blob.fill(0)
                    encrypted.fill(0)
                }
            }
        } finally {
            raw.fill(0)
        }
    }

    @Synchronized
    fun clear() {
        file.delete()
        runCatching {
            val ks = KeyStore.getInstance(KEYSTORE_PROVIDER).apply { load(null) }
            if (ks.containsAlias(KEY_ALIAS)) {
                ks.deleteEntry(KEY_ALIAS)
            }
        }
    }

    private fun existingSecretKey(): SecretKey? {
        val ks = KeyStore.getInstance(KEYSTORE_PROVIDER).apply { load(null) }
        return (ks.getEntry(KEY_ALIAS, null) as? KeyStore.SecretKeyEntry)?.secretKey
    }

    private fun getOrCreateSecretKey(): SecretKey {
        existingSecretKey()?.let { return it }
        val spec = KeyGenParameterSpec.Builder(
            KEY_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .build()
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE_PROVIDER).run {
            init(spec)
            generateKey()
        }
    }

    private companion object {
        const val VERSION: Byte = 1
        const val KEYSTORE_PROVIDER = "AndroidKeyStore"
        const val KEY_ALIAS = "xyz.orachen.health.offline.dbkey"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val GCM_TAG_BITS = 128
    }
}
