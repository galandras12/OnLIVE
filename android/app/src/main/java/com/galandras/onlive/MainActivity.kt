package com.galandras.onlive

import android.Manifest
import android.app.PictureInPictureParams
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Bundle
import android.util.Rational
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import com.galandras.onlive.settings.AppSettings
import com.galandras.onlive.settings.CaptureSource
import com.galandras.onlive.stream.ConnectionState
import com.galandras.onlive.stream.StreamBus
import com.galandras.onlive.stream.StreamService
import com.galandras.onlive.ui.OnLiveScreen
import com.galandras.onlive.util.BackgroundPermissions
import kotlinx.coroutines.launch

/**
 * Az EGYETLEN dolga a UI.
 *
 * Sem a capture, sem a kódolás, sem a publish nem itt fut — mindezt a
 * [StreamService] végzi. Ez az Activity bármikor megállhat, elforgatható,
 * PIP-be tehető vagy elpusztítható: az adás megy tovább.
 */
class MainActivity : ComponentActivity() {

    private lateinit var appSettings: AppSettings

    private var inPipMode by mutableStateOf(false)
    private var showBatteryPrompt by mutableStateOf(false)
    private var showOemPrompt by mutableStateOf(false)

    private val permissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { granted ->
        if (granted[Manifest.permission.CAMERA] == true &&
            granted[Manifest.permission.RECORD_AUDIO] == true
        ) {
            maybePromptBackgroundPermissions()
            // Most már van kameránk — induljon a kép, ne csak adásindításkor.
            startPreview()
        }
    }

    /** Képernyő-megosztási hozzájárulás. A tokent a Service kapja meg. */
    private val projectionLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val data = result.data
        if (result.resultCode == RESULT_OK && data != null) {
            StreamService.send(this, StreamService.ACTION_SET_SOURCE) {
                putExtra(StreamService.EXTRA_SOURCE, CaptureSource.SCREEN.name)
                putExtra(StreamService.EXTRA_RESULT_CODE, result.resultCode)
                putExtra(StreamService.EXTRA_PROJECTION_DATA, data)
            }
        } else {
            StreamBus.setMessage("A képernyő-megosztás engedélyezése elmaradt.")
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        appSettings = AppSettings(applicationContext)

        requestRuntimePermissions()

        setContent {
            OnLiveScreen(
                appSettings = appSettings,
                inPipMode = inPipMode,
                showBatteryPrompt = showBatteryPrompt,
                showOemPrompt = showOemPrompt,
                onStart = ::startStreaming,
                onStop = { StreamService.send(this, StreamService.ACTION_STOP) },
                onPause = { StreamService.send(this, StreamService.ACTION_PAUSE) },
                onResume = { StreamService.send(this, StreamService.ACTION_RESUME) },
                onSelectSource = ::selectSource,
                onSelectLens = { lens ->
                    StreamService.send(this, StreamService.ACTION_SWITCH_LENS) {
                        putExtra(StreamService.EXTRA_LENS, lens.name)
                    }
                },
                onToggleTorch = { on ->
                    StreamService.send(this, StreamService.ACTION_TOGGLE_TORCH) {
                        putExtra(StreamService.EXTRA_TORCH_ON, on)
                    }
                },
                onTakePhoto = { StreamService.send(this, StreamService.ACTION_TAKE_PHOTO) },
                onToggleRecording = { StreamService.send(this, StreamService.ACTION_TOGGLE_RECORDING) },
                onSettingsChanged = { StreamService.send(this, StreamService.ACTION_APPLY_SETTINGS) },
                onBatteryPromptResult = ::onBatteryPromptResult,
                onOemPromptResult = ::onOemPromptResult,
            )
        }
    }

    // -----------------------------------------------------------------------
    // Vezérlés
    // -----------------------------------------------------------------------

    private fun startStreaming() {
        if (!hasCapturePermissions()) {
            requestRuntimePermissions()
            return
        }
        lifecycleScope.launch {
            val settings = appSettings.current()
            if (settings.source == CaptureSource.SCREEN) {
                requestProjectionThenStart()
            } else {
                StreamService.send(this@MainActivity, StreamService.ACTION_START)
            }
        }
    }

    private fun selectSource(source: CaptureSource) {
        if (source == CaptureSource.SCREEN) {
            requestProjection()
        } else {
            StreamService.send(this, StreamService.ACTION_SET_SOURCE) {
                putExtra(StreamService.EXTRA_SOURCE, CaptureSource.CAMERA.name)
            }
        }
    }

    private fun requestProjection() {
        val manager = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        projectionLauncher.launch(manager.createScreenCaptureIntent())
    }

