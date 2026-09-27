package com.sfubadminton.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.sfubadminton.app.Services
import com.sfubadminton.app.data.Viewer
import com.sfubadminton.app.data.isApproved
import com.sfubadminton.app.data.loadStatement
import com.sfubadminton.app.data.statementHeadline
import com.sfubadminton.app.shared.FeeLine
import com.sfubadminton.app.shared.FeeStatus
import com.sfubadminton.app.shared.money
import com.sfubadminton.app.ui.theme.LocalPalette

@Composable
fun MembershipScreen(services: Services, viewer: Viewer) {
    if (!isApproved(viewer)) {
        Column(Modifier.fillMaxSize().background(LocalPalette.current.background).padding(16.dp)) {
            Card { Body("Your statement appears here once your membership is approved.", muted = true) }
        }
        return
    }
    Statement(services, viewer)
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun Statement(services: Services, viewer: Viewer) {
    val p = LocalPalette.current
    val loader = rememberLoader(viewer) { loadStatement(services.postgrest, viewer) }

    when (val state = loader.state) {
        LoadState.Loading -> Loading()
        is LoadState.Error -> ErrorState(state.message, loader.reload)
        is LoadState.Ready -> PullToRefreshBox(isRefreshing = loader.refreshing, onRefresh = loader.reload) {
            val summary = state.data.summary
            val season = state.data.season
            val headline = statementHeadline(summary)
            Column(Modifier.fillMaxSize().background(p.background).verticalScroll(rememberScrollState()).padding(16.dp)) {
                Card {
                    Label("Outstanding")
                    Row(
                        Modifier.padding(bottom = 6.dp),
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                        verticalAlignment = Alignment.Bottom,
                    ) {
                        Text(headline.amount, color = p.text, fontSize = 36.sp, fontWeight = FontWeight.Bold)
                        Text(
                            headline.label,
                            color = if (summary.status == FeeStatus.OWING) p.danger else p.muted,
                            fontSize = 13.sp,
                            fontWeight = FontWeight.Bold,
                            letterSpacing = 0.8.sp,
                            modifier = Modifier.padding(bottom = 8.dp),
                        )
                    }
                    if (summary.unknownCount > 0) {
                        val noun = if (summary.unknownCount == 1) "entry" else "entries"
                        Body("Plus ${summary.unknownCount} $noun with no price recorded yet.", muted = true)
                    }
                    season?.let { Body(it.name, muted = true) }
                }

                if (summary.outstanding.isNotEmpty()) {
                    Card {
                        Label("To pay")
                        for (line in summary.outstanding) LineRow(line, money(line.owedCents))
                        Column(Modifier.padding(top = 8.dp)) {
                            Body("Send a payment receipt from the Membership page on the club website.", muted = true)
                        }
                    }
                }

                Card {
                    Label("Receipts")
                    if (summary.receipts.isEmpty()) {
                        Body("No payments recorded yet.", muted = true)
                    } else {
                        for (line in summary.receipts) {
                            LineRow(
                                line,
                                if (line.waived) "Waived" else money(line.recordedCents),
                                line.paidAt?.take(10),
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun LineRow(line: FeeLine, amount: String, detail: String? = null) {
    val p = LocalPalette.current
    HorizontalDivider(color = p.line)
    Row(
        Modifier.fillMaxWidth().padding(vertical = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(line.name, color = p.text, fontSize = 15.sp)
            if (!detail.isNullOrEmpty()) Text(detail, color = p.muted, fontSize = 13.sp)
        }
        Text(amount, color = p.text, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
    }
}
