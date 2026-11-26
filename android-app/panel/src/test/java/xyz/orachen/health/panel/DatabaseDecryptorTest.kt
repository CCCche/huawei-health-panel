package xyz.orachen.health.panel

import java.io.ByteArrayOutputStream
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec
import org.junit.Assert.*
import org.junit.Test

class DatabaseDecryptorTest {
    private val key = ByteArray(32) { it.toByte() }
    private val header = "SQLite format 3\u0000".toByteArray(Charsets.US_ASCII)

    @Test fun decryptsTwoVerifiedPages() {
        val (input, expected) = fixture()
        val output = ByteArrayOutputStream()
        DatabaseDecryptor.decrypt(input.inputStream(), output, key)
        assertArrayEquals(expected, output.toByteArray())
        assertTrue(DatabaseDecryptor.isPlain(output.toByteArray().copyOfRange(0, 16)))
    }

    @Test fun reportsProgressAcrossMultiplePages() {
        val (input, expected) = fixture(pageCount = 260)
        val output = ByteArrayOutputStream()
        val updates = mutableListOf<Pair<Int, Int>>()
        DatabaseDecryptor.decrypt(input.inputStream(), output, key, totalBytes = input.size.toLong()) { done, total ->
            updates += done to total
        }
        assertArrayEquals(expected, output.toByteArray())
        assertTrue(updates.isNotEmpty())
        assertEquals(260 to 260, updates.last())
        assertTrue(updates.any { it.first == 1 })
        assertTrue(updates.any { it.first == 256 })
    }

    @Test fun rejectsWrongKeyAndTamperedSecondPage() {
        val (input, _) = fixture()
        assertThrows(ImportError::class.java) {
            DatabaseDecryptor.decrypt(input.inputStream(), ByteArrayOutputStream(), ByteArray(32))
        }
        input[4100] = (input[4100].toInt() xor 1).toByte()
        val error = assertThrows(ImportError::class.java) {
            DatabaseDecryptor.decrypt(input.inputStream(), ByteArrayOutputStream(), key)
        }
        assertTrue(error.message!!.contains("第 2 页"))
    }

    @Test fun rejectsTruncation() {
        val (input, _) = fixture()
        assertThrows(ImportError::class.java) {
            DatabaseDecryptor.decrypt(input.copyOf(input.size - 1).inputStream(), ByteArrayOutputStream(), key)
        }
    }

    private fun fixture(pageCount: Int = 2): Pair<ByteArray, ByteArray> {
        val tagKey = DatabaseDecryptor.rawKey("601364baed0dde5a2d291ede302ae7e0540a85b57a281a0d19c344b7d4f382ce")
        val input = ByteArrayOutputStream()
        val expected = ByteArrayOutputStream()
        for (page in 1..pageCount) {
            val prefix = if (page == 1) ByteArray(16) { it.toByte() } else ByteArray(0)
            val plain = ByteArray(4016 - prefix.size) { (it * 3 + page).toByte() }
            val iv = ByteArray(16) { (page * 11 + it).toByte() }
            val cipher = Cipher.getInstance("AES/CBC/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), IvParameterSpec(iv))
            val content = cipher.doFinal(plain) + iv
            val hmac = Mac.getInstance("HmacSHA512")
            hmac.init(SecretKeySpec(tagKey, "HmacSHA512"))
            val tag = hmac.doFinal(content + byteArrayOf((page and 0xff).toByte(), ((page ushr 8) and 0xff).toByte(), 0, 0))
            input.write(prefix + content + tag)
            if (page == 1) expected.write(header)
            expected.write(plain + ByteArray(80))
        }
        return input.toByteArray() to expected.toByteArray()
    }
}
