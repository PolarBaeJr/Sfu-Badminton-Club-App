package com.sfubadminton.app.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.sfubadminton.app.ui.theme.LocalPalette

@Composable
fun Card(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    val p = LocalPalette.current
    Surface(
        modifier = modifier.fillMaxWidth().padding(bottom = 12.dp),
        shape = RoundedCornerShape(16.dp),
        color = p.surface,
        border = BorderStroke(1.dp, p.line),
    ) {
        Column(Modifier.padding(16.dp), content = content)
    }
}

@Composable
fun Label(text: String) {
    Text(
        text.uppercase(),
        color = LocalPalette.current.muted,
        fontSize = 12.sp,
        fontWeight = FontWeight.SemiBold,
        letterSpacing = 0.8.sp,
        modifier = Modifier.padding(bottom = 6.dp),
    )
}

@Composable
fun Body(text: String, muted: Boolean = false) {
    val p = LocalPalette.current
    Text(text, color = if (muted) p.muted else p.text, fontSize = 15.sp, lineHeight = 21.sp)
}

@Composable
fun Loading() {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        CircularProgressIndicator(color = LocalPalette.current.accent)
    }
}

/**
 * A failed read, said as one. On the web a refused read rendered as an empty
 * list for months; here an error is never drawn as "nothing yet".
 */
@Composable
fun ErrorState(message: String, onRetry: (() -> Unit)? = null) {
    val p = LocalPalette.current
    Column(
        Modifier.fillMaxSize().padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp, Alignment.CenterVertically),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(message, color = p.danger, fontSize = 15.sp, lineHeight = 21.sp, textAlign = TextAlign.Center)
        if (onRetry != null) {
            OutlinedButton(onClick = onRetry, border = BorderStroke(1.dp, p.line), shape = RoundedCornerShape(8.dp)) {
                Text("Try again", color = p.text)
            }
        }
    }
}

@Composable
fun EmptyState(message: String) {
    Box(Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
        Text(message, color = LocalPalette.current.muted, fontSize = 15.sp, textAlign = TextAlign.Center)
    }
}
