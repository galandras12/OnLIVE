package com.galandras.onlive.stream

import android.Manifest
import android.content.ContentValues
import android.content.Context
import android.content.pm.PackageManager
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.hardware.camera2.CaptureRequest
import android.os.Build
import android.provider.MediaStore
import android.util.Log
import android.util.Range
import android.util.Size
import androidx.camera.camera2.interop.Camera2CameraInfo
import androidx.camera.camera2.interop.Camera2Interop
import androidx.camera.camera2.interop.ExperimentalCamera2Interop
import androidx.camera.core.Camera
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.core.resolutionselector.AspectRatioStrategy
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.video.FallbackStrategy
import androidx.camera.video.MediaStoreOutputOptions
import androidx.camera.video.Quality
import androidx.camera.video.QualitySelector
import androidx.camera.video.Recorder
import androidx.camera.video.Recording
import androidx.camera.video.VideoCapture
import androidx.camera.video.VideoRecordEvent
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleOwner
import com.galandras.onlive.settings.LensKind
import com.galandras.onlive.settings.LensOption
import com.galandras.onlive.settings.Settings
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import org.webrtc.VideoFrame
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.Executors
import kotlin.coroutines.resume

/**
 * CameraX-alapú kamera capture.
 *
 * KRITIKUS: a [lifecycleOwner] NEM az Activity, hanem a [StreamService]
 * (LifecycleService). Ha az Activity lenne a LifecycleOwner, appváltáskor az
 * `onStop()` leállítaná a kamerát, és megszakadna az adás. Így viszont a
 * kamera-session a Service élettartamához kötött, és a UI jövés-menése nem
 * érinti.
 */
