package com.galandras.onlive.settings

import android.content.Context
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

private val Context.dataStore by preferencesDataStore(name = "onlive_settings")

/**
 * Perzisztens beállítások.
 *
 * A végpontok alapértelmezései az 1. szegmens fix, publikus URL-jei
 * (docs/NETWORKING.md 9. fejezet) — ezek IP-váltáskor, rebootkor sem változnak,
 * ezért nyugodtan beégethetők alapértéknek.
 */
data class Settings(
    val ingestBaseUrl: String = DEFAULT_INGEST_URL,
    val controlBaseUrl: String = DEFAULT_CONTROL_URL,
    val streamPath: String = DEFAULT_STREAM_PATH,
    val streamKey: String = "",
    /** A MediaMTX `authInternalUsers` publish-felhasználója (HTTP Basic név). */
    val ingestUser: String = DEFAULT_INGEST_USER,
    val resolution: VideoResolution = VideoResolution.DEFAULT,
    val frameRate: FrameRate = FrameRate.DEFAULT,
    val videoBitrateKbps: Int = VideoBitrate.recommendedKbps(VideoResolution.DEFAULT, FrameRate.DEFAULT),
    val audioSampleRate: AudioSampleRate = AudioSampleRate.DEFAULT,
    val audioBitrate: AudioBitrate = AudioBitrate.DEFAULT,
    val lens: LensKind = LensKind.DEFAULT,
    val source: CaptureSource = CaptureSource.CAMERA,
    val oemGuideDismissed: Boolean = false,
    /**
     * TURN relay a WebRTC médiaúthoz. A WHIP jelzés átmegy a Cloudflare
     * Tunnelen, a média NEM — TURN nélkül NAT mögül jellemzően nem jön létre
     * médiaút (docs/NETWORKING.md 3. fejezet).
     */
    val turnUrl: String = "",
    val turnUsername: String = "",
    val turnCredential: String = "",
) {
    /** A teljes WHIP publish URL: `https://ingest.galandras.com/<stream>/whip`. */
    val whipUrl: String
        get() = "${ingestBaseUrl.trimEnd('/')}/${streamPath.trim('/')}/whip"

    companion object {
        const val DEFAULT_INGEST_URL = "https://ingest.galandras.com"
        const val DEFAULT_CONTROL_URL = "https://admin.galandras.com"
        const val DEFAULT_STREAM_PATH = "onlive"
        const val DEFAULT_INGEST_USER = "publisher"

        /**
         * A vezérlő szerver ALAP-címe (1.0.019).
         *
         * A mezőbe a webes felület címét szokás bemásolni — `.../admin` végződéssel.
         * Az app viszont ehhez fűzi hozzá a saját útvonalait, tehát abból
         * `.../admin/api/session/ping` lenne, amire a szerver **HTTP 404**-et ad:
         * a cím elérhető, a kulcs jó, mégsem működik semmi. Ez pontosan így
         * történt egy éles telepítésnél, ezért itt levágjuk.
         *
         * Az `/admin` és a `/live` a szerver saját OLDALAI, sosem részei az
         * alap-címnek. Egyéb útvonalhoz nem nyúlunk: al-útvonalra telepített
         * (reverse proxy mögötti) szerver esetén az odatartozhat.
         */
        fun normalizeControlBase(raw: String): String {
            var value = raw.trim().trimEnd('/')
            for (page in listOf("/admin", "/live")) {
                if (value.endsWith(page, ignoreCase = true)) {
                    value = value.dropLast(page.length).trimEnd('/')
                }
            }
            return value
        }

        /**
         * Az ingest ALAP-címe. Ide a teljes publish cím szokott bekerülni
         * (`.../onlive/whip`), amiből az app megint csak `.../onlive/whip/onlive/whip`-et
         * építene.
         */
        fun normalizeIngestBase(raw: String, streamPath: String = DEFAULT_STREAM_PATH): String {
            var value = raw.trim().trimEnd('/')
            if (value.endsWith("/whip", ignoreCase = true)) {
                value = value.dropLast("/whip".length).trimEnd('/')
                val tail = "/" + streamPath.trim('/')
                if (tail.length > 1 && value.endsWith(tail, ignoreCase = true)) {
                    value = value.dropLast(tail.length).trimEnd('/')
                }
            }
            return value
        }
    }
}

class AppSettings(private val context: Context) {

