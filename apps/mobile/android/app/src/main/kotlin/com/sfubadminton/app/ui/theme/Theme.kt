package com.sfubadminton.app.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color

// The Expo app's palette (src/components/theme.ts), following the phone's
// light or dark setting.

@Immutable
data class Palette(
    val background: Color,
    val surface: Color,
    val line: Color,
    val text: Color,
    val muted: Color,
    val accent: Color,
    val danger: Color,
    val highlight: Color,
)

private val Light = Palette(
    background = Color(0xFFF6F6F4),
    surface = Color(0xFFFFFFFF),
    line = Color(0xFFE2E2DE),
    text = Color(0xFF16181D),
    muted = Color(0xFF6B6F78),
    accent = Color(0xFFA6192E),
    danger = Color(0xFFB42318),
    highlight = Color(0xFFFBE9EC),
)

private val Dark = Palette(
    background = Color(0xFF0F1114),
    surface = Color(0xFF181B20),
    line = Color(0xFF2A2E35),
    text = Color(0xFFF1F2F4),
    muted = Color(0xFF9AA0AA),
    accent = Color(0xFFE0485D),
    danger = Color(0xFFF97066),
    highlight = Color(0xFF3A1D23),
)

val LocalPalette = staticCompositionLocalOf { Light }

@Composable
fun AppTheme(content: @Composable () -> Unit) {
    val dark = isSystemInDarkTheme()
    val p = if (dark) Dark else Light
    val base = if (dark) darkColorScheme() else lightColorScheme()
    val scheme = base.copy(
        primary = p.accent,
        onPrimary = Color.White,
        background = p.background,
        onBackground = p.text,
        surface = p.surface,
        onSurface = p.text,
        surfaceVariant = p.surface,
        onSurfaceVariant = p.muted,
        surfaceContainer = p.surface,
        secondaryContainer = p.highlight,
        onSecondaryContainer = p.text,
        outline = p.line,
        outlineVariant = p.line,
        error = p.danger,
    )
    CompositionLocalProvider(LocalPalette provides p) {
        MaterialTheme(colorScheme = scheme, content = content)
    }
}
