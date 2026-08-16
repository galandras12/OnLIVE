package com.galandras.onlive.stream

import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.MediaRecorder
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.util.DisplayMetrics
import android.util.Log
import android.view.Surface
import android.view.WindowManager
import com.galandras.onlive.settings.Settings
import org.webrtc.EglBase
import org.webrtc.SurfaceTextureHelper
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Képernyő-megosztás a MediaProjection API-val.
 *
 * Miért nem a WebRTC beépített `ScreenCapturerAndroid`-ját használjuk:
 * az saját, belső [MediaProjection] példányt hoz létre és nem adja ki. Egy
 * hozzájárulási tokenből viszont csak EGY projekció nyerhető, így nem
 * maradna mód a párhuzamos helyi MP4-rögzítésre. Itt magunk kezeljük a
 * projekciót, és két VirtualDisplay-t hozunk létre belőle:
 *   1. az élő adásnak (SurfaceTextureHelper → WebRTC textúra-frame-ek),
 *   2. a helyi felvételnek (MediaRecorder felülete).
 *
 * A textúra-út egyben zero-copy is: képernyő módban nincs YUV-másolás.
 */
class ScreenSource(
    private val context: Context,
    private val eglBase: EglBase,
    private val fanout: FrameFanout,
) {

    private var projection: MediaProjection? = null
    private var textureHelper: SurfaceTextureHelper? = null
    private var captureSurface: Surface? = null
    private var captureDisplay: VirtualDisplay? = null

    private var recorder: MediaRecorder? = null
    private var recordDisplay: VirtualDisplay? = null
    private var recordUri: android.net.Uri? = null

    private val mainHandler = Handler(Looper.getMainLooper())

    /** A rendszer vagy a felhasználó állította le a képernyő-megosztást. */
    var onProjectionStopped: (() -> Unit)? = null

    val isRunning: Boolean get() = projection != null
    val isRecording: Boolean get() = recorder != null

    private val projectionCallback = object : MediaProjection.Callback() {
        override fun onStop() {
            Log.i(TAG, "A MediaProjection leállt (rendszer vagy felhasználó).")
            mainHandler.post { onProjectionStopped?.invoke() }
        }
    }

    /**
     * FONTOS SORREND (Android 14+): mire ez lefut, a Service-nek MÁR
     * `mediaProjection` típusú foreground service-ként kell futnia, különben
     * a `getMediaProjection()` SecurityException-t dob.
     */
    fun start(permissionData: Intent, resultCode: Int, settings: Settings) {
        stop()

        val manager = context.getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        val projection = manager.getMediaProjection(resultCode, permissionData)
            ?: throw IllegalStateException("Nem sikerült megszerezni a MediaProjectiont.")
        this.projection = projection

        // Android 14-től a callback regisztrálása kötelező a virtual display előtt.
        projection.registerCallback(projectionCallback, mainHandler)

        val metrics = displayMetrics()
        val (width, height) = captureSize(settings, metrics)

        val helper = SurfaceTextureHelper.create("OnLIVE-Screen", eglBase.eglBaseContext)
        helper.setTextureSize(width, height)
        helper.startListening { frame -> fanout.onFrame(frame) }
        textureHelper = helper

        val surface = Surface(helper.surfaceTexture)
        captureSurface = surface

        captureDisplay = projection.createVirtualDisplay(
            "OnLIVE-Capture",
            width,
            height,
            metrics.densityDpi,
            DISPLAY_FLAGS,
            surface,
            null,
            mainHandler,
        )

        Log.i(TAG, "Képernyő-megosztás elindult: ${width}x$height")
    }

    fun stop() {
        stopLocalRecording()

        captureDisplay?.release()
        captureDisplay = null

        captureSurface?.release()
        captureSurface = null

        textureHelper?.let {
            it.stopListening()
            it.dispose()
        }
        textureHelper = null

        projection?.let {
            it.unregisterCallback(projectionCallback)
            it.stop()
        }
        projection = null
    }

    // -----------------------------------------------------------------------
    // Helyi MP4 rögzítés — második VirtualDisplay ugyanabból a projekcióból
    // -----------------------------------------------------------------------

    /**
     * [withAudio]: élő adás közben `false`. A mikrofont ilyenkor a WebRTC
     * AudioDeviceModule tartja, és egyszerre egy capture-kliens birtokolhatja.
     */
    fun startLocalRecording(settings: Settings, withAudio: Boolean): Result<Unit> {
        val projection = projection
            ?: return Result.failure(IllegalStateException("Nincs futó képernyő-megosztás."))
        if (recorder != null) return Result.success(Unit)

        return runCatching {
            val metrics = displayMetrics()
            val (width, height) = captureSize(settings, metrics)

            val name = "OnLIVE_screen_${TIMESTAMP.format(Date())}.mp4"
            val values = ContentValues().apply {
                put(MediaStore.Video.Media.DISPLAY_NAME, name)
                put(MediaStore.Video.Media.MIME_TYPE, "video/mp4")
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    put(MediaStore.Video.Media.RELATIVE_PATH, "Movies/OnLIVE")
                }
            }
            val uri = context.contentResolver
                .insert(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, values)
                ?: error("Nem sikerült létrehozni a videófájlt a galériában.")
            recordUri = uri

            val descriptor = context.contentResolver.openFileDescriptor(uri, "w")
                ?: error("Nem sikerült megnyitni a videófájlt írásra.")

            @Suppress("DEPRECATION")
            val newRecorder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                MediaRecorder(context)
            } else {
                MediaRecorder()
            }

            newRecorder.apply {
                if (withAudio) setAudioSource(MediaRecorder.AudioSource.MIC)
                setVideoSource(MediaRecorder.VideoSource.SURFACE)
                setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
                setVideoEncoder(MediaRecorder.VideoEncoder.H264)
                if (withAudio) {
                    setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
                    setAudioSamplingRate(settings.audioSampleRate.hz)
                    setAudioEncodingBitRate(settings.audioBitrate.kbps * 1000)
                }
                setVideoSize(width, height)
                setVideoFrameRate(settings.frameRate.fps)
                setVideoEncodingBitRate(settings.videoBitrateKbps * 1000)
                setOutputFile(descriptor.fileDescriptor)
                prepare()
            }

            recordDisplay = projection.createVirtualDisplay(
                "OnLIVE-Record",
                width,
                height,
                metrics.densityDpi,
                DISPLAY_FLAGS,
                newRecorder.surface,
                null,
                mainHandler,
            )
            newRecorder.start()
            recorder = newRecorder
            descriptor.close()

            StreamBus.update { it.copy(localRecording = true) }
            Unit
        }.onFailure {
            Log.w(TAG, "Képernyő-felvétel indítása sikertelen: ${it.message}")
            stopLocalRecording()
        }
    }

    fun stopLocalRecording() {
        recordDisplay?.release()
        recordDisplay = null

        recorder?.let {
            runCatching { it.stop() }.onFailure { e -> Log.w(TAG, "MediaRecorder stop: ${e.message}") }
            runCatching { it.release() }
        }
        recorder = null

        recordUri?.let { StreamBus.setMessage("Képernyő-felvétel mentve.") }
        recordUri = null
        StreamBus.update { it.copy(localRecording = false) }
    }

    // -----------------------------------------------------------------------

    private fun displayMetrics(): DisplayMetrics {
        val metrics = DisplayMetrics()
        val windowManager = context.getSystemService(Context.WINDOW_SERVICE) as WindowManager
        @Suppress("DEPRECATION")
        windowManager.defaultDisplay.getRealMetrics(metrics)
        return metrics
    }

    /**
     * A capture méret a kijelző arányát követi, de a kért felbontásra van
     * skálázva, és páros értékekre kerekítve (a H.264 enkóder ezt igényli).
     */
    private fun captureSize(settings: Settings, metrics: DisplayMetrics): Pair<Int, Int> {
        // A képernyő aránya adott — azt nem mi választjuk meg, hanem a
        // készülék. A kép-irány beállítás (1.0.101) ezért itt csak a cél
        // rövidebb oldalra hat, a 16:9 / 9:16 gomb a KAMERÁRA vonatkozik.
        val targetShortSide = minOf(settings.captureWidth, settings.captureHeight)
        val shortSide = minOf(metrics.widthPixels, metrics.heightPixels)
        val scale = if (shortSide > 0) targetShortSide.toFloat() / shortSide else 1f

        fun even(value: Int) = (value / 2) * 2
        return even((metrics.widthPixels * scale).toInt()) to
            even((metrics.heightPixels * scale).toInt())
    }

    companion object {
        private const val TAG = "OnLIVE/Screen"
        private val TIMESTAMP = SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US)
        private const val DISPLAY_FLAGS =
            DisplayManager.VIRTUAL_DISPLAY_FLAG_PUBLIC or
                DisplayManager.VIRTUAL_DISPLAY_FLAG_PRESENTATION
    }
}
