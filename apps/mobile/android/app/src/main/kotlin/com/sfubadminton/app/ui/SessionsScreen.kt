package com.sfubadminton.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.sfubadminton.app.Services
import com.sfubadminton.app.data.Viewer
import com.sfubadminton.app.data.formatSessionDate
import com.sfubadminton.app.data.loadUpcomingSessions
import com.sfubadminton.app.data.timeRange
import com.sfubadminton.app.ui.theme.LocalPalette

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SessionsScreen(services: Services, viewer: Viewer) {
    val p = LocalPalette.current
    val loader = rememberLoader(viewer.id to viewer.status) { loadUpcomingSessions(services.postgrest, viewer.status) }

    when (val state = loader.state) {
        LoadState.Loading -> Loading()
        is LoadState.Error -> ErrorState(state.message, loader.reload)
        is LoadState.Ready -> PullToRefreshBox(isRefreshing = loader.refreshing, onRefresh = loader.reload) {
            LazyColumn(Modifier.fillMaxSize().background(p.background)) {
                if (state.data.isEmpty()) {
                    item { Box(Modifier.fillParentMaxSize()) { EmptyState("No sessions are scheduled yet.") } }
                }
                items(state.data, key = { it.id }) { session ->
                    Column(
                        Modifier.fillMaxWidth().background(p.surface).padding(horizontal = 16.dp, vertical = 12.dp),
                        verticalArrangement = Arrangement.spacedBy(2.dp),
                    ) {
                        Text(
                            formatSessionDate(session.date).uppercase(),
                            color = p.text,
                            fontSize = 13.sp,
                            fontWeight = FontWeight.Bold,
                        )
                        Text(session.name ?: "Club session", color = p.text, fontSize = 15.sp)
                        Text(
                            listOf(timeRange(session.startTime, session.endTime), session.location)
                                .filter { it.isNotEmpty() }
                                .joinToString(" · "),
                            color = p.muted,
                            fontSize = 13.sp,
                        )
                    }
                    HorizontalDivider(color = p.line)
                }
            }
        }
    }
}
