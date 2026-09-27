package com.sfubadminton.app

import android.content.Context
import com.sfubadminton.app.auth.EmailCode
import com.sfubadminton.app.auth.FileSessionStore
import com.sfubadminton.app.auth.GoTrueApi
import com.sfubadminton.app.auth.KeystoreSessionCipher
import com.sfubadminton.app.auth.PasskeyApi
import com.sfubadminton.app.auth.PasskeySignIn
import com.sfubadminton.app.auth.SessionManager
import com.sfubadminton.app.config.SiteConfig
import com.sfubadminton.app.config.SupabaseConfig
import com.sfubadminton.app.data.Postgrest
import com.sfubadminton.app.net.UrlConnectionTransport
import java.io.File

/** The configured app: built once per process, so one session has one owner. */
class Services(context: Context, config: SupabaseConfig.Ok, val siteUrl: String?) {
    private val transport = UrlConnectionTransport()
    private val clock = { System.currentTimeMillis() / 1000 }
    private val gotrue = GoTrueApi(config, transport, clock)
    val sessions = SessionManager(
        gotrue,
        FileSessionStore(File(context.filesDir, "session.bin"), KeystoreSessionCipher()),
        clock,
    )
    val postgrest = Postgrest(config, transport, sessions)
    val emailCode = EmailCode(gotrue, sessions, postgrest)

    /** Null when the build names no club website: the sign-in screen then offers email codes only. */
    val passkey: PasskeySignIn? = siteUrl?.let { PasskeySignIn(PasskeyApi(it, transport), gotrue, sessions, postgrest, clock) }
}

class AppContainer(context: Context) {
    val config: SupabaseConfig = SupabaseConfig.read(BuildConfig.SUPABASE_URL, BuildConfig.SUPABASE_ANON_KEY)

    /** Null when the build has no usable config; the app then shows the config screen. */
    val services: Services? = (config as? SupabaseConfig.Ok)?.let {
        Services(context.applicationContext, it, SiteConfig.read(BuildConfig.SITE_URL))
    }
}
