package com.sfubadminton.app.data

import com.sfubadminton.app.net.percentEncode

/**
 * A PostgREST read, built the way postgrest-js builds it, so both apps send the
 * server the same query. Pure: tested down to the exact query string.
 */
class PostgrestQuery private constructor(
    val method: String,
    val path: String,
    private val params: List<Pair<String, String>>,
) {
    fun eq(column: String, value: String) = filter(column, "eq.$value")
    fun gte(column: String, value: String) = filter(column, "gte.$value")
    fun notIsNull(column: String) = filter(column, "not.is.null")

    /** postgrest-js `in`: deduplicated, with a value quoted when it holds , ( or ). */
    fun isIn(column: String, values: List<String>): PostgrestQuery {
        val list = values.distinct().joinToString(",") { if (RESERVED.containsMatchIn(it)) "\"$it\"" else it }
        return filter(column, "in.($list)")
    }

    fun or(filters: String) = param("or", "($filters)")

    /** Appends to an existing order, as a second postgrest-js .order() call does. */
    fun order(column: String, ascending: Boolean, nullsLast: Boolean? = null): PostgrestQuery {
        val term = column + (if (ascending) ".asc" else ".desc") +
            when (nullsLast) {
                null -> ""
                true -> ".nullslast"
                false -> ".nullsfirst"
            }
        val existing = params.indexOfFirst { it.first == "order" }
        if (existing < 0) return param("order", term)
        val updated = params.toMutableList()
        updated[existing] = "order" to updated[existing].second + "," + term
        return PostgrestQuery(method, path, updated)
    }

    fun limit(count: Int) = param("limit", count.toString())

    fun filter(column: String, expression: String) = param(column, expression)

    /** The path and query string, percent-encoded, relative to the project URL. */
    fun pathAndQuery(): String {
        if (params.isEmpty()) return path
        return path + "?" + params.joinToString("&") { (k, v) -> percentEncode(k) + "=" + percentEncode(v) }
    }

    private fun param(key: String, value: String) = PostgrestQuery(method, path, params + (key to value))

    companion object {
        private val RESERVED = Regex("[,()]")
        private val WHITESPACE = Regex("\\s")

        fun select(table: String, columns: String): PostgrestQuery =
            PostgrestQuery("GET", "/rest/v1/$table", listOf("select" to cleanSelect(columns)))

        /** An RPC with no arguments: POST with an empty object body. */
        fun rpc(function: String): PostgrestQuery = PostgrestQuery("POST", "/rest/v1/rpc/$function", emptyList())

        /** postgrest-js strips whitespace from a select, except inside double quotes. */
        fun cleanSelect(columns: String): String {
            var quoted = false
            val out = StringBuilder(columns.length)
            for (c in columns) {
                if (WHITESPACE.matches(c.toString()) && !quoted) continue
                if (c == '"') quoted = !quoted
                out.append(c)
            }
            return out.toString()
        }

        fun headers(anonKey: String, accessToken: String, withBody: Boolean): Map<String, String> =
            buildMap {
                put("apikey", anonKey)
                put("Authorization", "Bearer $accessToken")
                put("Accept", "application/json")
                if (withBody) put("Content-Type", "application/json")
            }
    }
}
