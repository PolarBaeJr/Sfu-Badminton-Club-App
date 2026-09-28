package com.sfubadminton.app.ui

import androidx.activity.compose.BackHandler
import androidx.compose.material3.IconButton
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.platform.LocalContext
import com.sfubadminton.app.data.isApproved
import com.sfubadminton.app.links.LinkRoute
import com.sfubadminton.app.links.LinkRouter
import com.sfubadminton.app.links.TabTarget
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import androidx.annotation.DrawableRes
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.sfubadminton.app.AppContainer
import com.sfubadminton.app.R
import com.sfubadminton.app.Services
import com.sfubadminton.app.auth.AuthState
import com.sfubadminton.app.auth.SignInNotice
import com.sfubadminton.app.config.SupabaseConfig
import com.sfubadminton.app.data.Viewer
import com.sfubadminton.app.data.loadViewer
import com.sfubadminton.app.ui.theme.LocalPalette
import com.sfubadminton.app.ui.theme.Type

@Composable
fun AppRoot(container: AppContainer) {
    val services = container.services
    val config = container.config
    if (services == null || config is SupabaseConfig.Missing) {
        ConfigErrorScreen((config as? SupabaseConfig.Missing)?.names ?: emptyList())
        return
    }
    val auth by services.sessions.state.collectAsStateWithLifecycle()
    when (val state = auth) {
        AuthState.Loading -> Loading()
        is AuthState.SignedOut -> SignInScreen(services, state.notice)
        is AuthState.SignedIn -> SignedIn(services, state.session.userId, container.pendingLink)
    }
}

@Composable
private fun SignedIn(services: Services, userId: String, pendingLink: MutableStateFlow<String?>) {
    // The member's own row, read once per session and shared by every tab.
    val viewer = rememberLoader(userId) { loadViewer(services.postgrest, userId) }
    when (val state = viewer.state) {
        LoadState.Loading -> Loading()
        is LoadState.Error -> ErrorState(state.message, viewer.reload)
        is LoadState.Ready -> {
            val data = state.data
            if (data == null) NoPlayerRow(services) else Tabs(services, data, pendingLink)
        }
    }
}

/**
 * A session with no player row: an account that never finished signing up, or
 * whose row is gone. Treated like the check after a code: the session is
 * dropped on this phone and the sign-in screen says why.
 */
@Composable
private fun NoPlayerRow(services: Services) {
    LaunchedEffect(Unit) { services.sessions.signOut(SignInNotice.UNFINISHED) }
    Loading()
}

private enum class Tab(val title: String, @param:DrawableRes val icon: Int) {
    LEADERBOARD("Leaderboard", R.drawable.ic_tab_leaderboard),
    CHALLENGES("Challenges", R.drawable.ic_tab_challenges),
    SESSIONS("Sessions", R.drawable.ic_tab_sessions),
    MY_STATS("My stats", R.drawable.ic_tab_stats),
    MEMBERSHIP("Membership", R.drawable.ic_tab_membership),
}

private fun TabTarget.tab(): Tab = when (this) {
    TabTarget.LEADERBOARD -> Tab.LEADERBOARD
    TabTarget.CHALLENGES -> Tab.CHALLENGES
    TabTarget.SESSIONS -> Tab.SESSIONS
    TabTarget.MY_STATS -> Tab.MY_STATS
    TabTarget.MEMBERSHIP -> Tab.MEMBERSHIP
}

// A screen laid over the tabs, held as a string so it survives recreation:
// "detail:<id>", "new:<id or empty>", "checkin:<token>", or "list" (the
// challenges list, for a member whose tab bar has no Challenges tab).
private const val DETAIL = "detail:"
private const val NEW = "new:"
private const val CHECKIN = "checkin:"
private const val LIST = "list"

