package com.galandras.onlive.settings

/**
 * Az OnLIVE app minőségi beállításai.
 *
 * Ezek az értékek nem maradnak a telefonon: a [com.galandras.onlive.net.ControlApi]
 * minden `session/start` és `session/stats` hívásban felküldi őket a vezérlő
 * szervernek, hogy az admin web UI-n is látszódjon, épp mivel megy az adás.
 */

/**
 * Videó felbontás. A rövidebb oldal a mérvadó, az arányt a [StreamOrientation]
 * adja: a `width`/`height` itt mindig a FEKVŐ alak.
 */
enum class VideoResolution(val label: String, val width: Int, val height: Int) {
    P480("480p", 854, 480),
    P720("720p", 1280, 720),
    P1080("1080p", 1920, 1080),
    P1440("1440p", 2560, 1440),
    P2160("2160p", 3840, 2160);

    companion object {
        val DEFAULT = P1080
        fun fromName(name: String?): VideoResolution =
            entries.firstOrNull { it.name == name } ?: DEFAULT
    }
}

/** Képfrissítés. 60 fps csak 1080p-ig ajánlott mobilhálózaton. */
enum class FrameRate(val fps: Int) {
    FPS24(24), FPS30(30), FPS50(50), FPS60(60);

    val label: String get() = "$fps fps"

    companion object {
        val DEFAULT = FPS30
        fun fromFps(fps: Int?): FrameRate = entries.firstOrNull { it.fps == fps } ?: DEFAULT
    }
}

/**
 * A stream kép-iránya (1.0.101).
 *
 * Az adás INDÍTÁSA előtt választható, és utána a capture ehhez igazodik — nem
 * ahhoz, ahogy a felhasználó épp tartja a telefont. Ezért állítjuk be fixen a
 * use case-ek `targetRotation`-jét: enélkül a kép aránya attól függene, hogy a
 * kézben megbillent-e a készülék, az OBS jelenet és az overlay-ek viszont
 * egyetlen arányra vannak szabva.
 */
enum class StreamOrientation(val label: String, val ratio: String, val surfaceRotation: Int) {
    /** 16:9 — a kép fekvő, akkor is, ha a telefont állva tartod. */
    LANDSCAPE("16:9 fekvő", "16:9", android.view.Surface.ROTATION_90),

    /** 9:16 — a kép álló (Shorts, Reels, TikTok). */
    PORTRAIT("9:16 álló", "9:16", android.view.Surface.ROTATION_0);

    val isPortrait: Boolean get() = this == PORTRAIT

    /** Szélesség/magasság arány a Compose `aspectRatio()`-jához. */
    val aspect: Float get() = if (isPortrait) 9f / 16f else 16f / 9f

    /** Amit a szervernek jelentünk. */
    val wire: String get() = name.lowercase()

    companion object {
        val DEFAULT = LANDSCAPE

        /** A szerver `landscape` / `portrait` néven küldi (device/capture-options.js). */
        fun fromWire(value: String?): StreamOrientation =
            if (value?.equals("portrait", ignoreCase = true) == true) PORTRAIT else LANDSCAPE

        fun fromName(name: String?): StreamOrientation =
            entries.firstOrNull { it.name == name } ?: DEFAULT
    }
}

/**
 * Videó bitráta (kbps). A WebRTC ezt felső korlátként kapja meg
 * (`RtpParameters.Encoding.maxBitrateBps`), a tényleges érték ennél a
 * hálózat függvényében kisebb lehet.
 *
 * A felső határ 2160p miatt 25 000: 4K-hoz 12 Mbit/s már kevés. A szerver
 * ugyanezt a korlátot érvényesíti (device/capture-options.js).
 */
object VideoBitrate {
    const val MIN_KBPS = 500
    const val MAX_KBPS = 25_000

    /** Ajánlott kiindulási bitráta a felbontás/fps párosra. */
    fun recommendedKbps(resolution: VideoResolution, frameRate: FrameRate): Int {
        val base = when (resolution) {
            VideoResolution.P480 -> 1_200
            VideoResolution.P720 -> 2_500
            VideoResolution.P1080 -> 4_500
            VideoResolution.P1440 -> 8_000
            VideoResolution.P2160 -> 16_000
        }
        return if (frameRate.fps > 30) (base * 1.5).toInt() else base
    }
}

/** Audio mintavételi frekvencia. Az Opus 48 kHz-en dolgozik natívan. */
enum class AudioSampleRate(val hz: Int) {
    HZ_16000(16_000), HZ_44100(44_100), HZ_48000(48_000);

    val label: String get() = "${hz / 1000} kHz"

    companion object {
        val DEFAULT = HZ_48000
        fun fromHz(hz: Int?): AudioSampleRate = entries.firstOrNull { it.hz == hz } ?: DEFAULT
    }
}

/** Audio bitráta (kbps) — SDP-ben `maxaveragebitrate` az opus fmtp sorban. */
enum class AudioBitrate(val kbps: Int) {
    KBPS_32(32), KBPS_64(64), KBPS_96(96), KBPS_128(128);

    val label: String get() = "$kbps kbps"

    companion object {
        val DEFAULT = KBPS_96
        fun fromKbps(kbps: Int?): AudioBitrate = entries.firstOrNull { it.kbps == kbps } ?: DEFAULT
    }
}

/** Capture forrás: kamera vagy képernyő-megosztás. */
enum class CaptureSource { CAMERA, SCREEN }

/**
 * Fizikai lencse-kategóriák. A tényleges leképezés eszközfüggő, ezért a
 * [com.galandras.onlive.stream.CameraSource] futásidőben, a Camera2
 * metaadatok (fókusztávolság, látószög) alapján dönti el, melyik camera id
 * melyik kategóriába esik — nem hardcode-olt id-k alapján.
 */
enum class LensKind(val label: String) {
    FRONT("Előlapi"),
    MAIN("Fő"),
    TELE("Tele"),
    ULTRA_WIDE("Nagylátószögű");

    companion object {
        val DEFAULT = MAIN
        fun fromName(name: String?): LensKind = entries.firstOrNull { it.name == name } ?: DEFAULT
    }
}

/** Egy konkrét, az eszközön ténylegesen elérhető lencse. */
data class LensOption(
    val kind: LensKind,
    /** A logikai kamera azonosítója, amit a CameraX is ismer. */
    val cameraId: String,
    val focalLengthMm: Float,
    val isFront: Boolean,
    /**
     * Hányszoros zoomnál kapcsol át a rendszer erre az optikára.
     *
     * A modern telefonokon (Samsung, Pixel) a hátlapi kamerák EGYETLEN logikai
     * kamera mögött vannak: a `cameraIdList` csak azt az egyet adja vissza, a
     * tele és a nagylátószögű pedig fizikai alkamera. Váltani ezért nem
     * kamera-azonosítóval lehet, hanem **zoom-aránnyal** — a rendszer a
     * küszöböt átlépve magától vált optikát.
     *
     * Az arány a fókusztávolságok hányadosa a fő lencséhez képest
     * (pl. 17 mm / 6,4 mm ≈ 2,7×), a kamera tényleges zoom-tartományára vágva.
     */
    val zoomRatio: Float = 1f,
)
