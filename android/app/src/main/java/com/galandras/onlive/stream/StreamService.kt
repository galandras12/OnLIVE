package com.galandras.onlive.stream

import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.PowerManager
import android.util.Log
import androidx.core.app.ServiceCompat
import androidx.lifecycle.LifecycleService
import androidx.lifecycle.lifecycleScope
import com.galandras.onlive.net.ControlApi
import com.galandras.onlive.net.RemoteCommand
import com.galandras.onlive.settings.AppSettings
import com.galandras.onlive.settings.AudioBitrate
import com.galandras.onlive.settings.AudioSampleRate
import com.galandras.onlive.settings.CaptureSource
import com.galandras.onlive.settings.FrameRate
import com.galandras.onlive.settings.LensKind
import com.galandras.onlive.settings.Settings
import com.galandras.onlive.settings.VideoResolution
import com.galandras.onlive.util.Notifications
import com.galandras.onlive.util.TorchController
import com.galandras.onlive.webrtc.RtcEngine
import com.galandras.onlive.webrtc.WhipClient
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.webrtc.PeerConnection
import kotlin.math.min
import kotlin.random.Random

/**
 * Az OnLIVE capture/kódolás/publish motorja.
 *
 * MIÉRT SERVICE ÉS NEM ACTIVITY (a 2. szegmens kritikus pontja):
 * ha a stream logika az Activity `onPause()/onStop()` ciklusához kötődne,
 * appváltáskor azonnal leállna. Itt az Activity CSAK a UI-t adja: jöhet-mehet,
 * elforgatható, PIP-be tehető, meg is ölheti a rendszer — a capture és a
 * publish ettől függetlenül fut tovább.
 *
 * A [LifecycleService] azért kell, mert a CameraX `bindToLifecycle()`-höz
 * LifecycleOwner szükséges, és ez a Service saját, a Service élettartamához
 * kötött lifecycle-ja — nem az Activityé.
 */
class StreamService : LifecycleService() {

    private lateinit var appSettings: AppSettings
    private lateinit var fanout: FrameFanout
    private lateinit var controlApi: ControlApi
    private lateinit var torchController: TorchController

    private var engine: RtcEngine? = null
    private var cameraSource: CameraSource? = null
    private var screenSource: ScreenSource? = null

    private var wakeLock: PowerManager.WakeLock? = null

    private var connectJob: Job? = null
    private var statsJob: Job? = null

    /** A felhasználó szándéka. Amíg igaz, minden szakadás után újracsatlakozunk. */
    private var userWantsLive = false
    private var paused = false
    private var currentSource = CaptureSource.CAMERA
    private var screenPermission: Pair<Int, Intent>? = null

