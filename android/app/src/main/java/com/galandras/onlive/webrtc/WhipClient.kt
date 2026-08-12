package com.galandras.onlive.webrtc

import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.Credentials
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.net.URI
import java.util.concurrent.TimeUnit

/**
 * WHIP (WebRTC-HTTP Ingestion Protocol, RFC 9725) kliens.
 *
 * A protokoll a lehető legegyszerűbb:
 *   1. `POST <whipUrl>`  törzs: SDP offer, `Content-Type: application/sdp`
 *   2. válasz: `201 Created`, törzs: SDP answer, `Location:` a session erőforrás URL-je
 *   3. `DELETE <resourceUrl>` a publish lezárásához
 *
 * Hitelesítés: HTTP **Basic** (`publisher` + streamkulcs). A MediaMTX belső
 * auth módja Basic fejlécet és query paramétert fogad el; a Bearer token a
 * `jwt` módhoz tartozik, ezért itt nem használható. A vezérlő szerver felé
 * viszont Bearer megy — az a saját API-nk (lásd docs/INGEST.md 2. fejezet).
 *
 * Trickle ICE-t szándékosan NEM használunk: megvárjuk az ICE gathering
 * végét, és egyetlen, teljes offert küldünk. Így nincs szükség PATCH-re,
 * és a Cloudflare Tunnelen is egyetlen kérés megy át.
 *
 * FIGYELEM: ezen a HTTP-úton csak a JELZÉS megy. A tényleges média
 * (SRTP/ICE) nem az alagúton keresztül folyik — lásd docs/NETWORKING.md
 * 3. fejezet (TURN relay szükséges).
 */
class WhipClient(
    private val client: OkHttpClient = defaultClient(),
) {

    data class Session(val answerSdp: String, val resourceUrl: String?)

    /** Nem újrapróbálható hiba (pl. rossz streamkulcs) — nincs értelme backoffnak. */
    class FatalWhipException(message: String) : IOException(message)

    suspend fun publish(
        whipUrl: String,
        offerSdp: String,
        streamKey: String,
        ingestUser: String = DEFAULT_INGEST_USER,
    ): Session =
        withContext(Dispatchers.IO) {
            val request = Request.Builder()
                .url(whipUrl)
                .post(offerSdp.toRequestBody(SDP_MEDIA_TYPE))
                .header("Content-Type", "application/sdp")
                .apply {
                    if (streamKey.isNotBlank()) {
                        header("Authorization", Credentials.basic(ingestUser, streamKey))
                    }
                }
                .build()

            client.newCall(request).execute().use { response ->
                val body = response.body?.string().orEmpty()

                if (response.code == 401 || response.code == 403) {
                    throw FatalWhipException(
                        "A szerver elutasította a streamkulcsot (HTTP ${response.code}). " +
                            "Ellenőrizd a beállításokban megadott kulcsot."
                    )
                }
                if (!response.isSuccessful) {
                    throw IOException("WHIP publish sikertelen: HTTP ${response.code} — $body")
                }
                if (body.isBlank()) {
                    throw IOException("A WHIP válasz nem tartalmaz SDP answert.")
                }

                val location = response.header("Location")
                val resourceUrl = location?.let { resolve(whipUrl, it) }
                Log.i(TAG, "WHIP publish OK, resource: $resourceUrl")
                Session(answerSdp = body, resourceUrl = resourceUrl)
            }
        }

    /** A publish lezárása. Hiba esetén csak naplózunk — a leállást nem blokkolhatja. */
    suspend fun delete(
        resourceUrl: String?,
        streamKey: String,
        ingestUser: String = DEFAULT_INGEST_USER,
    ) = withContext(Dispatchers.IO) {
        if (resourceUrl.isNullOrBlank()) return@withContext
        runCatching {
            val request = Request.Builder()
                .url(resourceUrl)
                .delete()
                .apply {
                    if (streamKey.isNotBlank()) {
                        header("Authorization", Credentials.basic(ingestUser, streamKey))
                    }
                }
                .build()
            client.newCall(request).execute().use { Log.i(TAG, "WHIP delete: HTTP ${it.code}") }
        }.onFailure { Log.w(TAG, "WHIP delete sikertelen: ${it.message}") }
    }

    private fun resolve(baseUrl: String, location: String): String =
        runCatching { URI(baseUrl).resolve(location).toString() }.getOrDefault(location)

    companion object {
        private const val TAG = "OnLIVE/WHIP"
        const val DEFAULT_INGEST_USER = "publisher"
        private val SDP_MEDIA_TYPE = "application/sdp".toMediaType()

        fun defaultClient(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(15, TimeUnit.SECONDS)
            .writeTimeout(15, TimeUnit.SECONDS)
            .retryOnConnectionFailure(false) // az újrapróbálkozás a backoff-logika dolga
            .build()
    }
}