    private object Keys {
        val ingestUrl = stringPreferencesKey("ingest_url")
        val controlUrl = stringPreferencesKey("control_url")
        val streamPath = stringPreferencesKey("stream_path")
        val streamKey = stringPreferencesKey("stream_key")
        val ingestUser = stringPreferencesKey("ingest_user")
        val resolution = stringPreferencesKey("resolution")
        val fps = intPreferencesKey("fps")
        val videoBitrate = intPreferencesKey("video_bitrate_kbps")
        val audioSampleRate = intPreferencesKey("audio_sample_rate")
        val audioBitrate = intPreferencesKey("audio_bitrate_kbps")
        val lens = stringPreferencesKey("lens")
        val source = stringPreferencesKey("source")
        val oemGuideDismissed = booleanPreferencesKey("oem_guide_dismissed")
        val turnUrl = stringPreferencesKey("turn_url")
        val turnUsername = stringPreferencesKey("turn_username")
        val turnCredential = stringPreferencesKey("turn_credential")
    }

    val flow: Flow<Settings> = context.dataStore.data.map { p ->
        Settings(
            ingestBaseUrl = p[Keys.ingestUrl] ?: Settings.DEFAULT_INGEST_URL,
            controlBaseUrl = p[Keys.controlUrl] ?: Settings.DEFAULT_CONTROL_URL,
            streamPath = p[Keys.streamPath] ?: Settings.DEFAULT_STREAM_PATH,
            streamKey = p[Keys.streamKey] ?: "",
            ingestUser = p[Keys.ingestUser] ?: Settings.DEFAULT_INGEST_USER,
            resolution = VideoResolution.fromName(p[Keys.resolution]),
            frameRate = FrameRate.fromFps(p[Keys.fps]),
            videoBitrateKbps = p[Keys.videoBitrate]
                ?: VideoBitrate.recommendedKbps(
                    VideoResolution.fromName(p[Keys.resolution]),
                    FrameRate.fromFps(p[Keys.fps]),
                ),
            audioSampleRate = AudioSampleRate.fromHz(p[Keys.audioSampleRate]),
            audioBitrate = AudioBitrate.fromKbps(p[Keys.audioBitrate]),
            lens = LensKind.fromName(p[Keys.lens]),
            source = if (p[Keys.source] == CaptureSource.SCREEN.name) CaptureSource.SCREEN else CaptureSource.CAMERA,
            oemGuideDismissed = p[Keys.oemGuideDismissed] ?: false,
            turnUrl = p[Keys.turnUrl] ?: "",
            turnUsername = p[Keys.turnUsername] ?: "",
            turnCredential = p[Keys.turnCredential] ?: "",
        )
    }

    suspend fun current(): Settings = flow.first()

    suspend fun setEndpoints(
        ingest: String,
        control: String,
        path: String,
        key: String,
        ingestUser: String = Settings.DEFAULT_INGEST_USER,
    ) = context.dataStore.edit {
        it[Keys.ingestUrl] = ingest
        it[Keys.controlUrl] = control
        it[Keys.streamPath] = path
        it[Keys.streamKey] = key
        it[Keys.ingestUser] = ingestUser
    }

    suspend fun setResolution(value: VideoResolution) =
        context.dataStore.edit { it[Keys.resolution] = value.name }

    suspend fun setFrameRate(value: FrameRate) =
        context.dataStore.edit { it[Keys.fps] = value.fps }

    suspend fun setVideoBitrate(kbps: Int) =
        context.dataStore.edit {
            it[Keys.videoBitrate] = kbps.coerceIn(VideoBitrate.MIN_KBPS, VideoBitrate.MAX_KBPS)
        }

    suspend fun setAudioSampleRate(value: AudioSampleRate) =
        context.dataStore.edit { it[Keys.audioSampleRate] = value.hz }

    suspend fun setAudioBitrate(value: AudioBitrate) =
        context.dataStore.edit { it[Keys.audioBitrate] = value.kbps }

    suspend fun setLens(value: LensKind) =
        context.dataStore.edit { it[Keys.lens] = value.name }

    suspend fun setSource(value: CaptureSource) =
        context.dataStore.edit { it[Keys.source] = value.name }

    suspend fun setTurn(url: String, username: String, credential: String) =
        context.dataStore.edit {
            it[Keys.turnUrl] = url
            it[Keys.turnUsername] = username
            it[Keys.turnCredential] = credential
        }

    suspend fun dismissOemGuide() =
        context.dataStore.edit { it[Keys.oemGuideDismissed] = true }
}
