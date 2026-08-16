package com.galandras.onlive.ui

import androidx.camera.view.PreviewView
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Cameraswitch
import androidx.compose.material.icons.filled.FiberManualRecord
import androidx.compose.material.icons.filled.FlashOff
import androidx.compose.material.icons.filled.FlashOn
import androidx.compose.material.icons.filled.PhotoCamera
import androidx.compose.material.icons.automirrored.filled.ScreenShare
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Videocam
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import com.galandras.onlive.settings.AppSettings
import com.galandras.onlive.settings.CaptureSource
import com.galandras.onlive.settings.LensKind
import com.galandras.onlive.settings.Settings
import com.galandras.onlive.stream.ConnectionState
import com.galandras.onlive.stream.StreamBus

@Composable
fun OnLiveScreen(
    appSettings: AppSettings,
    inPipMode: Boolean,
    showBatteryPrompt: Boolean,
    showOemPrompt: Boolean,
    onStart: () -> Unit,
    onStop: () -> Unit,
    onPause: () -> Unit,
    onResume: () -> Unit,
    onSelectSource: (CaptureSource) -> Unit,
    onSelectLens: (LensKind) -> Unit,
    onToggleTorch: (Boolean) -> Unit,
    onTakePhoto: () -> Unit,
    onToggleRecording: () -> Unit,
    onSettingsChanged: () -> Unit,
    onBatteryPromptResult: (Boolean) -> Unit,
    onOemPromptResult: (Boolean, Boolean) -> Unit,
) {
    val state by StreamBus.state.collectAsState()
    val settings by appSettings.flow.collectAsState(initial = Settings())
    var showSettings by remember { mutableStateOf(false) }

    MaterialTheme(colorScheme = darkColorScheme()) {
        Surface(color = Bg, modifier = Modifier.fillMaxSize()) {
            Box(Modifier.fillMaxSize()) {

                CameraPreview(Modifier.fillMaxSize())

                // PIP-ben csak a kép látszik, vezérlők nélkül.
                if (!inPipMode) {
                    Column(
                        modifier = Modifier
                            .fillMaxSize()
                            .padding(16.dp),
                        verticalArrangement = Arrangement.SpaceBetween,
                    ) {
                        StatusBar(
                            state = state.connection,
                            detail = statusDetail(state.connection, state.stats.videoBitrateKbps, state.stats.fps, state.stats.rttMs, state.nextRetryInSeconds, state.reconnectAttempt),
                            recording = state.localRecording,
                            onSettings = { showSettings = true },
                        )

                        Column {
                            state.message?.let { message ->
                                Card(Modifier.fillMaxWidth().padding(bottom = 8.dp)) {
                                    Text(message, Modifier.padding(12.dp), fontSize = 13.sp)
                                }
                            }
                            state.errorMessage?.let { error ->
                                Card(Modifier.fillMaxWidth().padding(bottom = 8.dp)) {
                                    Text(error, Modifier.padding(12.dp), color = Live, fontSize = 13.sp)
                                }
                            }

                            QuickActions(
                                torchOn = state.torchOn,
                                recording = state.localRecording,
                                onToggleTorch = onToggleTorch,
                                onTakePhoto = onTakePhoto,
                                onToggleRecording = onToggleRecording,
                            )

                            Spacer(Modifier.height(12.dp))

                            SourceAndLensRow(
                                source = state.source,
                                lens = state.lens,
                                availableLenses = state.availableLenses.map { it.kind },
                                onSelectSource = onSelectSource,
                                onSelectLens = onSelectLens,
                            )

                            Spacer(Modifier.height(12.dp))

                            MainControls(
                                state = state.connection,
                                onStart = onStart,
                                onStop = onStop,
                                onPause = onPause,
                                onResume = onResume,
                            )
                        }
                    }
                }
            }
        }

        // A fogaskerék teljes képernyős beállításokra visz (1.0.010): ott van a
        // streamkulcs és a Cloudflare Tunnel címe is, amikhez egy párbeszédablak
        // szűk volt. Az adás ettől nem szakad meg — a capture a Service-ben fut.
        if (showSettings) {
            SettingsScreen(
                settings = settings,
                appSettings = appSettings,
                onApply = onSettingsChanged,
                onClose = { showSettings = false },
            )
        }

        if (showBatteryPrompt) {
            BatteryDialog(onResult = onBatteryPromptResult)
        }

        if (showOemPrompt) {
            OemDialog(onResult = onOemPromptResult)
        }
    }
}

