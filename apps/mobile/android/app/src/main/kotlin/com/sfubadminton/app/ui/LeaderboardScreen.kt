package com.sfubadminton.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.sfubadminton.app.Services
import com.sfubadminton.app.data.LeaderboardTab
import com.sfubadminton.app.data.Viewer
import com.sfubadminton.app.data.fmtElo
import com.sfubadminton.app.data.loadLadder
import com.sfubadminton.app.data.rankLadder
import com.sfubadminton.app.ui.theme.LocalPalette

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LeaderboardScreen(services: Services, viewer: Viewer) {
    val p = LocalPalette.current
    var tab by rememberSaveable { mutableStateOf(LeaderboardTab.OPEN_SINGLES) }
    // get_leaderboard() is the database's own filtered ladder. Nothing else
    // here reads another member's rating.
    val loader = rememberLoader(viewer.id) { loadLadder(services.postgrest) }

    Column(Modifier.fillMaxSize().background(p.background)) {
        Row(
            Modifier.fillMaxWidth().padding(8.dp),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            for (t in LeaderboardTab.entries) {
                val selected = tab == t
                Text(
                    t.label,
                    color = if (selected) Color.White else p.text,
                    fontSize = 13.sp,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier
                        .weight(1f)
                        .clip(RoundedCornerShape(8.dp))
                        .background(if (selected) p.accent else Color.Transparent)
                        .selectable(selected = selected, role = Role.Tab) { tab = t }
                        .padding(vertical = 8.dp),
                    textAlign = TextAlign.Center,
                )
            }
        }
        HorizontalDivider(color = p.line)

        when (val state = loader.state) {
            LoadState.Loading -> Loading()
            is LoadState.Error -> ErrorState(state.message, loader.reload)
            is LoadState.Ready -> {
                val ranked = remember(state.data, tab) { rankLadder(state.data, tab) }
                PullToRefreshBox(isRefreshing = loader.refreshing, onRefresh = loader.reload) {
                    LazyColumn(Modifier.fillMaxSize()) {
                        if (ranked.isEmpty()) {
                            item { Box(Modifier.fillParentMaxSize()) { EmptyState("No ranked players yet.") } }
                        }
                        items(ranked, key = { it.row.id }) { item ->
                            val me = item.row.id == viewer.id
                            Row(
                                Modifier
                                    .fillMaxWidth()
                                    .background(if (me) p.highlight else p.surface)
                                    .padding(horizontal = 16.dp, vertical = 12.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Text(item.rank.toString(), color = p.muted, fontSize = 15.sp, modifier = Modifier.width(36.dp))
                                Column(Modifier.weight(1f)) {
                                    Text(
                                        item.row.name + if (me) "  (you)" else "",
                                        color = p.text,
                                        fontSize = 15.sp,
                                        fontWeight = FontWeight.Medium,
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis,
                                    )
                                    item.row.handle?.takeIf { it.isNotEmpty() }?.let {
                                        Text("@$it", color = p.muted, fontSize = 13.sp, maxLines = 1)
                                    }
                                }
                                Text(fmtElo(item.elo), color = p.text, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
                            }
                            HorizontalDivider(color = p.line)
                        }
                    }
                }
            }
        }
    }
}
