package com.sfubadminton.app.auth

import com.sfubadminton.app.data.Postgrest
import com.sfubadminton.app.data.PostgrestQuery
import com.sfubadminton.app.data.PostgrestResult
import com.sfubadminton.app.shared.SIGNIN_OTP_TYPES
import com.sfubadminton.app.shared.authErrorCode
import com.sfubadminton.app.shared.friendlyAuthError
import com.sfubadminton.app.shared.isUnknownAccountError
import com.sfubadminton.app.shared.shouldRetryOtpSend
import com.sfubadminton.app.shared.shouldTryNextOtpType
import com.sfubadminton.app.shared.withErrorCode
import kotlinx.coroutines.delay

// Port of the Expo app's src/lib/auth/email-code.ts, itself a mirror of
// apps/player/src/lib/email-code-client.ts. Keep in step with both.

sealed interface SendCodeResult {
    data object Sent : SendCodeResult
    data object UnknownAccount : SendCodeResult
    data class Failed(val message: String) : SendCodeResult
}

sealed interface VerifyCodeResult {
    data object SignedIn : VerifyCodeResult
    /** The account has no player row: it never finished signing up on the website. */
    data object Unfinished : VerifyCodeResult
    data class Failed(val message: String) : VerifyCodeResult
}

class EmailCode(
    private val api: GoTrueApi,
    private val sessions: SessionManager,
    private val postgrest: Postgrest,
    private val pause: suspend (Long) -> Unit = { delay(it) },
) {
    suspend fun send(email: String): SendCodeResult {
        // The auth gateway can 503 on the first request after an idle period;
        // one silent retry makes that invisible. Only that: a rate limit or an
        // unknown account would just be refused again, and cost another send.
        var error = api.sendOtp(email)
        if (error != null && shouldRetryOtpSend(error.message, error.code, error.status)) {
            pause(RETRY_DELAY_MS)
            error = api.sendOtp(email)
        }
        if (error == null) return SendCodeResult.Sent
        if (isUnknownAccountError(error.message, error.code)) return SendCodeResult.UnknownAccount
        return SendCodeResult.Failed(
            withErrorCode(friendlyAuthError(error.message), authErrorCode(error.message, error.code, error.status)),
        )
    }

    /**
     * Tries each token type GoTrue might have issued in turn (a wrong-type
     * attempt does not consume the token), then makes the web login's check:
     * players_self is scoped to the caller, so no row and no error means an
     * account that never finished signing up. That session is ended on this
     * device and never kept. A read error fails OPEN, as it does on the web.
     */
    suspend fun verify(email: String, token: String): VerifyCodeResult {
        var lastError: GoTrueError? = null
        var session: StoredSession? = null
        for (type in SIGNIN_OTP_TYPES) {
            when (val result = api.verifyOtp(email, token, type)) {
                is GoTrueResult.Ok -> session = result.value
                is GoTrueResult.Failed -> lastError = result.error
            }
            if (session != null) break
            if (!shouldTryNextOtpType(lastError?.message)) break
        }
        if (session == null) {
            val message = lastError?.message ?: ""
            return VerifyCodeResult.Failed(
                withErrorCode(
                    friendlyAuthError(message.ifEmpty { "That code did not work. Request a new one." }),
                    authErrorCode(message, lastError?.code, lastError?.status),
                ),
            )
        }

        val check = postgrest.getWithToken(PostgrestQuery.select("players_self", "id"), session.accessToken)
        if (check is PostgrestResult.Ok && check.rows.isEmpty()) {
            api.logout(session.accessToken)
            return VerifyCodeResult.Unfinished
        }
        sessions.signedIn(session)
        return VerifyCodeResult.SignedIn
    }

    private companion object {
        const val RETRY_DELAY_MS = 900L
    }
}
