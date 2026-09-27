package com.sfubadminton.app.auth

import com.sfubadminton.app.data.Postgrest
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
     * attempt does not consume the token), then makes the web login's check
     * for an unfinished account ([keepIfFinished], shared with passkeys).
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

        return if (keepIfFinished(session, api, sessions, postgrest)) {
            VerifyCodeResult.SignedIn
        } else {
            VerifyCodeResult.Unfinished
        }
    }

    private companion object {
        const val RETRY_DELAY_MS = 900L
    }
}
