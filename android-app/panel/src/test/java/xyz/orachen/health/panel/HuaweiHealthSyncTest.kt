package xyz.orachen.health.panel

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

    @Test fun mapsErrorsWithHuaweiHealthHintAndStderr() {
        val denied = assertThrows(SyncError::class.java) {
            HelperProtocol.parseLines(emptyList(), exitCode = 77)
        }
        assertTrue(denied.message!!.contains("Root"))
        assertFalse(denied.needsHuaweiHealth)

        for (code in listOf("NO_DAEMON", "NO_LIBSQLCIPHER", "NO_SALT", "NO_CTX", "UNMASK_FAILED")) {
            val err = assertThrows(SyncError::class.java) {
                HelperProtocol.parseLines(
                    listOf("HEALTH_ROOT_OK", "STATUS:COPY_DONE:4096", "ERR:$code"),
                    exitCode = 14,
                )
            }
            assertTrue("Expected needsHuaweiHealth for $code", err.needsHuaweiHealth)
        }

        val memDenied = assertThrows(SyncError::class.java) {
            HelperProtocol.parseLines(
                listOf("HEALTH_ROOT_OK", "STATUS:COPY_DONE:4096", "ERR:MEM_NO_ACCESS"),
                exitCode = 20,
                stderr = "open /proc/123/mem failed: Permission denied",
            )
        }
        assertTrue(memDenied.message!!.contains("Permission denied"))
    }

    @Test fun handlesTimeoutAndShellQuoting() {
        val timedOut = assertThrows(SyncError::class.java) {
            HelperProtocol.parseLines(listOf("HEALTH_ROOT_OK"), exitCode = -1, timedOut = true)
        }
        assertTrue(timedOut.message!!.contains("超时"))
        assertEquals("'/a/b c/d'\"'\"'e'", HelperProtocol.shellQuote("/a/b c/d'e"))
    }

    @Test fun syncStateTracksPullResultAndEventSequence() {
        val defaults = PanelSyncManager.SyncState()
        assertNull(defaults.syncResult)
        assertEquals(0, defaults.eventSeq)

        val completed = defaults.copy(
            busy = false,
            message = "已是最新健康数据",
            shortLabel = "已是最新",
            syncResult = "unchanged",
            eventSeq = 4,
        )
        assertEquals("unchanged", completed.syncResult)
        assertEquals(4, completed.eventSeq)
        assertEquals("已是最新健康数据", completed.message)
        assertEquals(3, PanelSyncManager.SyncTrigger.entries.size)
    }

    @Test fun allowsOnlyExpectedHttpsMapTileHosts() {
        for (sub in listOf("1", "2", "3", "4")) {
            assertTrue(MapTilePolicy.isAllowed("https", "webrd0$sub.is.autonavi.com"))
            assertTrue(MapTilePolicy.isAllowed("https", "webst0$sub.is.autonavi.com"))
        }
        assertTrue(MapTilePolicy.isAllowed("HTTPS", "Server.ArcGISOnline.com", 443))

        assertFalse(MapTilePolicy.isAllowed("http", "webrd01.is.autonavi.com"))
        assertFalse(MapTilePolicy.isAllowed("https", "webrd01.is.autonavi.com", 8443))
        assertFalse(MapTilePolicy.isAllowed("https", "webrd05.is.autonavi.com"))
        assertFalse(MapTilePolicy.isAllowed("https", "webrd01.is.autonavi.com.evil.example"))
        assertFalse(MapTilePolicy.isAllowed("https", "health.example.com"))
        assertFalse(MapTilePolicy.isAllowed("https", null))
    }

    @Test fun nativeBackBridgeExposesExpectedJsHooks() {
        assertEquals(
            "window.__onNativeBackPress && window.__onNativeBackPress()",
            NativeBackBridge.BACK_PRESS_JS,
        )
        assertEquals(
            "window.__syncNativeBackState && window.__syncNativeBackState(true)",
            NativeBackBridge.SYNC_STATE_JS,
        )
        assertEquals(
            "no-store, no-cache, must-revalidate",
            NativeBackBridge.NO_CACHE_HEADERS["Cache-Control"],
        )
        assertEquals(
            "no-cache",
            NativeBackBridge.NO_CACHE_HEADERS["Pragma"],
        )
    }
}
