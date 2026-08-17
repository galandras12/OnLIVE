package com.galandras.onlive.settings

import org.json.JSONObject

/**
 * A szervertől kapott párosító csomag (1.0.110).
 *
 * MIÉRT VAN: eddig minden címet, a stream útvonalat és a kulcsot kézzel kellett
 * begépelni. Az elmúlt kiadások hibái sorra ebből jöttek — egy `/admin`
 * végződés, egy bennfelejtett `/ingest`, egy elgépelt kulcs —, és egyik sem
 * hibaüzenetet adott, hanem néma nem-működést. A szerver viszont ismeri a
 * helyes értékeket, tehát átadhatja őket.
 *
 * Két úton érkezhet, mindkettő ingyenes és felhő nélküli:
 *
 *   · **mély hivatkozás** (`onlive://pair?token=…&server=…`) — az admin oldalt
 *     a telefonon megnyitva egy koppintás, az app pedig letölti a csomagot;
 *   · **fájl** (`onlive-pairing.json`) — hálózat sem kell hozzá.
 *
 * A csomag a **nyers streamkulcsot** tartalmazza, tehát titok. A fájlt
 * használat után törölni kell — ezt a felület ki is írja.
 */
data class PairingPayload(
    val control: String,
    val ingest: String,
    val localControl: String,
    val localIngest: String,
    val streamPath: String,
    val ingestUser: String,
    val streamKey: String,
    val turnUrl: String,
    val turnUsername: String,
    val turnCredential: String,
) {
    /** Rövid összefoglaló a felhasználónak — kulcs nélkül. */
    val summary: String
        get() = buildString {
            append("Vezérlő: $control\n")
            append("Ingest: $ingest\n")
            if (localControl.isNotBlank()) append("Helyi: $localControl / $localIngest\n")
            append("Útvonal: $streamPath")
            if (turnUrl.isNotBlank()) append("\nTURN: $turnUrl")
        }

    companion object {
        /**
         * Beolvasás és ellenőrzés.
         *
         * A címeket ugyanazon a normalizáláson engedjük át, mint a kézi bevitelt
         * — így egy régi vagy kézzel szerkesztett csomag sem tud útvonalat
         * becsempészni az alap-címbe.
         */
        fun parse(raw: String): Result<PairingPayload> = runCatching {
            val json = JSONObject(raw)

            require(json.optString("onlive") == "pairing") {
                "Ez nem OnLIVE párosító fájl."
            }
            require(json.optInt("version", 0) == 1) {
                "Ismeretlen párosító formátum (verzió: ${json.optInt("version", 0)}). " +
                    "Frissítsd az appot vagy a szervert."
            }

            val server = json.optJSONObject("server") ?: JSONObject()
            val turn = json.optJSONObject("turn") ?: JSONObject()
            val streamPath = json.optString("streamPath", Settings.DEFAULT_STREAM_PATH)
                .trim().trim('/')
                .ifBlank { Settings.DEFAULT_STREAM_PATH }

            val payload = PairingPayload(
                control = Settings.normalizeControlBase(server.optString("control")),
                ingest = Settings.normalizeIngestBase(server.optString("ingest"), streamPath),
                localControl = Settings.normalizeControlBase(server.optString("localControl")),
                localIngest = Settings.normalizeIngestBase(server.optString("localIngest"), streamPath),
                streamPath = streamPath,
                ingestUser = json.optString("ingestUser", Settings.DEFAULT_INGEST_USER)
                    .ifBlank { Settings.DEFAULT_INGEST_USER },
                streamKey = json.optString("streamKey").trim(),
                turnUrl = turn.optString("url").trim(),
                turnUsername = turn.optString("username").trim(),
                turnCredential = turn.optString("credential").trim(),
            )

            require(payload.control.isNotBlank()) { "A csomagban nincs vezérlő szerver cím." }
            require(payload.ingest.isNotBlank()) { "A csomagban nincs ingest cím." }
            require(payload.streamKey.isNotBlank()) { "A csomagban nincs streamkulcs." }
            payload
        }
    }
}
