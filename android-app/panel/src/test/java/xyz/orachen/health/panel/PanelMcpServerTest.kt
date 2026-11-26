package xyz.orachen.health.panel

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.HttpURLConnection
import java.net.URL
import java.net.Socket

class PanelMcpServerTest {
    @Test fun loopbackRequiresTokenAndExposesOnlyReadOperations() {
        val requestedTools = mutableListOf<String>()
        val protocol = PanelMcpProtocol { tool, _ ->
            requestedTools += tool
            """{"sample":true}"""
        }
        PanelMcpServer("127.0.0.1", 0, "test-token", protocol).use { server ->
            server.start()
            fun request(
                body: String,
                token: String? = "test-token",
                accept: String = "application/json, text/event-stream",
            ): Pair<Int, String> {
                val connection = URL("http://127.0.0.1:${server.localPort}/mcp").openConnection() as HttpURLConnection
                connection.connectTimeout = 2000
                connection.readTimeout = 2000
                connection.requestMethod = "POST"
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json")
                connection.setRequestProperty("Accept", accept)
                token?.let { connection.setRequestProperty("Authorization", "Bearer $it") }
                val bytes = body.toByteArray()
                connection.setFixedLengthStreamingMode(bytes.size)
                try {
                    connection.outputStream.use { it.write(bytes) }
                    val status = connection.responseCode
                    val input = if (status < 400) connection.inputStream else connection.errorStream
                    return status to (input?.bufferedReader()?.use { it.readText() } ?: "")
                } finally {
                    connection.disconnect()
                }
            }

            val init = """{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25"}}"""
            assertEquals(401, request(init, null).first)
            assertEquals(401, request(init, "wrong").first)
            Socket("127.0.0.1", server.localPort).use { socket ->
                socket.soTimeout = 2000
                val wire = "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:${server.localPort}\r\n" +
                    "Origin: https://example.invalid\r\nAuthorization: Bearer test-token\r\n" +
                    "Content-Type: application/json\r\nContent-Length: ${init.length}\r\n\r\n$init"
                socket.getOutputStream().write(wire.toByteArray(Charsets.US_ASCII))
                assertTrue(socket.getInputStream().bufferedReader().readLine().startsWith("HTTP/1.1 403"))
            }
            val initialized = JSONObject(request(init).second).getJSONObject("result")
            assertEquals("2025-11-25", initialized.getString("protocolVersion"))
            assertEquals(202, request("""{"jsonrpc":"2.0","method":"notifications/initialized"}""").first)

            val listed = JSONObject(request("""{"jsonrpc":"2.0","id":2,"method":"tools/list"}""").second)
                .getJSONObject("result").getJSONArray("tools")
            assertEquals(9, listed.length())
            repeat(listed.length()) {
                assertTrue(listed.getJSONObject(it).getJSONObject("annotations").getBoolean("readOnlyHint"))
            }
            val forbidden = request("""{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_sqlcipher_key"}}""")
            assertEquals(-32602, JSONObject(forbidden.second).getJSONObject("error").getInt("code"))
            assertTrue(requestedTools.isEmpty())

            val response = request(
                """{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"list_workouts"}}""",
                accept = "text/event-stream",
            )
            assertEquals(200, response.first)
            assertTrue(response.second.startsWith("event: message\ndata: "))
            assertFalse(response.second.contains("test-token"))
            assertEquals(listOf("list_workouts"), requestedTools)
        }
    }
}
