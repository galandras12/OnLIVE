package com.galandras.onlive.net

import android.os.Build
import android.util.Log
import com.galandras.onlive.settings.ConnectionMode
import com.galandras.onlive.settings.Endpoints
import com.galandras.onlive.settings.ResolvedEndpoints
import com.galandras.onlive.settings.Settings
import com.galandras.onlive.stream.StreamStats
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
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

    /**
     * A helyi cím próbájához KÜLÖN, rövid időzítésű kliens (1.0.101).
     *
     * A 8 másodperces alap-időzítés itt elfogadhatatlan: `AUTO` módban ez a
     * próba minden adásindítás előtt lefut, és ha a telefon épp mobilneten van
     * (tehát a LAN-cím elérhetetlen), akkor 8 másodpercig állna a „Kezdés"
     * gomb, mielőtt az alagútra váltana. Egy nem válaszoló helyi címről 1,5
     * másodperc alatt is kiderül minden, amit tudni kell.
     */
    private val probeClient: OkHttpClient = client.newBuilder()
        .connectTimeout(PROBE_TIMEOUT_MS, TimeUnit.MILLISECONDS)
        .readTimeout(PROBE_TIMEOUT_MS, TimeUnit.MILLISECONDS)
        .build()

    /** A legutóbbi próba eredménye — hogy ne mérjünk minden kérésnél. */
    private var localProbe: Pair<String, Boolean>? = null
    private var localProbeAt = 0L

    /**
     * Melyik címeket használjuk MOST.
     *
     * `AUTO` módban megméri, válaszol-e a helyi cím, és a mérést rövid ideig
     * megjegyzi. A [Endpoints.choose] maga tiszta függvény — itt csak a mérés
     * történik.
     */
    suspend fun resolveEndpoints(settings: Settings): ResolvedEndpoints {
        val needsProbe = settings.connectionMode == ConnectionMode.AUTO && settings.hasLocalEndpoints
        val reachable = if (needsProbe) isLocalReachable(settings) else false
        return Endpoints.choose(settings, reachable)
    }

    /**
     * A párosító csomag letöltése a tokennel (1.0.110).
     *
     * A token MAGA a hitelesítés: egyszer használható, rövid életű. Ezért nem
     * kell hozzá streamkulcs — épp azt hozza el.
     */
    suspend fun fetchPairing(server: String, token: String): Result<String> =
        withContext(Dispatchers.IO) {
            runCatching {
                val base = server.trim().trimEnd('/')
                require(base.isNotBlank()) { "A párosító link nem tartalmaz szerver címet." }

                val request = Request.Builder().url("$base/api/pair/$token").get().build()
                client.newCall(request).execute().use { response ->
                    val body = response.body?.string().orEmpty()
                    when (response.code) {
                        200 -> body
                        404 -> error(
                            "A párosítás lejárt vagy már felhasználták. " +
                                "Indíts újat az admin felületen (Streamkulcs fül).",
                        )
                        429 -> error("Túl sok próbálkozás — várj egy kicsit.")
                        else -> error("A szerver HTTP ${response.code} választ adott.")
                    }
                }
            }.onFailure { Log.w(TAG, "párosítás letöltése sikertelen: ${it.message}") }
        }

    /** A gyorsítótár eldobása — hálózatváltásnál és adásindításnál hívjuk. */
    fun forgetLocalProbe() {
        localProbe = null
    }

    private suspend fun isLocalReachable(settings: Settings): Boolean = withContext(Dispatchers.IO) {
        val base = settings.localControlBaseUrl.trim().trimEnd('/')
        if (base.isBlank()) return@withContext false

        val cached = localProbe
        val age = System.currentTimeMillis() - localProbeAt
        // A NEMLEGES eredményt sokkal rövidebb ideig hisszük el, mint az
        // igenlőt (1.0.104). Egy Tailscale/VPN kapcsolat a felépülés első
        // pillanataiban még nem válaszol, de másodpercekkel később már igen —
        // ha a „nem elérhető" fél percig érvényben marad, a telefon addig
        // biztosan az alagúton próbálkozik, ahol viszont nincs médiaút.
        if (cached != null && cached.first == base) {
            val ttl = if (cached.second) PROBE_TTL_MS else PROBE_NEGATIVE_TTL_MS
            if (age < ttl) return@withContext cached.second
        }

        // Bármilyen HTTP válasz jó: azt méri, hogy a szerver ELÉRHETŐ-e ezen a
        // címen. Ha 401-et ad, az kulcs-probléma, nem útvonal-probléma — az
        // alagúton ugyanúgy 401 lenne, tehát nincs értelme miatta váltani.
        //
        // Kétszer próbálunk: az elsőt gyakran még a VPN/Tailscale útvonal
        // felépülése nyeli el.
        var reachable = false
        var lastError: String? = null
        repeat(PROBE_ATTEMPTS) { attempt ->
            if (reachable) return@repeat
            val result = runCatching {
                probeClient.newCall(
                    Request.Builder().url("$base/api/session/ping").get().build(),
                ).execute().use { true }
            }
            reachable = result.getOrDefault(false)
            lastError = result.exceptionOrNull()?.message
            if (!reachable && attempt < PROBE_ATTEMPTS - 1) delay(PROBE_RETRY_DELAY_MS)
        }

        localProbe = base to reachable
        localProbeAt = System.currentTimeMillis()
        Log.i(
            TAG,
            "Helyi cím próbája: $base → " +
                if (reachable) "elérhető" else "nem válaszol (${lastError ?: "időtúllépés"})",
        )
        reachable
    }

    /** A legutóbbi nyugta — a Service ebből tudja, mit lát a szerver. */
    @Volatile
    var lastAck: ServerAck? = null
        private set

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
    ): Result<StatsReply> =
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
        .put("orientation", s.orientation.wire)
        .put("width", s.captureWidth)
        .put("height", s.captureHeight)
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
    ): Result<StatsReply> = withContext(Dispatchers.IO) {
        runCatching {
            val url = "${resolveEndpoints(settings).control}/api/session/$endpoint"
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
                val payload = response.body?.string()
                val reply = StatsReply(commands = parseCommands(payload), ack = parseAck(payload))
                reply.ack?.let { lastAck = it }
                reply
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
            val resolved = resolveEndpoints(settings)
            val base = resolved.control.trim().trimEnd('/')
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
                            // A szerver a PUBLIKUS WHIP címét mondja meg; ha
                            // helyi úton értük el, a helyi cím a mérvadó.
                            whipUrl = if (resolved.isLocal) resolved.whip else json.optString("whipUrl", settings.whipUrl),
                            streamPath = json.optString("streamPath", settings.streamPath),
                            route = resolved.reason,
                            ack = parseAck(body),
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

    /**
     * A szerver nyugtája: mit lát ŐO (1.0.102).
     *
     * A vezérlő hívás sikere csak azt bizonyítja, hogy a HTTP út él. Azt, hogy
     * a KÉP is megérkezik-e, kizárólag a szerver tudja megmondani — ő kérdezi
     * a MediaMTX-et. Ezért olvassuk ki minden válaszból.
     */
    private fun parseAck(payload: String?): ServerAck? {
        if (payload.isNullOrBlank()) return null
        return runCatching {
            val ack = JSONObject(payload).optJSONObject("ack") ?: return null
            val ingest = ack.optJSONObject("ingest")
            ServerAck(
                state = ack.optString("state", "ismeretlen"),
                ingestAvailable = ingest?.optBoolean("available") ?: false,
                ingestFlowing = ingest?.optBoolean("flowing") ?: false,
                ingestStalled = ingest?.optBoolean("stalled") ?: false,
                tracks = ingest?.optInt("tracks", 0) ?: 0,
                at = ack.optString("at", ""),
            )
        }.getOrNull()
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
                val url = "${resolveEndpoints(settings).control}/api/session/$endpoint"
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

        /**
         * Ennyi ideig hisszük el a helyi cím próbájának eredményét. Elég
         * rövid ahhoz, hogy egy hálózatváltás után magától helyreálljon,
         * és elég hosszú ahhoz, hogy ne mérjünk minden telemetria-körnél.
         */
        private const val PROBE_TTL_MS = 30_000L

        /**
         * A nemleges eredmény ennyi ideig él. Rövid, mert egy VPN/Tailscale
         * kapcsolat másodpercek alatt felépülhet — a „nem érem el" nem
         * ragadhat be fél percre.
         */
        private const val PROBE_NEGATIVE_TTL_MS = 5_000L

        /**
         * Egy próba időkorlátja. A 8 másodperces alap-időzítés itt túl sok
         * lenne (annyit állna a „Kezdés" gomb mobilneten), 1,5 másodperc
         * viszont kevésnek bizonyult egy épp ébredő Tailscale-útvonalhoz.
         */
        private const val PROBE_TIMEOUT_MS = 2_500L
        private const val PROBE_ATTEMPTS = 2
        private const val PROBE_RETRY_DELAY_MS = 300L
        private val JSON = "application/json; charset=utf-8".toMediaType()
    }
}

/** A kapcsolat-teszt eredménye — ezt mutatja a beállítás-képernyő. */
/**
 * A szerver saját nézete a kapcsolatról (1.0.102).
 *
 * @param ingestFlowing a szerverhez ÉPPEN érkezik-e kép (a MediaMTX API-jából)
 * @param ingestAvailable létezik-e egyáltalán az útvonal a MediaMTX-ben
 */
data class ServerAck(
    val state: String,
    val ingestAvailable: Boolean,
    val ingestFlowing: Boolean,
    val ingestStalled: Boolean,
    val tracks: Int,
    val at: String,
)

/** A telemetria válasza: parancsok + a szerver nyugtája. */
data class StatsReply(
    val commands: List<RemoteCommand> = emptyList(),
    val ack: ServerAck? = null,
)

data class PingResult(
    val state: String,
    val whipUrl: String,
    val streamPath: String,
    /** Melyik úton ment a kérés — helyi vagy alagút (1.0.101). */
    val route: String = "",
    /** Mit lát a szerver (1.0.102). */
    val ack: ServerAck? = null,
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
        const val SET_ORIENTATION = "setOrientation"
        const val TORCH = "torch"
        const val PHOTO = "photo"
        const val RECORDING = "recording"
    }
}