    private fun requestProjectionThenStart() {
        // A Service a SET_SOURCE-ban kapott tokent eltárolja, és a START
        // ugyanazt használja — így a sorrend (FGS → getMediaProjection) marad.
        requestProjection()
        StreamService.send(this, StreamService.ACTION_START)
    }

    // -----------------------------------------------------------------------
    // Engedélyek
    // -----------------------------------------------------------------------

    private fun hasCapturePermissions(): Boolean =
        ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) ==
            PackageManager.PERMISSION_GRANTED &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) ==
            PackageManager.PERMISSION_GRANTED

    private fun requestRuntimePermissions() {
        val needed = mutableListOf(Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            needed += Manifest.permission.POST_NOTIFICATIONS
        }
        val missing = needed.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }
        if (missing.isEmpty()) maybePromptBackgroundPermissions() else permissionLauncher.launch(missing.toTypedArray())
    }

    /**
     * A háttérfutás két rétege. A Foreground Service önmagában NEM elég:
     * a Doze és a gyártói „alvó appok" kezelés is le tudja állítani a streamet.
     */
    private fun maybePromptBackgroundPermissions() {
        if (!BackgroundPermissions.isIgnoringBatteryOptimizations(this)) {
            showBatteryPrompt = true
            return
        }
        lifecycleScope.launch {
            val settings = appSettings.current()
            if (BackgroundPermissions.isSamsung() && !settings.oemGuideDismissed) {
                showOemPrompt = true
            }
        }
    }

    private fun onBatteryPromptResult(accepted: Boolean) {
        showBatteryPrompt = false
        if (accepted) BackgroundPermissions.requestIgnoreBatteryOptimizations(this)
        lifecycleScope.launch {
            val settings = appSettings.current()
            if (BackgroundPermissions.isSamsung() && !settings.oemGuideDismissed) {
                showOemPrompt = true
            }
        }
    }

    private fun onOemPromptResult(openSettings: Boolean, dontAskAgain: Boolean) {
        showOemPrompt = false
        if (openSettings) BackgroundPermissions.openOemBatterySettings(this)
        if (dontAskAgain) lifecycleScope.launch { appSettings.dismissOemGuide() }
    }

    // -----------------------------------------------------------------------
    // Picture-in-Picture
    //
    // FONTOS: a PIP KÉNYELMI funkció, nem a háttérfutás védelme. Az adás
    // folytonosságát a Foreground Service + wakelock + akku-kizárás adja;
    // a PIP csak annyit tesz hozzá, hogy appváltás után is látod a képet.
    // -----------------------------------------------------------------------

    /**
     * Kamera-előnézet, amíg az app látszik (1.0.013).
     *
     * A capture a Service-ben él, hogy az adás túlélje az appváltást — de ettől
     * még az app megnyitásakor is kell kép. Enélkül a felület fekete marad, és
     * a lencseváltás sem csinál semmit, mert nincs bekötött kamera.
     */
    override fun onStart() {
        super.onStart()
        startPreview()
    }

    /**
     * Az app eltűnt. Ha megy az adás, a Service ezt figyelmen kívül hagyja és
     * tovább streamel; ha nem, elengedi a kamerát — nem tartunk fenn kamerát és
     * értesítést azért, mert egyszer megnyitották az appot.
     */
    override fun onStop() {
        super.onStop()
        if (!isChangingConfigurations) {
            StreamService.send(this, StreamService.ACTION_PREVIEW_STOP)
        }
    }

    private fun startPreview() {
        val granted = ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) ==
            PackageManager.PERMISSION_GRANTED
        if (!granted) return

        StreamService.send(this, StreamService.ACTION_PREVIEW)
    }

    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        if (shouldEnterPip()) {
            runCatching { enterPictureInPictureMode(pipParams()) }
        }
    }

    override fun onPictureInPictureModeChanged(
        isInPictureInPictureMode: Boolean,
        newConfig: Configuration,
    ) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)
        inPipMode = isInPictureInPictureMode
    }

    private fun shouldEnterPip(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return false
        if (!packageManager.hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)) return false
        return StreamBus.state.value.connection in setOf(
            ConnectionState.LIVE,
            ConnectionState.CONNECTING,
            ConnectionState.RECONNECTING,
            ConnectionState.PAUSED,
        )
    }

    private fun pipParams(): PictureInPictureParams =
        PictureInPictureParams.Builder()
            .setAspectRatio(Rational(9, 16))
            .apply {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) setAutoEnterEnabled(true)
            }
            .build()

    // -----------------------------------------------------------------------

    override fun onDestroy() {
        // A preview felület az Activityé — a kamera-session a Service-é, ezért
        // itt CSAK leválasztunk, nem állítunk le semmit.
        StreamBus.attachPreview(null)
        super.onDestroy()
    }
}