@Composable
private fun Tabs(services: Services, viewer: Viewer, pendingLink: MutableStateFlow<String?>) {
    val p = LocalPalette.current
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val approved = isApproved(viewer)
    val tabs = Tab.entries.filter { it != Tab.CHALLENGES || approved }
    var tab by rememberSaveable { mutableStateOf(Tab.LEADERBOARD) }
    var overlay by rememberSaveable { mutableStateOf<String?>(null) }
    var notice by rememberSaveable { mutableStateOf<String?>(null) }
    var refreshKey by rememberSaveable { mutableIntStateOf(0) }
    if (tab !in tabs) tab = Tab.LEADERBOARD

    BackHandler(enabled = overlay != null) { overlay = null }

    fun route(route: LinkRoute, fromScanner: Boolean) {
        notice = null
        when (route) {
            is LinkRoute.Tab -> {
                overlay = null
                val target = route.tab.tab()
                if (target in tabs) tab = target else overlay = LIST
            }
            is LinkRoute.ChallengeDetail -> overlay = if (approved) DETAIL + route.id else LIST
            is LinkRoute.NewChallenge -> overlay = if (approved) NEW + (route.opponentId ?: "") else LIST
            is LinkRoute.CheckIn -> overlay = CHECKIN + route.token
            is LinkRoute.OpenInBrowser -> if (!openInBrowser(context, route.url)) notice = NO_BROWSER
            LinkRoute.NotOurs -> if (fromScanner) notice = SCAN_NOT_OURS
        }
    }

    // A link Android handed over (App Links), including one that arrived
    // while signed out. A link that is not the website's goes to the browser.
    LaunchedEffect(pendingLink) {
        pendingLink.collect { url ->
            if (url != null && pendingLink.compareAndSet(url, null)) {
                when (val parsed = LinkRouter.parse(url, services.siteUrl)) {
                    LinkRoute.NotOurs -> if (!openInBrowser(context, url)) notice = NO_BROWSER
                    else -> route(parsed, fromScanner = false)
                }
            }
        }
    }

    fun scan() {
        scope.launch {
            when (val outcome = scanQrCode(context)) {
                ScanOutcome.Cancelled -> Unit
                ScanOutcome.Unavailable -> notice = SCAN_UNAVAILABLE
                is ScanOutcome.Scanned -> route(LinkRouter.parse(outcome.text, services.siteUrl), fromScanner = true)
            }
        }
    }
    // Scanning needs the website's address to know a club code from any other.
    val onScan: (() -> Unit)? = if (services.siteUrl != null) ::scan else null
    val onChallenge: ((String) -> Unit)? = if (approved && services.appApi != null) {
        { id -> notice = null; overlay = NEW + id }
    } else {
        null
    }

    Scaffold(
        containerColor = p.background,
        topBar = { BrandBar(onScan) },
        bottomBar = {
            TabBar(tabs, if (overlay == null) tab else null) {
                tab = it
                overlay = null
                notice = null
            }
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
            notice?.let { text ->
                Column(Modifier.padding(start = 16.dp, top = 12.dp, end = 16.dp)) {
                    Notice(text)
                    TextLink("Dismiss") { notice = null }
                }
            }
            Box(Modifier.weight(1f)) {
                val o = overlay
                when {
                    o == null -> when (tab) {
                        Tab.LEADERBOARD -> LeaderboardScreen(services, viewer, onChallenge)
                        Tab.CHALLENGES -> ChallengesScreen(
                            services,
                            viewer,
                            refreshKey,
                            onOpen = { overlay = DETAIL + it },
                            onNew = { overlay = NEW },
                        )
                        Tab.MY_STATS -> MyStatsScreen(services, viewer)
                        Tab.SESSIONS -> SessionsScreen(services, viewer, onScan)
                        Tab.MEMBERSHIP -> MembershipScreen(services, viewer)
                    }
                    o.startsWith(DETAIL) -> Overlay("Back to challenges", { overlay = null }) {
                        ChallengeDetailScreen(services, viewer, o.removePrefix(DETAIL)) { refreshKey += 1 }
                    }
                    o.startsWith(NEW) -> Overlay("Back to challenges", { overlay = null }) {
                        NewChallengeScreen(services, viewer, o.removePrefix(NEW).ifEmpty { null }) {
                            refreshKey += 1
                            overlay = null
                            tab = Tab.CHALLENGES
                            notice = "Challenge sent!"
                        }
                    }
                    o.startsWith(CHECKIN) -> Overlay("Back", { overlay = null }) {
                        CheckInScreen(services, o.removePrefix(CHECKIN)) {
                            overlay = null
                            tab = Tab.SESSIONS
                        }
                    }
                    else -> Overlay("Back", { overlay = null }) {
                        ChallengesScreen(services, viewer, refreshKey, onOpen = {}, onNew = {})
                    }
                }
            }
        }
    }
}

/** A screen over the tabs: the web's "Back to ..." link above it. */
@Composable
private fun Overlay(back: String, onBack: () -> Unit, content: @Composable () -> Unit) {
    Column(Modifier.fillMaxSize()) {
        Box(Modifier.padding(horizontal = 12.dp)) { TextLink(back, onClick = onBack) }
        Box(Modifier.weight(1f)) { content() }
    }
}

/** The site header: the red tile and the club's name. Each page carries its own title. */
@Composable
private fun BrandBar(onScan: (() -> Unit)?) {
    val p = LocalPalette.current
    Column(Modifier.fillMaxWidth().background(p.background).windowInsetsPadding(WindowInsets.statusBars)) {
        Row(
            Modifier.fillMaxWidth().padding(start = 14.dp, top = 12.dp, end = 4.dp, bottom = 12.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            BrandTile(size = 30.dp, corner = 8.dp, markSize = 20.dp)
            Text("SFU Badminton", color = p.text, style = Type.brand, modifier = Modifier.weight(1f))
            if (onScan != null) {
                IconButton(onClick = onScan) {
                    Icon(
                        painterResource(R.drawable.ic_scan),
                        contentDescription = "Scan a club QR code",
                        tint = p.ink2,
                        modifier = Modifier.size(22.dp),
                    )
                }
            }
        }
        HorizontalDivider(color = p.line)
    }
}

/** The web's mobile tab bar: line icons over small labels, red for the open tab. */
@Composable
private fun TabBar(tabs: List<Tab>, tab: Tab?, onSelect: (Tab) -> Unit) {
    val p = LocalPalette.current
    Column(Modifier.fillMaxWidth().background(p.background)) {
        HorizontalDivider(color = p.line)
        Row(
            Modifier
                .windowInsetsPadding(WindowInsets.navigationBars)
                .selectableGroup()
                .padding(horizontal = 4.dp, vertical = 6.dp),
        ) {
            for (t in tabs) {
                val selected = tab == t
                val color = if (selected) p.accent else p.muted
                Column(
                    Modifier
                        .weight(1f)
                        .heightIn(min = 48.dp)
                        .selectable(selected = selected, role = Role.Tab) { onSelect(t) }
                        .padding(horizontal = 4.dp, vertical = 8.dp),
                    verticalArrangement = Arrangement.spacedBy(3.dp, Alignment.CenterVertically),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Icon(painterResource(t.icon), contentDescription = null, tint = color, modifier = Modifier.size(20.dp))
                    Text(t.title, color = color, style = Type.tabLabel, maxLines = 1)
                }
            }
        }
    }
}
