package xyz.orachen.health.panel

import org.json.JSONArray
import org.json.JSONObject

internal class PanelMcpProtocol(private val read: (String, JSONObject) -> String) {
    data class Reply(val status: Int, val body: String = "")

    private val supportedVersions = setOf("2025-11-25", "2025-06-18", "2025-03-26")
    private val overviewUri = "health://overview"
    private val tools = JSONArray(
        """
        [
          {"name":"get_health_overview","description":"近期健康指标、昨夜体征和训练准备度","inputSchema":{"type":"object","properties":{"days":{"type":"integer","default":30,"minimum":1,"maximum":365}}}},
          {"name":"get_daily_summary","description":"按日期和字段查询每日健康摘要","inputSchema":{"type":"object","properties":{"start_date":{"type":"string","format":"date"},"end_date":{"type":"string","format":"date"},"fields":{"type":"array","items":{"type":"string"}}},"required":["start_date","end_date"]}},
          {"name":"get_day_detail","description":"单日睡眠、体征及训练","inputSchema":{"type":"object","properties":{"date":{"type":"string","format":"date"}},"required":["date"]}},
          {"name":"get_metric_detail","description":"面板指标的日、周、月、半年或年统计","inputSchema":{"type":"object","properties":{"metric":{"type":"string"},"scope":{"type":"string","enum":["D","W","M","6M","Y"],"default":"W"},"end_date":{"type":"string","format":"date"}},"required":["metric"]}},
          {"name":"list_workouts","description":"按运动类型和日期筛选训练","inputSchema":{"type":"object","properties":{"sport":{"type":"string"},"limit":{"type":"integer","minimum":1,"maximum":500,"default":30},"start_date":{"type":"string","format":"date"},"end_date":{"type":"string","format":"date"}}}},
          {"name":"get_workout_detail","description":"单次训练分段、心率区间及跑姿；GPS 等时间序列需显式请求","inputSchema":{"type":"object","properties":{"workout_id":{"type":"integer","minimum":1},"include_series":{"type":"boolean","default":false}},"required":["workout_id"]}},
          {"name":"get_sleep_sessions","description":"截至最近睡眠记录的科学睡眠和小睡","inputSchema":{"type":"object","properties":{"days":{"type":"integer","default":14,"minimum":1,"maximum":365}}}},
          {"name":"get_ecg_records","description":"查询心电图记录可用状态","inputSchema":{"type":"object","properties":{"days":{"type":"integer","default":30,"minimum":1,"maximum":365},"include_waveform":{"type":"boolean","default":false}}}},
          {"name":"get_pro_insights","description":"训练负荷、睡眠关联和有氧效率","inputSchema":{"type":"object","properties":{}}}
        ]
        """.trimIndent(),
    ).apply {
        repeat(length()) {
            getJSONObject(it).put("annotations", JSONObject().put("readOnlyHint", true).put("openWorldHint", false))
        }
    }
    private val names = (0 until tools.length()).map { tools.getJSONObject(it).getString("name") }.toSet()
    private val resource = JSONObject().put("uri", overviewUri).put("name", "健康摘要").put("mimeType", "application/json")

    fun supportsVersion(version: String) = version in supportedVersions

    fun handle(body: String): Reply {
        val message = try { JSONObject(body) } catch (_: Exception) {
            return Reply(400, error(JSONObject.NULL, -32700, "Parse error"))
        }
        val id = message.opt("id") ?: JSONObject.NULL
        if (message.opt("jsonrpc") != "2.0" || (id != JSONObject.NULL && id !is String && id !is Number)) {
            return Reply(400, error(JSONObject.NULL, -32600, "Invalid Request"))
        }
        val method = message.opt("method") as? String
        if (method == null) {
            return if (message.has("id") && (message.has("result") xor message.has("error"))) Reply(202)
            else Reply(400, error(id, -32600, "Invalid Request"))
        }
        if (!message.has("id")) return Reply(202)
        val params = message.optJSONObject("params") ?: JSONObject()
        if (message.has("params") && message.optJSONObject("params") == null) {
            return Reply(200, error(id, -32602, "Invalid params"))
        }

        val result = when (method) {
            "initialize" -> {
                val requested = params.optString("protocolVersion")
                val version = requested.takeIf(::supportsVersion) ?: "2025-11-25"
                JSONObject().put("protocolVersion", version)
                    .put("serverInfo", JSONObject().put("name", "huawei-health-panel").put("version", "1.0.2"))
                    .put("capabilities", JSONObject().put("tools", JSONObject()).put("resources", JSONObject()))
            }
            "ping" -> JSONObject()
            "tools/list" -> JSONObject().put("tools", tools)
            "resources/list" -> JSONObject().put("resources", JSONArray().put(resource))
            "resources/templates/list" -> JSONObject().put("resourceTemplates", JSONArray())
            "resources/read" -> {
                if (params.optString("uri") != overviewUri) return Reply(200, error(id, -32002, "Resource not found"))
                val content = runCatching { read("get_health_overview", JSONObject()) }
                    .getOrElse { return Reply(200, error(id, -32000, "无法读取本机健康摘要")) }
                JSONObject().put("contents", JSONArray().put(
                    JSONObject().put("uri", overviewUri).put("mimeType", "application/json").put("text", content),
                ))
            }
            "tools/call" -> {
                val name = params.optString("name")
                if (name !in names) return Reply(200, error(id, -32602, "Unknown tool"))
                val arguments = params.optJSONObject("arguments") ?: JSONObject()
                if (params.has("arguments") && params.optJSONObject("arguments") == null) {
                    return Reply(200, error(id, -32602, "Invalid arguments"))
                }
                runCatching { read(name, arguments) }.fold(
                    onSuccess = { content ->
                        toolResult(content).put("structuredContent", JSONObject(content))
                    },
                    onFailure = { toolResult("参数无效、记录不存在或无法读取本机数据库").put("isError", true) },
                )
            }
            else -> return Reply(200, error(id, -32601, "Method not found"))
        }
        return Reply(200, envelope(id).put("result", result).toString())
    }

    private fun toolResult(text: String) =
        JSONObject().put("content", JSONArray().put(JSONObject().put("type", "text").put("text", text)))

    private fun envelope(id: Any) = JSONObject().put("jsonrpc", "2.0").put("id", id)

    private fun error(id: Any, code: Int, text: String) =
        envelope(id).put("error", JSONObject().put("code", code).put("message", text)).toString()
}