@OptIn(ExperimentalCamera2Interop::class)
class CameraSource(
    private val context: Context,
    private val lifecycleOwner: LifecycleOwner,
    private val fanout: FrameFanout,
) {

    private val analysisExecutor = Executors.newSingleThreadExecutor()

    private var provider: ProcessCameraProvider? = null
    private var camera: Camera? = null
    private var preview: Preview? = null
    private var analysis: ImageAnalysis? = null
    private var videoCapture: VideoCapture<Recorder>? = null
    private var recording: Recording? = null

    private var surfaceProvider: Preview.SurfaceProvider? = null
    private var boundLens: LensKind? = null

    /** A tényleg létező fizikai lencsék, a Camera2 metaadatok alapján. */
    val lenses: List<LensOption> by lazy { enumerateLenses() }

    val isRunning: Boolean get() = camera != null
    val isRecording: Boolean get() = recording != null

    // -----------------------------------------------------------------------
    // Életciklus
    // -----------------------------------------------------------------------

    suspend fun start(settings: Settings) = bind(settings, settings.lens)

    /**
     * Élő lencseváltás. A CameraX-nek újra kell kötnie a kamerát (a Camera2
     * session lencsénként külön), ezért van egy rövid, jellemzően 300–800 ms-os
     * kép-kiesés. A WebRTC session NEM szakad meg: ugyanaz a VideoSource és
     * ugyanaz a PeerConnection marad, csak nem érkezik pár képkocka.
     */
    suspend fun switchLens(settings: Settings, lens: LensKind) {
        if (boundLens == lens) return
        bind(settings, lens)
    }

    private suspend fun bind(settings: Settings, lens: LensKind) = withContext(Dispatchers.Main) {
        val cameraProvider = provider ?: awaitProvider().also { provider = it }

        val size = Size(settings.resolution.width, settings.resolution.height)
        val resolutionSelector = ResolutionSelector.Builder()
            .setAspectRatioStrategy(AspectRatioStrategy.RATIO_16_9_FALLBACK_AUTO_STRATEGY)
            .setResolutionStrategy(
                ResolutionStrategy(size, ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER)
            )
            .build()

        val previewUseCase = Preview.Builder()
            .setResolutionSelector(resolutionSelector)
            .apply {
                // A kért fps rögzítése a Camera2 AE-tartományon keresztül.
                Camera2Interop.Extender(this).setCaptureRequestOption(
                    CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE,
                    Range(settings.frameRate.fps, settings.frameRate.fps),
                )
            }
            .build()

        val analysisUseCase = ImageAnalysis.Builder()
            .setResolutionSelector(resolutionSelector)
            .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
            .setOutputImageFormat(ImageAnalysis.OUTPUT_IMAGE_FORMAT_YUV_420_888)
            .build()
            .apply { setAnalyzer(analysisExecutor, ::onImage) }

        val recorder = Recorder.Builder()
            .setQualitySelector(
                QualitySelector.from(
                    qualityFor(settings),
                    FallbackStrategy.lowerQualityOrHigherThan(Quality.HD),
                )
            )
            .build()
        val videoUseCase = VideoCapture.withOutput(recorder)

        val selector = selectorFor(lens)

        cameraProvider.unbindAll()
        camera = try {
            // Preview + ImageAnalysis + VideoCapture: a helyi MP4-rögzítéshez
            // kell a harmadik use case. Nem minden eszköz támogatja egyszerre.
            videoCapture = videoUseCase
            cameraProvider.bindToLifecycle(
                lifecycleOwner, selector, previewUseCase, analysisUseCase, videoUseCase
            )
        } catch (e: Exception) {
            Log.w(TAG, "3 use case kötése nem sikerült, helyi rögzítés nélkül folytatjuk: ${e.message}")
            videoCapture = null
            cameraProvider.bindToLifecycle(lifecycleOwner, selector, previewUseCase, analysisUseCase)
        }

        preview = previewUseCase
        analysis = analysisUseCase
        boundLens = lens
        previewUseCase.setSurfaceProvider(surfaceProvider)

        StreamBus.update { it.copy(lens = lens, availableLenses = lenses) }
        Log.i(TAG, "Kamera elindult: lencse=$lens, ${size.width}x${size.height}@${settings.frameRate.fps}")
    }

    suspend fun stop() = withContext(Dispatchers.Main) {
        stopLocalRecording()
        provider?.unbindAll()
        camera = null
        preview = null
        analysis = null
        videoCapture = null
        boundLens = null
    }

    fun release() {
        analysisExecutor.shutdown()
    }

    /** Az Activity teszi be/veszi ki; a kamera ettől függetlenül fut tovább. */
    fun setSurfaceProvider(provider: Preview.SurfaceProvider?) {
        surfaceProvider = provider
        preview?.setSurfaceProvider(provider)
    }

    // -----------------------------------------------------------------------
    // Képkocka-út
    // -----------------------------------------------------------------------

    private fun onImage(image: ImageProxy) {
        try {
            val buffer = ImageProxyConverter.toI420(image)
            val frame = VideoFrame(
                buffer,
                image.imageInfo.rotationDegrees,
                image.imageInfo.timestamp,
            )
            fanout.onFrame(frame)
            frame.release()
        } catch (t: Throwable) {
            Log.w(TAG, "Képkocka-konverzió hiba: ${t.message}")
        } finally {
            image.close()
        }
    }

    // -----------------------------------------------------------------------
    // Vaku
    // -----------------------------------------------------------------------

    /** Torch a bekötött kamerán. Ha nincs bekötött kamera, [TorchController] kell. */
    fun setTorch(on: Boolean): Boolean {
        val control = camera?.cameraControl ?: return false
        control.enableTorch(on)
        return true
    }

    fun hasTorch(): Boolean = camera?.cameraInfo?.hasFlashUnit() ?: false

    // -----------------------------------------------------------------------
    // Helyi MP4 rögzítés ("filmtekercs")
    // -----------------------------------------------------------------------

    /**
     * Helyi felvétel indítása. Teljesen független a WHIP publish-tól: külön
     * enkóder, külön fájl; ha a hálózat megszakad, a felvétel akkor is megy.
     *
     * [withAudio]: élő közvetítés közben `false` a helyes érték. A mikrofont
     * ilyenkor a WebRTC AudioDeviceModule tartja, és Android alatt egyszerre
     * egy capture-kliens birtokolhatja — a második vagy hibára fut, vagy
     * elveszi a hangot az adástól.
     */
    fun startLocalRecording(withAudio: Boolean): Result<Unit> {
        val capture = videoCapture
            ?: return Result.failure(IllegalStateException("Ez az eszköz nem támogatja a helyi rögzítést élő kamera-adás mellett."))
        if (recording != null) return Result.success(Unit)

        return runCatching {
            val name = "OnLIVE_${TIMESTAMP.format(Date())}.mp4"
            val values = ContentValues().apply {
                put(MediaStore.Video.Media.DISPLAY_NAME, name)
                put(MediaStore.Video.Media.MIME_TYPE, "video/mp4")
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    put(MediaStore.Video.Media.RELATIVE_PATH, "Movies/OnLIVE")
                }
            }
            val options = MediaStoreOutputOptions
                .Builder(context.contentResolver, MediaStore.Video.Media.EXTERNAL_CONTENT_URI)
                .setContentValues(values)
                .build()

            var pending = capture.output.prepareRecording(context, options)
            if (withAudio && hasAudioPermission()) {
                pending = pending.withAudioEnabled()
            }

            recording = pending.start(ContextCompat.getMainExecutor(context)) { event ->
                when (event) {
                    is VideoRecordEvent.Start ->
                        StreamBus.update { it.copy(localRecording = true) }

                    is VideoRecordEvent.Finalize -> {
                        recording = null
                        StreamBus.update { it.copy(localRecording = false) }
                        if (event.hasError()) {
                            Log.w(TAG, "Helyi felvétel hiba: ${event.error}")
                            StreamBus.setMessage("A helyi felvétel hibára futott (${event.error}).")
                        } else {
                            StreamBus.setMessage("Felvétel mentve: $name")
                        }
                    }
                }
            }
            Unit
        }
    }

    fun stopLocalRecording() {
        recording?.stop()
        recording = null
    }

    // -----------------------------------------------------------------------
    // Lencsék felderítése
    // -----------------------------------------------------------------------

    private fun selectorFor(lens: LensKind): CameraSelector {
        val option = lenses.firstOrNull { it.kind == lens }
            ?: lenses.firstOrNull { it.kind == LensKind.MAIN }
            ?: return CameraSelector.DEFAULT_BACK_CAMERA

        return CameraSelector.Builder()
            .requireLensFacing(
                if (option.isFront) CameraSelector.LENS_FACING_FRONT else CameraSelector.LENS_FACING_BACK
            )
            .addCameraFilter { infos ->
                infos.filter { Camera2CameraInfo.from(it).cameraId == option.cameraId }
                    .ifEmpty { infos }
            }
            .build()
    }

    /**
     * A fizikai lencsék besorolása. Nem hardcode-olt kamera-id-kre épül,
     * hanem a Camera2 metaadatokra:
     *  - a fő kamera konvenció szerint a `cameraIdList` első hátlapi eleme,
     *  - a nála rövidebb fókusztávolságú hátlapi lencse a nagylátószögű,
     *  - a hosszabb fókusztávolságú a tele.
     */
    private fun enumerateLenses(): List<LensOption> = runCatching {
        val manager = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager
        val result = mutableListOf<LensOption>()
        val backCameras = mutableListOf<Pair<String, Float>>()

        for (id in manager.cameraIdList) {
            val characteristics = manager.getCameraCharacteristics(id)
            val focal = characteristics
                .get(CameraCharacteristics.LENS_INFO_AVAILABLE_FOCAL_LENGTHS)
                ?.minOrNull() ?: continue

            when (characteristics.get(CameraCharacteristics.LENS_FACING)) {
                CameraCharacteristics.LENS_FACING_FRONT ->
                    if (result.none { it.kind == LensKind.FRONT }) {
                        result += LensOption(LensKind.FRONT, id, focal, isFront = true)
                    }

                CameraCharacteristics.LENS_FACING_BACK -> backCameras += id to focal
            }
        }

        val main = backCameras.firstOrNull()
        if (main != null) {
            result += LensOption(LensKind.MAIN, main.first, main.second, isFront = false)

            backCameras.drop(1)
                .filter { it.second < main.second * 0.8f }
                .minByOrNull { it.second }
                ?.let { result += LensOption(LensKind.ULTRA_WIDE, it.first, it.second, false) }

            backCameras.drop(1)
                .filter { it.second > main.second * 1.4f }
                .maxByOrNull { it.second }
                ?.let { result += LensOption(LensKind.TELE, it.first, it.second, false) }
        }

        result.sortedBy { it.kind.ordinal }
    }.onFailure { Log.w(TAG, "Lencse-felderítés hiba: ${it.message}") }
        .getOrDefault(emptyList())

    private fun qualityFor(settings: Settings) = when {
        settings.resolution.height >= 2160 -> Quality.UHD
        settings.resolution.height >= 1080 -> Quality.FHD
        settings.resolution.height >= 720 -> Quality.HD
        else -> Quality.SD
    }

    private fun hasAudioPermission() =
        ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
            PackageManager.PERMISSION_GRANTED

    private suspend fun awaitProvider(): ProcessCameraProvider =
        suspendCancellableCoroutine { cont ->
            val future = ProcessCameraProvider.getInstance(context)
            future.addListener(
                { cont.resume(future.get()) },
                ContextCompat.getMainExecutor(context),
            )
        }

    companion object {
        private const val TAG = "OnLIVE/Camera"
        private val TIMESTAMP = SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US)
    }
}
