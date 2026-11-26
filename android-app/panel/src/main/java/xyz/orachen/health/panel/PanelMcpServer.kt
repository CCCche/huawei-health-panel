package xyz.orachen.health.panel

import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.Closeable
import java.io.IOException
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.SynchronousQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit

internal class PanelMcpServer(
    host: String,
    port: Int,
    token: String,
    private val protocol: PanelMcpProtocol,
) : Closeable {
    private val expectedAuth = "Bearer $token".toByteArray(Charsets.UTF_8)
    private val listener = ServerSocket().apply {
        try {
            reuseAddress = true
            bind(InetSocketAddress(host, port), 16)
        } catch (error: IOException) {
            close()
            throw error
        }
    }
    private val clients = ConcurrentHashMap.newKeySet<Socket>()
    private val pool = ThreadPoolExecutor(0, 4, 30, TimeUnit.SECONDS, SynchronousQueue())

    val localPort: Int get() = listener.localPort

    fun start() {
        Thread({
            while (!listener.isClosed) {
                val socket = try { listener.accept() } catch (_: IOException) { break }
                clients.add(socket)
                try {
                    pool.execute {
                        try {
                            socket.use(::handle)
                        } catch (_: IOException) {
                            // A disconnected or timed-out client has no response channel.
                        } finally {
                            clients.remove(socket)
                        }
                    }
                } catch (_: RejectedExecutionException) {
                    clients.remove(socket)
                    socket.close()
                }
            }
        }, "health-mcp-listener").start()
    }

    private fun handle(socket: Socket) {
        socket.soTimeout = 5_000
        val input = socket.getInputStream().buffered()
        val request = try { readHead(input) } catch (_: IllegalArgumentException) {
            write(socket, 400)
            return
        } ?: return
        val (method, path, headers) = request
        if (path != "/mcp") return write(socket, 404)
        if ("origin" in headers) return write(socket, 403)
        val expectedHost = socket.localAddress.hostAddress.orEmpty()
        val allowedHosts = setOf("localhost", "127.0.0.1", expectedHost).map { "$it:${socket.localPort}" }
        if (headers["host"]?.lowercase(Locale.ROOT) !in allowedHosts) return write(socket, 403)
        if (!MessageDigest.isEqual(expectedAuth, headers["authorization"].orEmpty().toByteArray(Charsets.UTF_8))) {
            return write(socket, 401, extra = "WWW-Authenticate: Bearer\r\n")
        }
        if (method != "POST") return write(socket, 405, extra = "Allow: POST\r\n")
        val version = headers["mcp-protocol-version"]
        if (version != null && !protocol.supportsVersion(version)) return write(socket, 400)
        if (headers["content-type"]?.substringBefore(';')?.trim()?.lowercase(Locale.ROOT) != "application/json") {
            return write(socket, 415)
        }
        if ("transfer-encoding" in headers) return write(socket, 400)
        val size = headers["content-length"]?.toIntOrNull() ?: return write(socket, 411)
        if (size !in 1..65_536) return write(socket, 413)
        val body = ByteArray(size)
        var offset = 0
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
        while (offset < body.size) {
            if (System.nanoTime() > deadline) return write(socket, 400)
            val read = input.read(body, offset, body.size - offset)
            if (read < 0) return write(socket, 400)
            offset += read
        }
        val reply = protocol.handle(String(body, Charsets.UTF_8))
        val accept = headers["accept"].orEmpty()
        val sse = reply.status == 200 && !accept.contains("application/json") && accept.contains("text/event-stream")
        if (sse) write(socket, reply.status, "event: message\ndata: ${reply.body}\n\n", "text/event-stream")
        else write(socket, reply.status, reply.body)
    }

    private data class Request(val method: String, val path: String, val headers: Map<String, String>)

    private fun readHead(input: BufferedInputStream): Request? {
        var remaining = 12_288
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
        fun line(): String? {
            val buffer = ByteArrayOutputStream()
            while (remaining-- > 0) {
                if (System.nanoTime() > deadline) throw IOException("HTTP header timeout")
                val byte = input.read()
                if (byte == -1) return null
                if (byte == 10) return buffer.toString(StandardCharsets.US_ASCII.name()).removeSuffix("\r")
                buffer.write(byte)
            }
            throw IllegalArgumentException("HTTP headers too large")
        }
        val first = line()?.split(' ') ?: return null
        require(first.size == 3 && first[2] in setOf("HTTP/1.0", "HTTP/1.1"))
        val headers = mutableMapOf<String, String>()
        while (true) {
            val header = line() ?: throw IllegalArgumentException("Incomplete HTTP headers")
            if (header.isEmpty()) return Request(first[0], first[1], headers)
            val split = header.indexOf(':')
            require(split > 0)
            val name = header.substring(0, split).lowercase(Locale.ROOT)
            require(headers.put(name, header.substring(split + 1).trim()) == null)
        }
    }

    private fun write(socket: Socket, status: Int, body: String = "", type: String = "application/json", extra: String = "") {
        val reason = when (status) {
            200 -> "OK"
            202 -> "Accepted"
            400 -> "Bad Request"
            401 -> "Unauthorized"
            403 -> "Forbidden"
            404 -> "Not Found"
            405 -> "Method Not Allowed"
            411 -> "Length Required"
            413 -> "Content Too Large"
            415 -> "Unsupported Media Type"
            else -> "Error"
        }
        val bytes = body.toByteArray(Charsets.UTF_8)
        socket.getOutputStream().buffered().use {
            it.write(("HTTP/1.1 $status $reason\r\nContent-Type: $type; charset=utf-8\r\n" +
                "Content-Length: ${bytes.size}\r\nConnection: close\r\nCache-Control: no-store\r\n$extra\r\n")
                .toByteArray(Charsets.US_ASCII))
            it.write(bytes)
        }
    }

    override fun close() {
        runCatching { listener.close() }
        pool.shutdownNow()
        clients.forEach { runCatching { it.close() } }
        expectedAuth.fill(0)
    }
}