/**
 * A kamera képe. A [PreviewView] felületét a [StreamBus]-on keresztül kapja meg
 * a Service — az Activity csak „kölcsönadja" a felületet, a kamera-session nem
 * ide tartozik.
 */
@Composable
private fun CameraPreview(modifier: Modifier = Modifier) {
    AndroidView(
        modifier = modifier,
        factory = { context ->
            PreviewView(context).apply {
                scaleType = PreviewView.ScaleType.FILL_CENTER
                implementationMode = PreviewView.ImplementationMode.COMPATIBLE
                StreamBus.attachPreview(surfaceProvider)
            }
        },
    )
    // A leválasztás (attachPreview(null)) az Activity onDestroy-ában történik.
}

@Composable
private fun StatusBar(
    state: ConnectionState,
    detail: String,
    recording: Boolean,
    onSettings: () -> Unit,
) {
    val (label, color) = when (state) {
        ConnectionState.IDLE -> "Készenlét" to Color.Gray
        ConnectionState.CONNECTING -> "Csatlakozás…" to Warn
        ConnectionState.LIVE -> "ÉLŐ" to Live
        ConnectionState.RECONNECTING -> "Újracsatlakozás…" to Warn
        ConnectionState.PAUSED -> "Szüneteltetve" to Warn
        ConnectionState.ERROR -> "Hiba" to Live
    }

    Row(
        Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(
                Modifier
                    .size(10.dp)
                    .background(color, RoundedCornerShape(50)),
            )
            Spacer(Modifier.size(8.dp))
            Column {
                Text(label, color = Color.White, fontWeight = FontWeight.Bold, fontSize = 16.sp)
                if (detail.isNotBlank()) {
                    Text(detail, color = Color(0xFF9CA3AF), fontSize = 12.sp)
                }
            }
            if (recording) {
                Spacer(Modifier.size(10.dp))
                Icon(Icons.Default.FiberManualRecord, contentDescription = "Helyi felvétel", tint = Live)
            }
        }

        IconButton(onClick = onSettings) {
            Icon(Icons.Default.Settings, contentDescription = "Beállítások", tint = Color.White)
        }
    }
}

@Composable
private fun QuickActions(
    torchOn: Boolean,
    recording: Boolean,
    onToggleTorch: (Boolean) -> Unit,
    onTakePhoto: () -> Unit,
    onToggleRecording: () -> Unit,
) {
    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        FilledIconButton(onClick = { onToggleTorch(!torchOn) }) {
            Icon(
                if (torchOn) Icons.Default.FlashOn else Icons.Default.FlashOff,
                contentDescription = "Vaku",
            )
        }
        FilledIconButton(onClick = onTakePhoto) {
            Icon(Icons.Default.PhotoCamera, contentDescription = "Kép mentése")
        }
        FilledIconButton(
            onClick = onToggleRecording,
            colors = if (recording) {
                androidx.compose.material3.IconButtonDefaults.filledIconButtonColors(containerColor = Live)
            } else {
                androidx.compose.material3.IconButtonDefaults.filledIconButtonColors()
            },
        ) {
            Icon(Icons.Default.Videocam, contentDescription = "Helyi felvétel")
        }
    }
}

