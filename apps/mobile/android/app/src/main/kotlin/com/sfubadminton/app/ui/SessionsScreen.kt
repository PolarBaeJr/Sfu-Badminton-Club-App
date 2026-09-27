package com.sfubadminton.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.sfubadminton.app.Services
import com.sfubadminton.app.data.Viewer
import com.sfubadminton.app.data.formatSessionDate
import com.sfubadminton.app.data.loadUpcomingSessions
import com.sfubadminton.app.data.timeRange
import com.sfubadminton.app.ui.theme.BarlowCondensed
import com.sfubadminton.app.ui.theme.LocalPalette
import com.sfubadminton.app.ui.theme.Type

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SessionsScreen(services: Services, viewer: Viewer) {
    val p = LocalPalette.current
    val loader = rememberLoader(viewer.id to viewer.status) { loadUpcomingSessions(services.postgrest, viewer.status) }

    when (val state = loader.state) {
        LoadState.Loading -> Column(Modifier.fillMaxSize()) {
            PageHeader("Sessions")
            Box(Modifier.weight(1f)) { Loading() }
        }
        is LoadState.Error -> Column(Modifier.fillMaxSize()) {
            PageHeader("Sessions")
            Box(Modifier.weight(1f)) { ErrorState(state.message, loader.reload) }
        }
        is LoadState.Ready -> PullToRefreshBox(isRefreshing = loader.refreshing, onRefresh = loader.reload) {
            LazyColumn(
                Modifier.fillMaxSize().background(p.background),
                contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 20.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                item { PageHeader("Sessions", padding = PaddingValues(top = 20.dp, bottom = 8.dp)) }
                if (state.data.isEmpty()) {
                    item { Box(Modifier.fillParentMaxSize()) { EmptyState("No sessions are scheduled yet.") } }
                }
                itemsIndexed(state.data, key = { _, it -> it.id }) { i, session ->
                    val shape = RoundedCornerShape(12.dp)
                    val accent = p.accent
                    Column(
                        Modifier
                            .fillMaxWidth()
                            .clip(shape)
                            .background(p.surface)
                            .drawBehind {
                                // The next session carries the web's red spine.
                                if (i == 0) drawRect(accent, size = Size(3.dp.toPx(), size.height))
                            }
                            .border(1.dp, p.line, shape)
                            .padding(16.dp),
                    ) {
                        Text(formatSessionDate(session.date).uppercase(), color = p.muted, style = Type.sessDate)
                        Text(
                            session.name ?: "Club session",
                            color = p.text,
                            fontFamily = BarlowCondensed,
                            fontWeight = FontWeight.Bold,
                            fontSize = 22.sp,
                            modifier = Modifier.padding(top = 6.dp),
                        )
                        val time = timeRange(session.startTime, session.endTime)
                        if (time.isNotEmpty()) {
                            Text(time, color = p.text, style = Type.sessTime, modifier = Modifier.padding(top = 6.dp))
                        }
                        if (session.location.isNotEmpty()) {
                            Text(session.location, color = p.muted, style = Type.sessMeta, modifier = Modifier.padding(top = 8.dp))
                        }
                    }
                }
            }
        }
    }
}
