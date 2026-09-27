package com.sfubadminton.app.ui

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
        is AuthState.SignedIn -> SignedIn(services, state.session.userId)
    }
}

@Composable
private fun SignedIn(services: Services, userId: String) {
    // The member's own row, read once per session and shared by every tab.
    val viewer = rememberLoader(userId) { loadViewer(services.postgrest, userId) }
    when (val state = viewer.state) {
        LoadState.Loading -> Loading()
        is LoadState.Error -> ErrorState(state.message, viewer.reload)
        is LoadState.Ready -> {
            val data = state.data
            if (data == null) NoPlayerRow(services) else Tabs(services, data)
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
    MY_STATS("My stats", R.drawable.ic_tab_stats),
    SESSIONS("Sessions", R.drawable.ic_tab_sessions),
    MEMBERSHIP("Membership", R.drawable.ic_tab_membership),
}

@Composable
private fun Tabs(services: Services, viewer: Viewer) {
    val p = LocalPalette.current
    var tab by rememberSaveable { mutableStateOf(Tab.LEADERBOARD) }
    Scaffold(
        containerColor = p.background,
        topBar = { BrandBar() },
        bottomBar = { TabBar(tab) { tab = it } },
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding)) {
            when (tab) {
                Tab.LEADERBOARD -> LeaderboardScreen(services, viewer)
                Tab.MY_STATS -> MyStatsScreen(services, viewer)
                Tab.SESSIONS -> SessionsScreen(services, viewer)
                Tab.MEMBERSHIP -> MembershipScreen(services, viewer)
            }
        }
    }
}

/** The site header: the red tile and the club's name. Each page carries its own title. */
@Composable
private fun BrandBar() {
    val p = LocalPalette.current
    Column(Modifier.fillMaxWidth().background(p.background).windowInsetsPadding(WindowInsets.statusBars)) {
        Row(
            Modifier.padding(horizontal = 14.dp, vertical = 12.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            BrandTile(size = 30.dp, corner = 8.dp, markSize = 20.dp)
            Text("SFU Badminton", color = p.text, style = Type.brand)
        }
        HorizontalDivider(color = p.line)
    }
}

/** The web's mobile tab bar: line icons over small labels, red for the open tab. */
@Composable
private fun TabBar(tab: Tab, onSelect: (Tab) -> Unit) {
    val p = LocalPalette.current
    Column(Modifier.fillMaxWidth().background(p.background)) {
        HorizontalDivider(color = p.line)
        Row(
            Modifier
                .windowInsetsPadding(WindowInsets.navigationBars)
                .selectableGroup()
                .padding(horizontal = 4.dp, vertical = 6.dp),
        ) {
            for (t in Tab.entries) {
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
