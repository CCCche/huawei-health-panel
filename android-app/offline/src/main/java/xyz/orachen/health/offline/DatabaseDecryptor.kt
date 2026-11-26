package xyz.orachen.health.offline

import java.io.InputStream
import java.io.OutputStream
import java.security.MessageDigest
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec

internal object DatabaseDecryptor {
    private const val pageSize = 4096
    private const val saltSize = 16
    private const val ivSize = 16
    private const val macSize = 64
    private const val dataEnd = pageSize - ivSize - macSize
    private val sqliteHeader = "SQLite format 3\u0000".toByteArray(Charsets.US_ASCII)

    fun isPlain(header: ByteArray): Boolean = header.contentEquals(sqliteHeader)

    fun rawKey(hex: String): ByteArray {
        val key = hex.trim()
        require(key.length == 64 && key.all { it in "0123456789abcdefABCDEF" }) {
            "请输入 64 位十六进制数据库密钥"
        }
        return ByteArray(32) { key.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
    }

    fun decrypt(input: InputStream, output: OutputStream, key: ByteArray) {
        decrypt(input, output, key, totalBytes = -1L, onProgress = null)
    }

    fun decrypt(
        input: InputStream,
        output: OutputStream,
        key: ByteArray,
        totalBytes: Long = -1L,
        onProgress: ((pagesDone: Int, totalPages: Int) -> Unit)? = null,
    ) {
        require(key.size == 32)
        val page = ByteArray(pageSize)
        if (readBlock(input, page) != pageSize) throw ImportError("数据库文件不完整")

        val totalPages = if (totalBytes > 0L) (totalBytes / pageSize).toInt() else 0
        val salt = ByteArray(saltSize) { (page[it].toInt() xor 0x3a).toByte() }
        val macKey = deriveMacKey(key, salt)
        // Android Conscrypt's EVP_CIPHER requires output buffer >= inputLen + blockSize (4016 + 16 = 4032).
        var plain = ByteArray(pageSize + 64)
        val expected = ByteArray(macSize)
        try {
            val mac = Mac.getInstance("HmacSHA512").apply { init(SecretKeySpec(macKey, "HmacSHA512")) }
            val cipher = Cipher.getInstance("AES/CBC/NoPadding")
            val cipherKey = SecretKeySpec(key, "AES")
            val reserve = ByteArray(pageSize - dataEnd)
            var number = 1
            while (true) {
                val start = if (number == 1) saltSize else 0
                mac.update(page, start, pageSize - macSize - start)
                repeat(4) { shift -> mac.update((number ushr (shift * 8)).toByte()) }
                System.arraycopy(page, pageSize - macSize, expected, 0, macSize)
                if (!MessageDigest.isEqual(mac.doFinal(), expected)) {
                    throw ImportError(if (number == 1) "密钥不正确，或数据库格式不受支持" else "数据库第 ${number} 页校验失败")
                }
                val chunkLen = dataEnd - start
                cipher.init(Cipher.DECRYPT_MODE, cipherKey, IvParameterSpec(page, dataEnd, ivSize))
                val minOut = cipher.getOutputSize(chunkLen)
                if (plain.size < minOut) {
                    plain.fill(0)
                    plain = ByteArray(minOut)
                }
                val decryptedLen = cipher.doFinal(page, start, chunkLen, plain, 0)
                if (decryptedLen != chunkLen) {
                    throw ImportError("数据库第 ${number} 页解密长度异常")
                }
                if (number == 1) output.write(sqliteHeader)
                output.write(plain, 0, decryptedLen)
                output.write(reserve)
                if (onProgress != null && (number == 1 || number % 256 == 0)) {
                    onProgress(number, maxOf(totalPages, number))
                }
                val read = readBlock(input, page)
                if (read == 0) break
                if (read != pageSize) throw ImportError("数据库最后一页不完整")
                number++
            }
            onProgress?.invoke(number, maxOf(totalPages, number))
        } finally {
            macKey.fill(0)
            page.fill(0)
            plain.fill(0)
            expected.fill(0)
        }
    }

    // SQLCipher derives the page authentication key using PBKDF2-HMAC-SHA512 with two rounds.
    private fun deriveMacKey(key: ByteArray, salt: ByteArray): ByteArray {
        val hmac = Mac.getInstance("HmacSHA512").apply { init(SecretKeySpec(key, "HmacSHA512")) }
        val first = hmac.doFinal(salt + byteArrayOf(0, 0, 0, 1))
        val second = hmac.doFinal(first)
        return ByteArray(32) { (first[it].toInt() xor second[it].toInt()).toByte() }.also {
            first.fill(0)
            second.fill(0)
        }
    }
}

internal fun readBlock(input: InputStream, bytes: ByteArray): Int {
    var offset = 0
    while (offset < bytes.size) {
        val count = input.read(bytes, offset, bytes.size - offset)
        if (count < 0) break
        if (count == 0) {
            val next = input.read()
            if (next < 0) break
            bytes[offset++] = next.toByte()
        } else {
            offset += count
        }
    }
    return offset
}

internal class ImportError(message: String) : Exception(message)
