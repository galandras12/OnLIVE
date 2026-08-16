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
import androidx.camera.camera2.interop.Camera2Interop
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

    /** Az utolsó konvertált képkocka ideje — az előnézeti ritkítás alapja. */
    private var lastPreviewFrameAt = 0L

    /** A tényleg létező fizikai lencsék, a Camera2 metaadatok alapján. */
    val lenses: List<LensOption> by lazy { enumerateLenses() }

    val isRunning: Boolean get() = camera != null
    val isRecording: Boolean get() = recording != null

    // -----------------------------------------------------------------------
    // Életciklus
    // -----------------------------------------------------------------------

    suspend fun start(settings: Settings) = bind(settings, settings.lens)

    /**
     * Élő lencseváltás.
     *
     * Ha ugyanazon az oldalon maradunk (fő ↔ tele ↔ nagylátószögű), akkor
     * NINCS újrakötés: csak a zoom-arányt állítjuk, amitől a rendszer maga vált
     * fizikai optikát. Így a váltás azonnali, és egyetlen képkocka sem esik ki.
     *
     * Oldalváltásnál (elő ↔ hátlapi) viszont tényleg új Camera2 session kell,
     * ott marad a 300–800 ms-os kiesés. A WebRTC session ilyenkor sem szakad
     * meg: ugyanaz a VideoSource és PeerConnection marad.
     */
    suspend fun switchLens(settings: Settings, lens: LensKind) {
        if (boundLens == lens) return

        val target = lenses.firstOrNull { it.kind == lens }
        val current = lenses.firstOrNull { it.kind == boundLens }

        if (target != null && current != null && target.isFront == current.isFront && camera != null) {
            applyZoom(target)
            boundLens = lens
            StreamBus.update { it.copy(lens = lens, availableLenses = lenses) }
            Log.i(TAG, "Optikaváltás zoommal: $lens (${target.zoomRatio}x)")
            return
        }

        bind(settings, lens)
    }

    /**
     * A lencséhez tartozó zoom beállítása, a kamera tényleges tartományára
     * vágva: a számított arány (fókusztávolság-hányados) nem feltétlenül esik
     * bele — a rendszer jellemzően 0,5× alá nem enged, felfelé pedig a digitális
     * zoom határáig.
     */
    private fun applyZoom(option: LensOption) {
        val control = camera?.cameraControl ?: return
        val zoomState = camera?.cameraInfo?.zoomState?.value

        val ratio = if (zoomState != null) {
            option.zoomRatio.coerceIn(zoomState.minZoomRatio, zoomState.maxZoomRatio)
        } else {
            option.zoomRatio
        }
        control.setZoomRatio(ratio)
    }

    private suspend fun bind(settings: Settings, lens: LensKind) = withContext(Dispatchers.Main) {
        val cameraProvider = provider ?: awaitProvider().also { provider = it }

        // A felbontás-választás a SZENZOR koordinátáiban történik, ami mindig
        // fekvő — a 9:16-os kimenetet nem itt, hanem a targetRotation adja
        // (1.0.101). Ha itt cserélnénk meg az oldalakat, a CameraX nem találna
        // illeszkedő méretet, és a legközelebbi rosszabbra esne vissza.
        val size = Size(settings.resolution.width, settings.resolution.height)
        val resolutionSelector = ResolutionSelector.Builder()
            .setAspectRatioStrategy(AspectRatioStrategy.RATIO_16_9_FALLBACK_AUTO_STRATEGY)
            .setResolutionStrategy(
                ResolutionStrategy(size, ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER)
            )
            .build()

        val previewUseCase = Preview.Builder()
            .setResolutionSelector(resolutionSelector)
            // A kép-irányt a BEÁLLÍTÁS dönti el, nem az, ahogy a telefont
            // tartod (1.0.101). A felbontás-választás a szenzor koordinátáiban
            // (fekvőben) történik, a forgatás ettől független metaadat.
            .setTargetRotation(settings.orientation.surfaceRotation)
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
            .setTargetRotation(settings.orientation.surfaceRotation)
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
        val videoUseCase = VideoCapture.withOutput(recorder).apply {
            targetRotation = settings.orientation.surfaceRotation
        }

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

        // A hátlapi optikák egyetlen logikai kamera mögött vannak: a konkrét
        // lencsét a zoom-arány választja ki, nem a kamera-azonosító.
        lenses.firstOrNull { it.kind == lens }?.let(::applyZoom)

        StreamBus.update { it.copy(lens = lens, availableLenses = lenses) }
        Log.i(
            TAG,
            "Kamera elindult: lencse=$lens, ${size.width}x${size.height}" +
                "@${settings.frameRate.fps}, irány=${settings.orientation.ratio}",
        )
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
            /*
              Előnézet közben nincs kinek átadni a képkockát: a WebRTC oldali
              fogadó (`downstream`) csak élő adás alatt létezik. A YUV → I420
              konverzió viszont drága — 1080p30-nál folyamatosan terhelné a
              CPU-t és az akkumulátort azért, hogy az eredményt eldobjuk.
              Ilyenkor ezért csak ritkán konvertálunk: annyiszor, hogy a
              „kép mentése" gombnak legyen friss képkockája.
            */
            val now = System.currentTimeMillis()
            if (fanout.downstream == null && now - lastPreviewFrameAt < PREVIEW_FRAME_INTERVAL_MS) {
                return
            }
            lastPreviewFrameAt = now

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

    /**
     * A kamera kiválasztása KIZÁRÓLAG oldal szerint (elő- vagy hátlapi).
     *
     * Korábban itt egy kamera-azonosítós szűrő is volt, de az sosem talált: a
     * tele és a nagylátószögű fizikai alkamera, azok azonosítóját a CameraX nem
     * ismeri, így a szűrő mindig üresre futott és a tartalék ágon ugyanaz a
     * kamera jött vissza — a váltás némán elmaradt. A konkrét optikát mostantól
     * a zoom-arány választja ki (lásd [applyZoom]).
     */
    private fun selectorFor(lens: LensKind): CameraSelector {
        val front = lenses.firstOrNull { it.kind == lens }?.isFront ?: (lens == LensKind.FRONT)

        return if (front) CameraSelector.DEFAULT_FRONT_CAMERA else CameraSelector.DEFAULT_BACK_CAMERA
    }

    /**
     * A fizikai lencsék besorolása.
     *
     * MIÉRT NEM A `cameraIdList`-BŐL: a modern telefonokon (Samsung Galaxy S,
     * Pixel) a hátlapi optikák EGYETLEN logikai kamera mögött vannak. A
     * `cameraIdList` így csak egy hátlapi kamerát ad vissza, a tele és a
     * nagylátószögű pedig **fizikai alkamera** — azok azonosítóját a
     * `getPhysicalCameraIds()` adja, és a CameraX `Camera2CameraInfo.cameraId`
     * SOSEM egyezik velük. Emiatt a korábbi felderítés egyetlen hátlapi
     * lencsét talált, a kamera-azonosítós szűrő pedig sosem fogott.
     *
     * Ezért a fizikai alkamerák fókusztávolságából **zoom-arányt** számolunk:
     * a rendszer a küszöböt átlépve magától kapcsol optikát. Ez ráadásul
     * gyorsabb is — nem kell újrakötni a kamerát.
     */
    private fun enumerateLenses(): List<LensOption> = runCatching {
        val manager = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager
        val result = mutableListOf<LensOption>()

        // --- előlapi: itt tényleg külön logikai kamera van ---
        for (id in manager.cameraIdList) {
            val characteristics = manager.getCameraCharacteristics(id)
            if (characteristics.get(CameraCharacteristics.LENS_FACING) !=
                CameraCharacteristics.LENS_FACING_FRONT
            ) continue

            val focal = focalOf(characteristics) ?: continue
            result += LensOption(LensKind.FRONT, id, focal, isFront = true)
            break
        }

        // --- hátlapi: a fő logikai kamera + a mögötte lévő fizikai optikák ---
        val backId = manager.cameraIdList.firstOrNull { id ->
            manager.getCameraCharacteristics(id).get(CameraCharacteristics.LENS_FACING) ==
                CameraCharacteristics.LENS_FACING_BACK
        }

        if (backId != null) {
            val backCharacteristics = manager.getCameraCharacteristics(backId)
            val mainFocal = focalOf(backCharacteristics) ?: 1f

            result += LensOption(LensKind.MAIN, backId, mainFocal, isFront = false, zoomRatio = 1f)

            // A fizikai alkamerák API 28-tól kérdezhetők le.
            val physicalFocals = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                backCharacteristics.physicalCameraIds.mapNotNull { physicalId ->
                    runCatching { focalOf(manager.getCameraCharacteristics(physicalId)) }.getOrNull()
                }
            } else {
                emptyList()
            }

            // A fő optika fókusztávolsága a fizikai lencsék közül a „középső":
            // amelyikhez az 1× tartozik. Ha a rendszer nem adott vissza
            // fizikai kamerákat, marad az egyetlen, fő lencse.
            val reference = physicalFocals.minByOrNull { kotlin.math.abs(it - mainFocal) } ?: mainFocal

            physicalFocals.minOrNull()
                ?.takeIf { it < reference * 0.8f }
                ?.let { focal ->
                    result += LensOption(
                        LensKind.ULTRA_WIDE, backId, focal, isFront = false,
                        zoomRatio = focal / reference,
                    )
                }

            physicalFocals.maxOrNull()
                ?.takeIf { it > reference * 1.4f }
                ?.let { focal ->
                    result += LensOption(
                        LensKind.TELE, backId, focal, isFront = false,
                        zoomRatio = focal / reference,
                    )
                }
        }

        result.sortedBy { it.kind.ordinal }
    }.onFailure { Log.w(TAG, "Lencse-felderítés hiba: ${it.message}") }
        .getOrDefault(emptyList())

    /** A legrövidebb elérhető fókusztávolság — ez jellemzi az adott optikát. */
    private fun focalOf(characteristics: CameraCharacteristics): Float? =
        characteristics.get(CameraCharacteristics.LENS_INFO_AVAILABLE_FOCAL_LENGTHS)?.minOrNull()

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

        /** Előnézet közben ennyi időnként konvertálunk egy képkockát (~2 fps). */
        private const val PREVIEW_FRAME_INTERVAL_MS = 500L
        private val TIMESTAMP = SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US)
    }
}