    override fun onCreate() {
        super.onCreate()
        appSettings = AppSettings(applicationContext)
        fanout = FrameFanout()
        controlApi = ControlApi()
        torchController = TorchController(applicationContext)

        Notifications.ensureChannel(this)

        // Az Activity ide teszi be a preview felületét, ha van látható UI.
        // A kamera-session ettől teljesen független.
        lifecycleScope.launch {
            StreamBus.surfaceProvider.collect { provider ->
                cameraSource?.setSurfaceProvider(provider)
            }
        }

        // Állapotváltozás → notification frissítés (ez látszik appváltás után is).
        lifecycleScope.launch {
            StreamBus.state.collect { state -> refreshNotification(state) }
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        super.onStartCommand(intent, flags, startId)

        // A startForegroundService() után 5 másodpercen belül kötelező a
        // startForeground() — ezért ez az ELSŐ dolgunk, minden suspend munka előtt.
        promoteToForeground(currentSource)

        when (intent?.action) {
            ACTION_START -> handleStart(intent)
            ACTION_STOP -> handleStop()
            ACTION_PAUSE -> handlePause()
            ACTION_RESUME -> handleResume()
            ACTION_SET_SOURCE -> handleSetSource(intent)
            ACTION_SWITCH_LENS -> handleSwitchLens(intent)
            ACTION_TOGGLE_TORCH -> handleTorch(intent)
            ACTION_TAKE_PHOTO -> handlePhoto()
            ACTION_TOGGLE_RECORDING -> handleToggleRecording()
            ACTION_APPLY_SETTINGS -> handleApplySettings()
            else -> Unit
        }

        return START_STICKY
    }

    // -----------------------------------------------------------------------
    // Session-vezérlés
    // -----------------------------------------------------------------------

    private fun handleStart(intent: Intent) = lifecycleScope.launch {
        if (userWantsLive) return@launch
        userWantsLive = true
        paused = false

        val settings = appSettings.current()
        currentSource = settings.source

        (intent.getParcelableExtraCompat<Intent>(EXTRA_PROJECTION_DATA))?.let { data ->
            screenPermission = intent.getIntExtra(EXTRA_RESULT_CODE, 0) to data
        }

        acquireWakeLock()
        ensureEngine(settings)
        startCapture(settings)

        // Az app itt CSAK annyit mond: "elkezdtem". Hogy ebből intro lesz-e,
        // azt kizárólag a szerver állapotgépe dönti el (4. szegmens).
        controlApi.sessionStart(settings)

        connectWithRetry(settings)
    }

    private fun handleStop() = lifecycleScope.launch {
        userWantsLive = false
        paused = false
        connectJob?.cancel()
        statsJob?.cancel()

        val settings = appSettings.current()
        engine?.close(sendDelete = true, streamKey = settings.streamKey)

        stopCapture()
        releaseWakeLock()

        // A Befejezés indítja az outro logikát a szerveren.
        controlApi.sessionEnd(settings)

        StreamBus.setConnection(ConnectionState.IDLE)
        StreamBus.update { it.copy(stats = StreamStats(), torchOn = false) }

        ServiceCompat.stopForeground(this@StreamService, ServiceCompat.STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    /**
     * Szándékos szünet. A capture TOVÁBB FUT (marad a preview, marad a helyi
     * felvétel), csak a publish áll le, és NINCS újracsatlakozási backoff —
     * pontosan ez különbözteti meg a szakadástól. A szerver a `paused`
     * állapotban ugyanazt a „Megszakadt" képernyőt mutatja, de nem vár
     * automatikus visszatérést.
     */
    private fun handlePause() = lifecycleScope.launch {
        if (!userWantsLive || paused) return@launch
        paused = true
        connectJob?.cancel()
        statsJob?.cancel()

        val settings = appSettings.current()
        engine?.close(sendDelete = true, streamKey = settings.streamKey)

        StreamBus.setConnection(ConnectionState.PAUSED)
        controlApi.sessionPause(settings)
    }

    private fun handleResume() = lifecycleScope.launch {
        if (!userWantsLive || !paused) return@launch
        paused = false

        val settings = appSettings.current()
        ensureEngine(settings)
        controlApi.sessionResume(settings)
        connectWithRetry(settings)
    }

    /**
     * Újracsatlakozás exponenciális backoff-fal.
     *
     * Addig próbálkozik, amíg vagy helyreáll a kapcsolat, vagy a felhasználó
     * explicit „Befejezés"-t nyom. Kivétel: ha a szerver a streamkulcsot
     * utasítja el, nincs értelme próbálkozni — az ERROR állapot végleges.
     */
    private fun connectWithRetry(settings: Settings) {
        connectJob?.cancel()
        connectJob = lifecycleScope.launch {
            var attempt = 0

            while (userWantsLive && !paused) {
                StreamBus.setConnection(
                    if (attempt == 0) ConnectionState.CONNECTING else ConnectionState.RECONNECTING
                )

                val result = runCatching { engine?.publish(settings) }

                if (result.isSuccess) {
                    StreamBus.setConnection(ConnectionState.LIVE)
                    StreamBus.update { it.copy(reconnectAttempt = 0, nextRetryInSeconds = 0) }
                    startStatsLoop(settings)
                    return@launch
                }

                val error = result.exceptionOrNull()
                if (error is WhipClient.FatalWhipException) {
                    Log.e(TAG, "Végleges WHIP hiba: ${error.message}")
                    userWantsLive = false
                    StreamBus.setConnection(ConnectionState.ERROR, error.message)
                    releaseWakeLock()
                    return@launch
                }

                attempt++
                val backoffMs = backoffMillis(attempt)
                Log.w(TAG, "Csatlakozás sikertelen (#$attempt): ${error?.message}; újra ${backoffMs}ms múlva")

                StreamBus.update {
                    it.copy(
                        connection = ConnectionState.RECONNECTING,
                        reconnectAttempt = attempt,
                        nextRetryInSeconds = (backoffMs / 1000).toInt(),
                    )
                }

                // Visszaszámláló, hogy a UI-n látszódjon a következő próbálkozás.
                var remaining = backoffMs
                while (remaining > 0 && userWantsLive && !paused) {
                    val step = min(1000L, remaining)
                    delay(step)
                    remaining -= step
                    StreamBus.update { it.copy(nextRetryInSeconds = (remaining / 1000).toInt()) }
                }
            }
        }
    }

    /** 1s → 2s → 4s → 8s → 16s → 30s (plafon), ±20% jitterrel. */
    private fun backoffMillis(attempt: Int): Long {
        val base = min(BACKOFF_MAX_MS, BACKOFF_BASE_MS shl (attempt - 1).coerceIn(0, 10))
        val jitter = (base * 0.2 * (Random.nextDouble() * 2 - 1)).toLong()
        return (base + jitter).coerceAtLeast(500L)
    }

    private fun startStatsLoop(settings: Settings) {
        statsJob?.cancel()
        statsJob = lifecycleScope.launch {
            while (userWantsLive && !paused) {
                delay(STATS_INTERVAL_MS)
                val stats = engine?.collectStats() ?: continue
                StreamBus.update { it.copy(stats = stats) }
                controlApi
                    .sessionStats(settings, stats, StreamBus.state.value.connection.name.lowercase())
                    .onSuccess { commands -> commands.forEach { handleRemoteCommand(it) } }
            }
        }
    }

    // -----------------------------------------------------------------------
    // Capture-források
    // -----------------------------------------------------------------------

    private suspend fun startCapture(settings: Settings) {
        when (currentSource) {
            CaptureSource.CAMERA -> startCameraCapture(settings)
            CaptureSource.SCREEN -> startScreenCapture(settings)
        }
        StreamBus.update { it.copy(source = currentSource) }
    }

    private suspend fun startCameraCapture(settings: Settings) {
        screenSource?.stop()
        promoteToForeground(CaptureSource.CAMERA)

        val source = cameraSource ?: CameraSource(applicationContext, this, fanout).also {
            cameraSource = it
        }
        source.setSurfaceProvider(StreamBus.surfaceProvider.value)
        source.start(settings)
    }

    private fun startScreenCapture(settings: Settings) {
        val permission = screenPermission ?: run {
            StreamBus.setMessage("Hiányzik a képernyő-megosztási engedély.")
            return
        }

        lifecycleScope.launch { cameraSource?.stop() }

        // KRITIKUS SORREND (Android 14+): előbb mediaProjection típusú
        // foreground service, csak UTÁNA getMediaProjection().
        promoteToForeground(CaptureSource.SCREEN)

        val source = screenSource ?: ScreenSource(applicationContext, requireEngine().eglBase, fanout).also {
            it.onProjectionStopped = { handleSetSource(sourceIntent(CaptureSource.CAMERA)) }
            screenSource = it
        }
        source.start(permission.second, permission.first, settings)
    }

    private suspend fun stopCapture() {
        cameraSource?.stop()
        screenSource?.stop()
        fanout.clear()
    }

    private fun handleSetSource(intent: Intent) = lifecycleScope.launch {
        val requested = if (intent.getStringExtra(EXTRA_SOURCE) == CaptureSource.SCREEN.name) {
            CaptureSource.SCREEN
        } else {
            CaptureSource.CAMERA
        }

        intent.getParcelableExtraCompat<Intent>(EXTRA_PROJECTION_DATA)?.let { data ->
            screenPermission = intent.getIntExtra(EXTRA_RESULT_CODE, 0) to data
        }

        if (requested == currentSource) return@launch
        currentSource = requested
        appSettings.setSource(requested)

        val settings = appSettings.current()
        startCapture(settings)

        // A forrásváltás NEM igényel WebRTC újratárgyalást: ugyanabba a
        // VideoSource-ba tolja a képet a másik capturer.
        controlApi.sessionConfig(settings)
    }

    private fun handleSwitchLens(intent: Intent) = lifecycleScope.launch {
        val lens = LensKind.fromName(intent.getStringExtra(EXTRA_LENS))
        appSettings.setLens(lens)
        val settings = appSettings.current()

        if (currentSource == CaptureSource.CAMERA) {
            cameraSource?.switchLens(settings, lens)
        }
        controlApi.sessionConfig(settings)
    }

    /** Menet közbeni minőség-változtatás — újratárgyalás nélkül. */
    private fun handleApplySettings() = lifecycleScope.launch {
        val settings = appSettings.current()
        engine?.applyVideoBitrate(settings.videoBitrateKbps)
        engine?.adaptOutput(
            settings.resolution.width,
            settings.resolution.height,
            settings.frameRate.fps,
        )
        if (currentSource == CaptureSource.CAMERA && cameraSource?.isRunning == true) {
            cameraSource?.start(settings)
        }
        controlApi.sessionConfig(settings)
    }

    // -----------------------------------------------------------------------
    // Kiegészítő funkciók
    // -----------------------------------------------------------------------

    private fun handleTorch(intent: Intent) {
        val on = intent.getBooleanExtra(EXTRA_TORCH_ON, !StreamBus.state.value.torchOn)
        val handled = cameraSource?.takeIf { it.isRunning }?.setTorch(on)
            ?: torchController.setTorch(on)

        if (handled != false) {
            StreamBus.update { it.copy(torchOn = on) }
        } else {
            StreamBus.setMessage("A vaku most nem érhető el.")
        }
    }

    private fun handlePhoto() = lifecycleScope.launch {
        val frame = fanout.acquireLastFrame() ?: run {
            StreamBus.setMessage("Nincs elmenthető képkocka.")
            return@launch
        }
        try {
            PhotoSaver.save(applicationContext, frame)
                .onSuccess { StreamBus.setMessage("Kép mentve: $it") }
                .onFailure { StreamBus.setMessage("A kép mentése nem sikerült: ${it.message}") }
        } finally {
            frame.release()
        }
    }

    private fun handleToggleRecording() = lifecycleScope.launch {
        val settings = appSettings.current()
        val recording = StreamBus.state.value.localRecording
        // Élő adás közben a mikrofont a WebRTC tartja, ezért a helyi felvétel
        // ilyenkor kép-only. Adás nélkül viszont hanggal rögzítünk.
        val withAudio = !userWantsLive

        if (recording) {
            when (currentSource) {
                CaptureSource.CAMERA -> cameraSource?.stopLocalRecording()
                CaptureSource.SCREEN -> screenSource?.stopLocalRecording()
            }
            return@launch
        }

        val result = when (currentSource) {
            CaptureSource.CAMERA -> cameraSource?.startLocalRecording(withAudio)
            CaptureSource.SCREEN -> screenSource?.startLocalRecording(settings, withAudio)
        }
        result?.onFailure { StreamBus.setMessage(it.message) }
    }

    // -----------------------------------------------------------------------
    // Távoli parancsok a web UI-ról (8. szegmens)
    // -----------------------------------------------------------------------

    /**
     * A vezérlő szervertől kapott parancs végrehajtása.
     *
     * Ugyanazokat a belső kezelőket hívja, mint a telefon gombjai — így a két
     * felület garantáltan ugyanazt csinálja. Az adás állapotát továbbra is a
     * szerver állapotgépe dönti el; ez csak a KÉSZÜLÉK oldali végrehajtás.
     *
     * Miért kell: ha az admin a weben nyomja meg a „Befejezés"-t, az app enélkül
     * tovább publikálna és „ÉLŐ"-t mutatna egy már lezárt adás alatt.
     */
    private fun handleRemoteCommand(command: RemoteCommand) {
        Log.i(TAG, "Távoli parancs: ${command.type}")

        when (command.type) {
            RemoteCommand.START -> handleStart(Intent())
            RemoteCommand.PAUSE -> handlePause()
            RemoteCommand.RESUME -> handleResume()
            RemoteCommand.STOP -> handleStop()

            RemoteCommand.SET_LENS -> {
                val lens = command.payload.optString("lens").uppercase()
                handleSwitchLens(Intent().putExtra(EXTRA_LENS, lens))
            }

            RemoteCommand.SET_SOURCE -> {
                val source = command.payload.optString("source")
                if (source.equals("screen", ignoreCase = true)) {
                    // Az Android képernyő-megosztáshoz felhasználói hozzájárulást
                    // követel, amit távolról nem lehet megkerülni: ha nincs
                    // korábbi engedélyünk, jelezzük, hogy a telefonon kell
                    // megerősíteni.
                    if (screenPermission == null) {
                        StreamBus.setMessage(
                            "A vezérlő képernyő-megosztást kért — erősítsd meg a telefonon.",
                        )
                    } else {
                        handleSetSource(sourceIntent(CaptureSource.SCREEN))
                    }
                } else {
                    handleSetSource(sourceIntent(CaptureSource.CAMERA))
                }
            }

            RemoteCommand.SET_QUALITY -> lifecycleScope.launch {
                val payload = command.payload
                payload.optString("resolution").takeIf { it.isNotBlank() }?.let {
                    appSettings.setResolution(VideoResolution.fromName(it))
                }
                payload.optInt("fps", 0).takeIf { it > 0 }?.let {
                    appSettings.setFrameRate(FrameRate.fromFps(it))
                }
                payload.optInt("videoBitrateKbps", 0).takeIf { it > 0 }?.let {
                    appSettings.setVideoBitrate(it)
                }
                payload.optInt("audioSampleRate", 0).takeIf { it > 0 }?.let {
                    appSettings.setAudioSampleRate(AudioSampleRate.fromHz(it))
                }
                payload.optInt("audioBitrateKbps", 0).takeIf { it > 0 }?.let {
                    appSettings.setAudioBitrate(AudioBitrate.fromKbps(it))
                }
                handleApplySettings()
            }

            RemoteCommand.TORCH ->
                handleTorch(Intent().putExtra(EXTRA_TORCH_ON, command.payload.optBoolean("on")))

            RemoteCommand.PHOTO -> handlePhoto()
            RemoteCommand.RECORDING -> handleToggleRecording()

            else -> Log.w(TAG, "Ismeretlen távoli parancs: ${command.type}")
        }
    }

    // -----------------------------------------------------------------------
    // Foreground service, wakelock, motor
    // -----------------------------------------------------------------------

    /**
     * Android 14 (API 34) óta a típust a `startForeground()`-nak is át kell adni,
     * és a típushoz tartozó `FOREGROUND_SERVICE_*` jogosultságnak is meg kell
     * lennie a manifestben. Csak azokat a típusokat adjuk át, amik éppen
     * aktívak — képernyő módban nem fut a kamera, ezért ott nem is kérünk
     * `camera` típust.
     */
    private fun promoteToForeground(source: CaptureSource) {
        val notification = Notifications.build(
            this,
            StreamBus.state.value.connection,
            detail = detailText(StreamBus.state.value),
            recording = StreamBus.state.value.localRecording,
        )

        val types = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            when (source) {
                CaptureSource.CAMERA ->
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA or
                        ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE

                CaptureSource.SCREEN ->
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION or
                        ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
            }
        } else {
            0
        }

        ServiceCompat.startForeground(this, Notifications.NOTIFICATION_ID, notification, types)
    }

    private fun refreshNotification(state: StreamUiState) {
        Notifications.update(
            this,
            Notifications.build(this, state.connection, detailText(state), state.localRecording),
        )
    }

    private fun detailText(state: StreamUiState): String = when (state.connection) {
        ConnectionState.LIVE ->
            "${state.stats.videoBitrateKbps} kbps · ${state.stats.fps} fps · ${state.stats.rttMs} ms"

        ConnectionState.RECONNECTING ->
            "Újrapróbálkozás ${state.nextRetryInSeconds} mp múlva (#${state.reconnectAttempt})"

        ConnectionState.ERROR -> state.errorMessage ?: "Ismeretlen hiba"
        ConnectionState.PAUSED -> "Szüneteltetve — a Folytatás gombbal indítható újra"
        else -> "OnLIVE"
    }

    /**
     * A mikrofon mintavételi frekvenciája az AudioDeviceModule-höz kötődik,
     * az pedig a PeerConnectionFactory-hoz — ezért ha a felhasználó megváltoztatta,
     * új motort kell építeni. Session közben ez nem fordulhat elő.
     */
    private suspend fun ensureEngine(settings: Settings) {
        val existing = engine
        if (existing != null && existing.sampleRateHz == settings.audioSampleRate.hz) return

        existing?.release()
        val created = RtcEngine(applicationContext, settings.audioSampleRate.hz)
        created.onConnectionStateChanged = ::onPeerConnectionStateChanged
        // A capturerObserver csak a publish után létezik, és minden
        // újracsatlakozásnál új példány — a fanout innen kapja meg.
        created.onCapturerObserverChanged = { observer -> fanout.downstream = observer }
        fanout.downstream = null
        engine = created
    }

    private fun requireEngine(): RtcEngine =
        engine ?: throw IllegalStateException("A WebRTC motor még nem áll készen.")

    /**
     * Nem szándékos szakadás: a WebRTC jelzi, hogy elveszett a kapcsolat.
     * Ha a felhasználó nem nyomott Befejezést és nincs szünet, újracsatlakozunk.
     */
    private fun onPeerConnectionStateChanged(state: PeerConnection.PeerConnectionState) {
        val lost = state == PeerConnection.PeerConnectionState.FAILED ||
            state == PeerConnection.PeerConnectionState.CLOSED ||
            state == PeerConnection.PeerConnectionState.DISCONNECTED

        if (!lost || !userWantsLive || paused) return
        if (StreamBus.state.value.connection == ConnectionState.RECONNECTING) return

        Log.w(TAG, "Kapcsolat elveszett ($state) — újracsatlakozás indul")
        lifecycleScope.launch {
            statsJob?.cancel()
            connectWithRetry(appSettings.current())
        }
    }

    private fun acquireWakeLock() {
        if (wakeLock?.isHeld == true) return
        val manager = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = manager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, WAKELOCK_TAG).apply {
            setReferenceCounted(false)
            // Kikapcsolt képernyőnél is menjen a kódolás és a hálózat.
            acquire(WAKELOCK_TIMEOUT_MS)
        }
    }

    private fun releaseWakeLock() {
        runCatching { wakeLock?.takeIf { it.isHeld }?.release() }
        wakeLock = null
    }

    private fun sourceIntent(source: CaptureSource) =
        Intent(this, StreamService::class.java)
            .setAction(ACTION_SET_SOURCE)
            .putExtra(EXTRA_SOURCE, source.name)

    override fun onDestroy() {
        connectJob?.cancel()
        statsJob?.cancel()
        releaseWakeLock()
        cameraSource?.release()
        screenSource?.stop()
        fanout.clear()
        // A motor felszabadítása blokkoló hívásokat tartalmaz, de az onDestroy
        // után már nincs coroutine scope — ezért itt szinkron zárjuk.
        engine?.let { rtc ->
            kotlinx.coroutines.runBlocking { runCatching { rtc.release() } }
        }
        engine = null
        StreamBus.setConnection(ConnectionState.IDLE)
        super.onDestroy()
    }

    @Suppress("DEPRECATION")
    private inline fun <reified T : android.os.Parcelable> Intent.getParcelableExtraCompat(key: String): T? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            getParcelableExtra(key, T::class.java)
        } else {
            getParcelableExtra(key) as? T
        }