@Composable
private fun SourceAndLensRow(
    source: CaptureSource,
    lens: LensKind,
    availableLenses: List<LensKind>,
    onSelectSource: (CaptureSource) -> Unit,
    onSelectLens: (LensKind) -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            AssistChip(
                onClick = {
                    onSelectSource(
                        if (source == CaptureSource.CAMERA) CaptureSource.SCREEN else CaptureSource.CAMERA
                    )
                },
                label = { Text(if (source == CaptureSource.CAMERA) "Kamera" else "Képernyő") },
                leadingIcon = {
                    Icon(
                        if (source == CaptureSource.CAMERA) Icons.Default.Cameraswitch else Icons.AutoMirrored.Filled.ScreenShare,
                        contentDescription = null,
                    )
                },
            )
        }

        if (source == CaptureSource.CAMERA && availableLenses.isNotEmpty()) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                availableLenses.forEach { kind ->
                    FilterChip(
                        selected = kind == lens,
                        onClick = { onSelectLens(kind) },
                        label = { Text(kind.label) },
                    )
                }
            }
        }
    }
}

@Composable
private fun MainControls(
    state: ConnectionState,
    onStart: () -> Unit,
    onStop: () -> Unit,
    onPause: () -> Unit,
    onResume: () -> Unit,
) {
    val active = state != ConnectionState.IDLE && state != ConnectionState.ERROR

    Row(
        Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        if (!active) {
            Button(
                onClick = onStart,
                modifier = Modifier.weight(1f).height(56.dp),
                colors = ButtonDefaults.buttonColors(containerColor = Live),
            ) { Text("Kezdés", fontSize = 18.sp, fontWeight = FontWeight.Bold) }
        } else {
            OutlinedButton(
                onClick = if (state == ConnectionState.PAUSED) onResume else onPause,
                modifier = Modifier.weight(1f).height(56.dp),
            ) {
                Text(if (state == ConnectionState.PAUSED) "Folytatás" else "Szünet", fontSize = 16.sp)
            }
            Button(
                onClick = onStop,
                modifier = Modifier.weight(1f).height(56.dp),
                colors = ButtonDefaults.buttonColors(containerColor = Live),
            ) { Text("Befejezés", fontSize = 16.sp, fontWeight = FontWeight.Bold) }
        }
    }
}

@Composable
private fun BatteryDialog(onResult: (Boolean) -> Unit) {
    AlertDialog(
        onDismissRequest = { onResult(false) },
        title = { Text("Akkumulátor-optimalizálás") },
        text = {
            Text(
                "Ahhoz, hogy a közvetítés háttérben és kikapcsolt képernyővel se " +
                    "szakadjon meg, az OnLIVE-ot ki kell venni az akkumulátor-optimalizálás alól."
            )
        },
        confirmButton = { TextButton(onClick = { onResult(true) }) { Text("Beállítom") } },
        dismissButton = { TextButton(onClick = { onResult(false) }) { Text("Később") } },
    )
}

@Composable
private fun OemDialog(onResult: (Boolean, Boolean) -> Unit) {
    AlertDialog(
        onDismissRequest = { onResult(false, false) },
        title = { Text("Samsung háttérkorlátozás") },
        text = {
            Text(
                "A Samsung One UI a rendszerszintű beállítás felett saját „Alvó alkalmazások” " +
                    "listát is használ. Nyisd meg a Beállítások → Akkumulátor → " +
                    "Háttérhasználat-korlátozások oldalt, és vedd fel az OnLIVE-ot a " +
                    "„Sosem alszik” listára. Enélkül a közvetítés percek alatt leállhat, " +
                    "még helyes Foreground Service mellett is."
            )
        },
        confirmButton = { TextButton(onClick = { onResult(true, false) }) { Text("Beállítások megnyitása") } },
        dismissButton = { TextButton(onClick = { onResult(false, true) }) { Text("Ne kérdezd újra") } },
    )
}

private fun statusDetail(
    state: ConnectionState,
    videoKbps: Int,
    fps: Int,
    rttMs: Int,
    retryIn: Int,
    attempt: Int,
): String = when (state) {
    ConnectionState.LIVE -> "$videoKbps kbps · $fps fps · $rttMs ms"
    ConnectionState.RECONNECTING -> "Újra $retryIn mp múlva (#$attempt)"
    ConnectionState.PAUSED -> "Szándékos szünet — nincs automatikus visszatérés"
    else -> ""
}
