package com.sfubadminton.app.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.sfubadminton.app.Services
import com.sfubadminton.app.auth.CredentialManagerAuthenticator
import com.sfubadminton.app.auth.PasskeySignIn
import com.sfubadminton.app.auth.PasskeySignInResult
import com.sfubadminton.app.auth.SendCodeResult
import com.sfubadminton.app.auth.SignInNotice
import com.sfubadminton.app.auth.VerifyCodeResult
import com.sfubadminton.app.ui.theme.LocalPalette
import kotlinx.coroutines.launch

/**
 * Email then code, or a passkey. Sign-in only: accounts are created on the
 * website, where the waivers are signed, so an unknown address is told so
 * rather than enrolled, and passkeys are added there too. The notice lives in
 * the session manager, not here: a good code or passkey for an unfinished
 * account comes back to a freshly composed screen. The passkey button shows
 * only when the build names the club website, and hides for the rest of the
 * screen's life once passkeys prove unavailable.
 */
@Composable
fun SignInScreen(services: Services, notice: SignInNotice?) {
    val p = LocalPalette.current
    val scope = rememberCoroutineScope()
    var email by rememberSaveable { mutableStateOf("") }
    var code by rememberSaveable { mutableStateOf("") }
    var sent by rememberSaveable { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var error by rememberSaveable { mutableStateOf("") }
    var info by rememberSaveable { mutableStateOf("") }
    var passkeyOff by rememberSaveable { mutableStateOf(false) }
    // LocalContext here is the Activity, which Credential Manager needs to show
    // its sheet over; the application context would fail.
    val context = LocalContext.current
    val authenticator = remember(context) { CredentialManagerAuthenticator(context) }

    suspend fun send(): Boolean = when (val result = services.emailCode.send(email.trim())) {
        SendCodeResult.Sent -> true
        SendCodeResult.UnknownAccount -> {
            services.sessions.setNotice(SignInNotice.UNKNOWN_ACCOUNT)
            false
        }
        is SendCodeResult.Failed -> {
            error = result.message
            false
        }
    }

    fun handleSend() = scope.launch {
        busy = true
        error = ""
        info = ""
        services.sessions.setNotice(null)
        if (send()) {
            code = ""
            sent = true
        }
        busy = false
    }

    fun handleResend() = scope.launch {
        busy = true
        error = ""
        info = ""
        if (send()) info = "A new code is on its way."
        busy = false
    }

    fun handleVerify() = scope.launch {
        busy = true
        error = ""
        when (val result = services.emailCode.verify(email.trim(), code.trim())) {
            // The session manager swaps this screen out; nothing to do here.
            VerifyCodeResult.SignedIn -> Unit
            VerifyCodeResult.Unfinished -> {
                sent = false
                code = ""
                services.sessions.setNotice(SignInNotice.UNFINISHED)
            }
            is VerifyCodeResult.Failed -> error = result.message
        }
        busy = false
    }

    fun handlePasskey(passkey: PasskeySignIn) = scope.launch {
        busy = true
        error = ""
        info = ""
        services.sessions.setNotice(null)
        when (val result = passkey.signIn(authenticator)) {
            // The session manager swaps this screen out; nothing to do here.
            PasskeySignInResult.SignedIn -> Unit
            PasskeySignInResult.Unfinished -> services.sessions.setNotice(SignInNotice.UNFINISHED)
            // The member closed the sheet: they know, so nothing is said.
            PasskeySignInResult.Cancelled -> Unit
            PasskeySignInResult.NoPasskey ->
                error = "There is no SFU Badminton passkey on this phone. Sign in with an email code, " +
                    "then add a passkey on the club website."
            PasskeySignInResult.Unavailable -> {
                passkeyOff = true
                info = "Passkey sign-in is not available right now. Use an email code."
            }
            is PasskeySignInResult.Failed -> error = result.message
        }
        busy = false
    }

    Column(
        Modifier
            .fillMaxSize()
            .background(p.background)
            .safeDrawingPadding()
            .imePadding()
            .verticalScroll(rememberScrollState())
            .padding(20.dp),
        verticalArrangement = Arrangement.Center,
    ) {
        Text(
            "SFU Badminton",
            color = p.text,
            fontSize = 28.sp,
            fontWeight = FontWeight.Bold,
            modifier = Modifier.padding(bottom = 20.dp),
        )
        Card {
            if (!sent) {
                Body("Sign in with the email on your club account. We will send you a 6-digit code.", muted = true)
                OutlinedTextField(
                    value = email,
                    onValueChange = { email = it },
                    placeholder = { Text("Email") },
                    singleLine = true,
                    enabled = !busy,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email),
                    modifier = Modifier.fillMaxWidth().padding(top = 12.dp),
                )
                PrimaryButton(if (busy) "Sending..." else "Send code", enabled = !busy && email.isNotBlank()) {
                    handleSend()
                }
                val passkey = services.passkey
                if (passkey != null && !passkeyOff) {
                    GhostButton(if (busy) "Checking..." else "Sign in with a passkey", enabled = !busy) {
                        handlePasskey(passkey)
                    }
                    Message("Passkeys are added on the club website, not in this app.", p.muted)
                }
            } else {
                Body("Enter the code we sent to ${email.trim()}.", muted = true)
                OutlinedTextField(
                    value = code,
                    onValueChange = { if (it.length <= 10) code = it },
                    placeholder = { Text("6-digit code") },
                    singleLine = true,
                    enabled = !busy,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
                    modifier = Modifier.fillMaxWidth().padding(top = 12.dp),
                )
                PrimaryButton(if (busy) "Checking..." else "Sign in", enabled = !busy && code.isNotBlank()) {
                    handleVerify()
                }
                GhostButton("Resend code", enabled = !busy) { handleResend() }
                GhostButton("Change email", enabled = !busy) {
                    sent = false
                    code = ""
                    error = ""
                    info = ""
                }
            }
            if (info.isNotEmpty()) Message(info, p.muted)
            if (error.isNotEmpty()) Message(error, p.danger)
            when (notice) {
                SignInNotice.UNKNOWN_ACCOUNT ->
                    Message("No account uses that email. Create an account on the club website first.", p.danger)
                SignInNotice.UNFINISHED ->
                    Message(
                        "That account has not finished signing up yet. Complete sign-up on the club website, " +
                            "then sign in here.",
                        p.danger,
                    )
                null -> Unit
            }
        }
    }
}

@Composable
private fun Message(text: String, color: androidx.compose.ui.graphics.Color) {
    Text(text, color = color, fontSize = 14.sp, lineHeight = 20.sp, modifier = Modifier.padding(top = 12.dp))
}

@Composable
fun PrimaryButton(title: String, enabled: Boolean = true, onClick: () -> Unit) {
    val p = LocalPalette.current
    Button(
        onClick = onClick,
        enabled = enabled,
        shape = RoundedCornerShape(8.dp),
        colors = ButtonDefaults.buttonColors(containerColor = p.accent),
        modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
    ) {
        Text(title, fontWeight = FontWeight.SemiBold)
    }
}

@Composable
fun GhostButton(title: String, enabled: Boolean = true, onClick: () -> Unit) {
    val p = LocalPalette.current
    OutlinedButton(
        onClick = onClick,
        enabled = enabled,
        shape = RoundedCornerShape(8.dp),
        border = BorderStroke(1.dp, p.line),
        modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
    ) {
        Text(title, color = p.text, fontWeight = FontWeight.SemiBold)
    }
}