    companion object {
        private const val TAG = "OnLIVE/Service"
        private const val WAKELOCK_TAG = "OnLIVE::StreamWakeLock"
        private const val WAKELOCK_TIMEOUT_MS = 6L * 60 * 60 * 1000 // 6 óra biztonsági plafon
        private const val BACKOFF_BASE_MS = 1_000L
        private const val BACKOFF_MAX_MS = 30_000L
        private const val STATS_INTERVAL_MS = 3_000L

        const val ACTION_START = "com.galandras.onlive.START"
        const val ACTION_STOP = "com.galandras.onlive.STOP"
        const val ACTION_PAUSE = "com.galandras.onlive.PAUSE"
        const val ACTION_RESUME = "com.galandras.onlive.RESUME"
        const val ACTION_SET_SOURCE = "com.galandras.onlive.SET_SOURCE"
        const val ACTION_SWITCH_LENS = "com.galandras.onlive.SWITCH_LENS"
        const val ACTION_TOGGLE_TORCH = "com.galandras.onlive.TOGGLE_TORCH"
        const val ACTION_TAKE_PHOTO = "com.galandras.onlive.TAKE_PHOTO"
        const val ACTION_TOGGLE_RECORDING = "com.galandras.onlive.TOGGLE_RECORDING"
        const val ACTION_APPLY_SETTINGS = "com.galandras.onlive.APPLY_SETTINGS"

        const val EXTRA_SOURCE = "source"
        const val EXTRA_LENS = "lens"
        const val EXTRA_TORCH_ON = "torch_on"
        const val EXTRA_PROJECTION_DATA = "projection_data"
        const val EXTRA_RESULT_CODE = "result_code"

        fun send(context: Context, action: String, configure: Intent.() -> Unit = {}) {
            val intent = Intent(context, StreamService::class.java).setAction(action).apply(configure)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }
    }
}
