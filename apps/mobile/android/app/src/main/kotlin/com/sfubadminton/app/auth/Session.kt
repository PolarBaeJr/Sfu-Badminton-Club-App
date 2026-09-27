package com.sfubadminton.app.auth

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.longOrNull

/** What the app keeps between launches. Only the user's id and email: nothing else is read. */
@Serializable
data class StoredSession(
    val accessToken: String,
    val refreshToken: String,
    val expiresAtEpochSec: Long,
    val userId: String,
    val email: String? = null,
)

private val sessionJson = Json { ignoreUnknownKeys = true }

/**
 * A GoTrue session response (verify, or the refresh grant). expires_at is
 * absent on some GoTrue versions, in which case expires_in counts from now, as
 * auth-js does. Null when the body is not a session.
 */
fun parseSession(body: String, nowEpochSec: Long): StoredSession? {
    val obj = try {
        sessionJson.parseToJsonElement(body).jsonObject
    } catch (e: IllegalArgumentException) {
        return null
    }
    val accessToken = obj.string("access_token") ?: return null
    val refreshToken = obj.string("refresh_token") ?: return null
    val user = obj["user"] as? JsonObject ?: return null
    val userId = user.string("id") ?: return null
    val expiresAt = (obj["expires_at"] as? JsonPrimitive)?.longOrNull
        ?: (obj["expires_in"] as? JsonPrimitive)?.longOrNull?.let { nowEpochSec + it }
        ?: return null
    return StoredSession(accessToken, refreshToken, expiresAt, userId, user.string("email"))
}

private fun JsonObject.string(key: String): String? {
    val value = this[key] as? JsonPrimitive ?: return null
    return if (value.isString) value.content else null
}
