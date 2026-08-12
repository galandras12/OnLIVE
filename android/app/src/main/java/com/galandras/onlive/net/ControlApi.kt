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

    suspend fun sessionStats(settings: Settings, stats: StreamStats, state: String): Result<Unit> =
        post(
            settings,
            "stats",
            JSONObject()
                .put("state", state)
                .put("videoBitrateKbps", stats.videoBitrateKbps)
                .put("audioBitrateKbps", stats.audioBitrateKbps)
                .put("fps", stats.fps)
                .put("rttMs", stats.rttMs)
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
