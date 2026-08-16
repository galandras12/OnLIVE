package com.galandras.onlive.net

import android.os.Build
import android.util.Log
import com.galandras.onlive.settings.Settings
import com.galandras.onlive.stream.StreamStats
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * A vezérlő szerver session-API-ja.
 *
 * Az app SEMMIT nem tud az intróról, az outróról vagy az overlay-ről — csak
 * annyit jelez, hogy a felhasználó mit nyomott meg. Hogy ebből intro lesz-e,
 * outro lesz-e, vagy „Megszakadt" képernyő, azt kizárólag a szerver
 * állapotgépe dönti el (4. szegmens).
 *
 *   POST /api/session/start   → a szerver INTRO állapotba vált
 *   POST /api/session/pause   → PAUSED (szándékos szünet, nincs backoff-timer)
 *   POST /api/session/resume  → vissza LIVE-ba
 *   POST /api/session/end     → OUTRO, majd OFFLINE
 *   POST /api/session/stats   → csak telemetria (bitráta, fps, RTT) az admin UI-nak
 *
 * Hitelesítés: `Authorization: Bearer <streamKey>` — ugyanaz a kulcs, mint a
 * WHIP ingestnél. Az admin jelszó a böngészőé, a telefon soha nem használja.
 */
class ControlApi(
    private val client: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(8, TimeUnit.SECONDS)
        .readTimeout(8, TimeUnit.SECONDS)
        .build(),
) {

    suspend fun sessionStart(settings: Settings): Result<Unit> =
        post(settings, "start", settingsPayload(settings))

    suspend fun sessionPause(settings: Settings): Result<Unit> =
        post(settings, "pause", JSONObject().put("reason", "user"))

    suspend fun sessionResume(settings: Settings): Result<Unit> =
        post(settings, "resume", settingsPayload(settings))

    suspend fun sessionEnd(settings: Settings): Result<Unit> =
        post(settings, "end", JSONObject().put("reason", "user"))

    /** A capture-beállítások menet közbeni változása (felbontás, lencse, forrás…). */
    suspend fun sessionConfig(settings: Settings): Result<Unit> =
        post(settings, "config", settingsPayload(settings))

    /**
     * Telemetria felküldése — és a VÁLASZBAN a szerver által ránk váró
     * parancsok (8. szegmens).
     *
     * A web UI-ról indított kamera-váltás, minőség-állítás vagy „Befejezés"
     * így plusz kérés nélkül, legfeljebb egy telemetria-ciklusnyi (3 mp)
     * késéssel jut el ide.
     */
    suspend fun sessionStats(
        settings: Settings,
        stats: StreamStats,
        state: String,
    ): Result<List<RemoteCommand>> =
        postForCommands(
            settings,
            "stats",
            JSONObject()
                .put("state", state)
                .put("videoBitrateKbps", stats.videoBitrateKbps)
                .put("audioBitrateKbps", stats.audioBitrateKbps)
                .put("fps", stats.fps)
                .put("rttMs", stats.rttMs)
                .put("jitterMs", stats.jitterMs)
                .put("packetLossPercent", stats.packetLossPercent)
                .put("uptimeSeconds", stats.uptimeSeconds),
        )

    /**
     * Az aktuális capture-beállítások — ez teszi lehetővé, hogy az admin web
     * UI-n is látszódjon, épp milyen minőséggel megy az adás.
     */
    private fun settingsPayload(s: Settings): JSONObject = JSONObject()
        .put("source", s.source.name.lowercase())
        .put("lens", s.lens.name.lowercase())
        .put("resolution", s.resolution.label)
        .put("width", s.resolution.width)
        .put("height", s.resolution.height)
        .put("fps", s.frameRate.fps)
        .put("videoBitrateKbps", s.videoBitrateKbps)
        .put(
            "audio",
            JSONObject()
                .put("sampleRate", s.audioSampleRate.hz)
                .put("bitrateKbps", s.audioBitrate.kbps),
        )
        .put("streamPath", s.streamPath)
        .put("device", "${Build.MANUFACTURER} ${Build.MODEL} (Android ${Build.VERSION.RELEASE})")

    /** Ugyanaz, mint a [post], de a válaszból kiolvassa a parancsokat is. */
    private suspend fun postForCommands(
        settings: Settings,
        endpoint: String,
        body: JSONObject,
    ): Result<List<RemoteCommand>> = withContext(Dispatchers.IO) {
        runCatching {
            val url = "${settings.controlBaseUrl.trimEnd('/')}/api/session/$endpoint"
            val request = Request.Builder()
                .url(url)
                .post(body.toString().toRequestBody(JSON))
                .apply {
                    if (settings.streamKey.isNotBlank()) {
                        header("Authorization", "Bearer ${settings.streamKey}")
                    }
                }
                .build()

            client.newCall(request).execute().use { response ->
                if (!response.isSuccessful) error("$endpoint → HTTP ${response.code}")
                parseCommands(response.body?.string())
            }
        }.onFailure {
            Log.w(TAG, "session/$endpoint sikertelen: ${it.message}")
        }
    }

    /**
     * Kapcsolat-teszt a beállítás-képernyőről (1.0.010).
     *
     * Ez az egyetlen hívás, aminek a hibáját MEG KELL mutatni a felhasználónak:
     * a többi (session, stats) csendben újrapróbálkozik, mert adás közben nem
     * szabad felugró üzenetekkel zavarni. Itt viszont épp azt teszteljük, hogy
     * jó-e a cím és a kulcs.
     */
    suspend fun ping(settings: Settings): Result<PingResult> = withContext(Dispatchers.IO) {
        runCatching {
            val base = settings.controlBaseUrl.trim().trimEnd('/')
            require(base.isNotBlank()) { "Nincs megadva a vezérlő szerver címe." }

            val pingUrl = "$base/api/session/ping"
            val request = Request.Builder()
                .url(pingUrl)
                .get()
                .apply {
                    if (settings.streamKey.isNotBlank()) {
                        header("Authorization", "Bearer ${settings.streamKey}")
                    }
                }
                .build()

            client.newCall(request).execute().use { response ->
                val body = response.body?.string().orEmpty()
                when (response.code) {
                    200 -> {
                        val json = JSONObject(body)
                        PingResult(
                            state = json.optString("state", "ismeretlen"),
                            whipUrl = json.optString("whipUrl", settings.whipUrl),
                            streamPath = json.optString("streamPath", settings.streamPath),
                        )
                    }
                    401 -> error("A streamkulcs nem jó. A webes felületen (Streamkulcs fül) hozz létre újat.")
                    429 -> error("Túl sok sikertelen próbálkozás — várj egy kicsit.")
                    // A leggyakoribb ok NEM az, hogy rossz a szerver: a mezőbe az
                    // admin OLDAL címe került (`.../admin`), az app pedig ehhez fűzi
                    // hozzá a saját útvonalát. Ezért mondjuk meg, mit hívtunk meg.
                    404 -> error(
                        "A cím elérhető, de ezen az útvonalon nincs OnLIVE szerver (HTTP 404).\n" +
                            "Meghívott cím: $pingUrl\n" +
                            "A mezőbe az ALAP-cím kell (pl. https://live.pelda.com), " +
                            "az /admin rész nélkül.",
                    )
                    else -> error("A szerver HTTP ${response.code} választ adott.")
                }
            }
        }.onFailure { Log.w(TAG, "ping sikertelen: ${it.message}") }
    }

    private fun parseCommands(payload: String?): List<RemoteCommand> {
        if (payload.isNullOrBlank()) return emptyList()
        return runCatching {
            val array: JSONArray = JSONObject(payload).optJSONArray("commands") ?: return emptyList()
            (0 until array.length()).mapNotNull { index ->
                val item = array.optJSONObject(index) ?: return@mapNotNull null
                val type = item.optString("type").takeIf { it.isNotBlank() } ?: return@mapNotNull null
                RemoteCommand(
                    id = item.optString("id"),
                    type = type,
                    payload = item.optJSONObject("payload") ?: JSONObject(),
                )
            }
        }.getOrDefault(emptyList())
    }

    private suspend fun post(settings: Settings, endpoint: String, body: JSONObject): Result<Unit> =
        withContext(Dispatchers.IO) {
            runCatching {
                val url = "${settings.controlBaseUrl.trimEnd('/')}/api/session/$endpoint"
                val request = Request.Builder()
                    .url(url)
                    .post(body.toString().toRequestBody(JSON))
                    .apply {
                        if (settings.streamKey.isNotBlank()) {
                            header("Authorization", "Bearer ${settings.streamKey}")
                        }
                    }
                    .build()

                client.newCall(request).execute().use { response ->
                    if (!response.isSuccessful) {
                        error("$endpoint → HTTP ${response.code}")
                    }
                }
            }.onFailure {
                // A vezérlő szerver elérhetetlensége NEM állíthatja meg a publish-t:
                // a média a MediaMTX felé megy, ettől függetlenül.
                Log.w(TAG, "session/$endpoint sikertelen: ${it.message}")
            }
        }

    companion object {
        private const val TAG = "OnLIVE/Control"
        private val JSON = "application/json; charset=utf-8".toMediaType()
    }
}

/** A kapcsolat-teszt eredménye — ezt mutatja a beállítás-képernyő. */
data class PingResult(
    val state: String,
    val whipUrl: String,
    val streamPath: String,
)

/**
 * A vezérlő szervertől érkező parancs (8. szegmens).
 *
 * A telefon SEMMIT nem értelmez az adás állapotgépéből — ezek konkrét,
 * végrehajtandó műveletek, ugyanazok, amiket a telefon gombjai is kiváltanak.
 */
data class RemoteCommand(
    val id: String,
    val type: String,
    val payload: JSONObject,
) {
    companion object {
        const val START = "start"
        const val PAUSE = "pause"
        const val RESUME = "resume"
        const val STOP = "stop"
        const val SET_LENS = "setLens"
        const val SET_SOURCE = "setSource"
        const val SET_QUALITY = "setQuality"
        const val TORCH = "torch"
        const val PHOTO = "photo"
        const val RECORDING = "recording"
    }
}
