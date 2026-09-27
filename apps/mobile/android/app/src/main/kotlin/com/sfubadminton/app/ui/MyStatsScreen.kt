package com.sfubadminton.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.sfubadminton.app.Services
import com.sfubadminton.app.data.MyStats
import com.sfubadminton.app.data.Viewer
import com.sfubadminton.app.data.fmtDelta
import com.sfubadminton.app.data.fmtElo
import com.sfubadminton.app.data.loadMyStats
import com.sfubadminton.app.ui.theme.LocalPalette
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MyStatsScreen(services: Services, viewer: Viewer) {
    val p = LocalPalette.current
    val scope = rememberCoroutineScope()
    val loader = rememberLoader(viewer.id) { loadMyStats(services.postgrest, viewer.id) }

    PullToRefreshBox(isRefreshing = loader.refreshing, onRefresh = loader.reload) {
        Column(
            Modifier.fillMaxSize().background(p.background).verticalScroll(rememberScrollState()).padding(16.dp),
        ) {
            Card {
                Text(
                    viewer.fullName ?: "Member",
                    color = p.text,
                    fontSize = 20.sp,
                    fontWeight = FontWeight.Bold,
                    modifier = Modifier.padding(bottom = 4.dp),
                )
                viewer.handle?.takeIf { it.isNotEmpty() }?.let { Body("@$it", muted = true) }
                viewer.memberCode?.takeIf { it.isNotEmpty() }?.let { Body("Member $it", muted = true) }
            }

            when (val state = loader.state) {
                LoadState.Loading -> Column(Modifier.fillMaxWidth().height(160.dp)) { Loading() }
                is LoadState.Error -> Column(Modifier.fillMaxWidth().height(200.dp)) {
                    ErrorState(state.message, loader.reload)
                }
                is LoadState.Ready -> StatsCards(state.data)
            }

            GhostButton("Sign out") { scope.launch { services.sessions.signOut() } }
        }
    }
}

@Composable
private fun StatsCards(stats: MyStats) {
    val p = LocalPalette.current
    Card {
        Label("Rating")
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Readout("Singles", fmtElo(stats.singlesElo))
            Readout("Doubles", fmtElo(stats.doublesElo))
            Readout("Ladder", stats.position?.let { "#$it" } ?: "Not on the ladder")
        }
    }

    Card {
        Label(stats.seasonName ?: "This season")
        val record = stats.record
        when {
            record == null -> Body("No season is running.", muted = true)
            record.played == 0 -> Body("No settled matches this season yet.", muted = true)
            else -> Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Readout("Record", "${record.wins}-${record.losses}")
                Readout("Singles", "${record.singles.wins}-${record.singles.losses}")
                Readout("Doubles", "${record.doubles.wins}-${record.doubles.losses}")
            }
        }
    }

    Card {
        Label("Recent matches")
        if (stats.recent.isEmpty()) {
            Body("No matches yet.", muted = true)
        } else {
            for (m in stats.recent) {
                HorizontalDivider(color = p.line)
                Row(Modifier.fillMaxWidth().padding(vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        when (m.outcome) {
                            true -> "W"
                            false -> "L"
                            null -> "-"
                        },
                        color = if (m.outcome == true) p.accent else p.muted,
                        fontSize = 16.sp,
                        fontWeight = FontWeight.Bold,
                        modifier = Modifier.width(24.dp),
                    )
                    Column(Modifier.weight(1f)) {
                        Text(
                            (if (m.type == "singles") "Singles" else "Doubles") + (m.score?.let { "  $it" } ?: ""),
                            color = p.text,
                        )
                        Text(m.playedAt?.take(10) ?: "", color = p.muted, fontSize = 13.sp)
                    }
                    Text(fmtDelta(m.delta), color = p.text, fontSize = 15.sp)
                }
            }
        }
    }
}

@Composable
private fun RowScope.Readout(label: String, value: String) {
    val p = LocalPalette.current
    Column(Modifier.weight(1f)) {
        Text(value, color = p.text, fontSize = 18.sp, fontWeight = FontWeight.Bold)
        Text(label, color = p.muted, fontSize = 13.sp)
    }
}
