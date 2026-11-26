package xyz.orachen.health.offline

import org.junit.Assert.*
import org.junit.Test

class HuaweiHealthSyncTest {
    @Test fun parsesPlainDbResult() {
        val result = HelperProtocol.parseLines(
            listOf("HEALTH_ROOT_OK", "STATUS:COPY_DONE:409600", "RESULT:PLAIN"),
            exitCode = 0,
        )
        assertTrue(result.isPlain)
        assertFalse(result.usedCachedKey)
        assertNull(result.recoveredKeyHex)
        assertEquals(409600L, result.copiedBytes)
    }

    @Test fun parsesCachedKeyOkResult() {
        val result = HelperProtocol.parseLines(
            listOf("HEALTH_ROOT_OK", "STATUS:DB_META:1732500000:12345:819200", "STATUS:COPY_DONE:819200", "RESULT:CACHED_OK"),
            exitCode = 0,
        )
        assertFalse(result.isPlain)
        assertFalse(result.unchanged)
        assertTrue(result.usedCachedKey)
        assertNull(result.recoveredKeyHex)
        assertEquals(819200L, result.copiedBytes)
        assertEquals("1732500000:12345:819200", result.dbMeta)
    }

    @Test fun parsesUnchangedFastSkipResult() {
        val result = HelperProtocol.parseLines(
            listOf("HEALTH_ROOT_OK", "STATUS:DB_META:1732500000:12345:819200", "RESULT:UNCHANGED"),
            exitCode = 0,
        )
        assertTrue(result.unchanged)
        assertFalse(result.isPlain)
        assertFalse(result.usedCachedKey)
        assertNull(result.recoveredKeyHex)
        assertNull(result.copiedBytes)
        assertEquals("1732500000:12345:819200", result.dbMeta)
    }

    @Test fun parsesRecoveredKeyResultAndNormalizesLowercase() {
        val hexUpper = "0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF"
        val result = HelperProtocol.parseLines(
            listOf(
                "HEALTH_ROOT_OK",
                "STATUS:DB_META:1732500001:999:1048576",
                "STATUS:COPY_DONE:1048576",
                "STATUS:CACHED_KEY_INVALID",
                "STATUS:RECOVERING_KEY",
                "RESULT:KEY:$hexUpper",
            ),
            exitCode = 0,
        )
        assertFalse(result.isPlain)
        assertFalse(result.unchanged)
        assertFalse(result.usedCachedKey)
        assertEquals(hexUpper.lowercase(), result.recoveredKeyHex)
        assertEquals(1048576L, result.copiedBytes)
        assertEquals("1732500001:999:1048576", result.dbMeta)
    }

    @Test fun rejectsMalformedRecoveredKey() {
        val error = assertThrows(SyncError::class.java) {
            HelperProtocol.parseLines(
                listOf("HEALTH_ROOT_OK", "RESULT:KEY:not-a-valid-hex-key"),
                exitCode = 0,
            )
        }
        assertTrue(error.message!!.contains("无效结果"))
    }

    @Test fun mapsRootDeniedAndMissingHelperErrors() {
        val denied = assertThrows(SyncError::class.java) {
            HelperProtocol.parseLines(emptyList(), exitCode = 77)
        }
        assertTrue(denied.message!!.contains("Root"))
        assertFalse(denied.needsHuaweiHealth)

        val noRootOk = assertThrows(SyncError::class.java) {
            HelperProtocol.parseLines(emptyList(), exitCode = 1)
        }
        assertTrue(noRootOk.message!!.contains("Root"))

        val missingHelper = assertThrows(SyncError::class.java) {
            HelperProtocol.parseLines(listOf("HEALTH_ROOT_OK"), exitCode = 78)
        }
        assertTrue(missingHelper.message!!.contains("组件"))
    }

    @Test fun mapsDaemonAndMemoryErrorsWithHuaweiHealthHint() {
        for (code in listOf("NO_DAEMON", "NO_LIBSQLCIPHER", "NO_SALT", "NO_CTX", "UNMASK_FAILED")) {
            val err = assertThrows(SyncError::class.java) {
                HelperProtocol.parseLines(
                    listOf("HEALTH_ROOT_OK", "STATUS:COPY_DONE:4096", "ERR:$code"),
                    exitCode = 14,
                )
            }
            assertTrue("Expected needsHuaweiHealth for $code", err.needsHuaweiHealth)
        }

        val dbMissing = assertThrows(SyncError::class.java) {
            HelperProtocol.parseLines(listOf("HEALTH_ROOT_OK", "ERR:DB_NOT_FOUND"), exitCode = 10)
        }
        assertFalse(dbMissing.needsHuaweiHealth)
        assertTrue(dbMissing.message!!.contains("未找到"))

        val memDenied = assertThrows(SyncError::class.java) {
            HelperProtocol.parseLines(
                listOf("HEALTH_ROOT_OK", "STATUS:COPY_DONE:4096", "ERR:MEM_NO_ACCESS"),
                exitCode = 20,
                stderr = "open /proc/123/mem failed: Permission denied",
            )
        }
        assertFalse(memDenied.needsHuaweiHealth)
        assertTrue(memDenied.message!!.contains("进程内存"))
        assertTrue(memDenied.message!!.contains("Permission denied"))

        val dstFailed = assertThrows(SyncError::class.java) {
            HelperProtocol.parseLines(
                listOf("HEALTH_ROOT_OK", "ERR:DST_OPEN_FAILED"),
                exitCode = 21,
                stderr = "open dst failed: Permission denied",
            )
        }
        assertTrue(dstFailed.message!!.contains("快照文件"))
        assertTrue(dstFailed.message!!.contains("Permission denied"))

        val unexpectedExit = assertThrows(SyncError::class.java) {
            HelperProtocol.parseLines(
                listOf("HEALTH_ROOT_OK"),
                exitCode = 2,
                stderr = "Unknown option: --bad",
            )
        }
        assertTrue(unexpectedExit.message!!.contains("Unknown option: --bad"))
    }

    @Test fun handlesTimeoutAndShellQuoting() {
        val timedOut = assertThrows(SyncError::class.java) {
            HelperProtocol.parseLines(listOf("HEALTH_ROOT_OK"), exitCode = -1, timedOut = true)
        }
        assertTrue(timedOut.message!!.contains("超时"))

        assertEquals("'/a/b c/d'\"'\"'e'", HelperProtocol.shellQuote("/a/b c/d'e"))
    }
}
