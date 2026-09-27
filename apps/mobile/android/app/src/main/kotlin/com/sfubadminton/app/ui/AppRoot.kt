package com.sfubadminton.app.ui

import androidx.annotation.DrawableRes
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
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

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun Tabs(services: Services, viewer: Viewer) {
    val p = LocalPalette.current
    var tab by rememberSaveable { mutableStateOf(Tab.LEADERBOARD) }
    Scaffold(
        containerColor = p.background,
        topBar = {
            CenterAlignedTopAppBar(
                title = { Text(tab.title) },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = p.surface, titleContentColor = p.text),
            )
        },
        bottomBar = {
            NavigationBar(containerColor = p.surface) {
                for (t in Tab.entries) {
                    NavigationBarItem(
                        selected = tab == t,
                        onClick = { tab = t },
                        icon = { Icon(painterResource(t.icon), contentDescription = null) },
                        label = { Text(t.title) },
                        colors = NavigationBarItemDefaults.colors(
                            selectedIconColor = p.accent,
                            selectedTextColor = p.accent,
                            unselectedIconColor = p.muted,
                            unselectedTextColor = p.muted,
                            indicatorColor = p.highlight,
                        ),
                    )
                }
            }
        },
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
