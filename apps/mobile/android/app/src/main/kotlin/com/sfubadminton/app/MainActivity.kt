package com.sfubadminton.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import com.sfubadminton.app.ui.AppRoot
import com.sfubadminton.app.ui.theme.AppTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val container = (application as BadmintonApp).container
        setContent {
            AppTheme {
                AppRoot(container)
            }
        }
    }
}
