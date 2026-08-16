package com.galandras.onlive.stream

import androidx.camera.core.Preview
import com.galandras.onlive.settings.CaptureSource
import com.galandras.onlive.settings.LensKind
import com.galandras.onlive.settings.LensOption
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

/**
 * A telefon oldali kapcsolat-állapot.
 *
 * FONTOS: ez NEM az adás állapotgépe. Az intro/outro/live/paused üzleti
 * állapotgép a vezérlő szerveren él (4. szegmens); az app csak azt tudja,
 * hogy éppen küld-e adatot, vagy sem. A `PAUSED` itt is szerepel, mert a
 * felhasználó szándékát tükrözi — a szerver felé viszont ettől függetlenül
 * külön `POST /session/pause` megy.
 */
enum class ConnectionState {
    /** Nincs aktív session. */
    IDLE,

    /** WHIP publish folyamatban (SDP csere, ICE). */
    CONNECTING,

    /** Megy az adás. */
    LIVE,

    /** Nem szándékos szakadás — exponenciális backoff-fal újrapróbálkozunk. */
    RECONNECTING,

    /** Szándékos, felhasználó által kért szünet — NINCS backoff-timer. */
    PAUSED,

    /** Nem helyreállítható hiba (pl. hibás streamkulcs). */
    ERROR,
}

/** Élő statisztika, amit a szerver felé is felküldünk (admin UI-n látszik). */
data class StreamStats(
    val videoBitrateKbps: Int = 0,
    val audioBitrateKbps: Int = 0,
    val fps: Int = 0,
    val rttMs: Int = 0,
    /** Hálózati ingadozás — a 9. szegmens monitor-panelje ezt is mutatja. */
    val jitterMs: Double = 0.0,
    val packetLossPercent: Double = 0.0,
    val uptimeSeconds: Long = 0,
)

/**
 * Kölcsönös kapcsolat-visszajelzés (1.0.102).
 *
 * A rendszernek **három külön** kapcsolata van, és bármelyik állhat úgy, hogy a
 * másik kettő hibátlan:
 *
 *   1. **vezérlés** — HTTP a vezérlő szerverre (gombnyomások, telemetria),
 *   2. **WHIP publish** — a média feltöltése a MediaMTX-hez,
 *   3. **amit a szerver LÁT** — érkezik-e onnan nézve tényleg kép.
 *
 * Eddig csak a végeredmény látszott („Újracsatlakozás…"), az ok nem. Ez a
 * három sor mindegyikről külön mond igent vagy nemet, és a hibát szövegesen
 * is megmutatja — a szerver nézetét is beleértve, amit ő maga küld vissza
 * minden válaszban.
 */
data class LinkStatus(
    val controlOk: Boolean = false,
    val controlDetail: String = "még nem próbáltuk",
    val whipOk: Boolean = false,
    val whipDetail: String = "még nem próbáltuk",
    /** A szerver saját válasza: érkezik-e hozzá kép. */
    val serverSeesMedia: Boolean = false,
    val serverDetail: String = "nincs visszajelzés",
    /** Melyik úton megyünk (helyi vagy alagút) — 1.0.101. */
    val route: String = "",
) {
    /** Minden rendben: mindhárom láb áll. */
    val allOk: Boolean get() = controlOk && whipOk && serverSeesMedia
}

data class StreamUiState(
    val connection: ConnectionState = ConnectionState.IDLE,
    val source: CaptureSource = CaptureSource.CAMERA,
    val lens: LensKind = LensKind.MAIN,
    val availableLenses: List<LensOption> = emptyList(),
    val torchOn: Boolean = false,
    val localRecording: Boolean = false,
    val stats: StreamStats = StreamStats(),
    val reconnectAttempt: Int = 0,
    val nextRetryInSeconds: Int = 0,
    val message: String? = null,
    val errorMessage: String? = null,
    val link: LinkStatus = LinkStatus(),
)

/**
 * Egyirányú állapot-busz a Service és az UI között.
 *
 * Szándékosan nem binder/AIDL: az Activity bármikor meghalhat és újraéledhet
 * (appváltás, PIP, elforgatás), a Service viszont végig él. A busz a
 * processz élettartamához kötött, így az Activity újraindulásakor azonnal a
 * valós állapotot látja, kötés-újraépítés nélkül.
 */
object StreamBus {

    private val _state = MutableStateFlow(StreamUiState())
    val state: StateFlow<StreamUiState> = _state.asStateFlow()

    /**
     * A CameraX Preview use case felülete. Az Activity teszi be, amikor van
     * látható UI, és `null`-ra állítja, amikor eltűnik — a kamera-session
     * viszont a Service-ben marad, ezért a capture nem szakad meg.
     */
    private val _surfaceProvider = MutableStateFlow<Preview.SurfaceProvider?>(null)
    val surfaceProvider: StateFlow<Preview.SurfaceProvider?> = _surfaceProvider.asStateFlow()

    fun attachPreview(provider: Preview.SurfaceProvider?) {
        _surfaceProvider.value = provider
    }

    fun update(block: (StreamUiState) -> StreamUiState) = _state.update(block)

    fun setConnection(state: ConnectionState, error: String? = null) = update {
        it.copy(
            connection = state,
            errorMessage = if (state == ConnectionState.ERROR) error else null,
            reconnectAttempt = if (state == ConnectionState.RECONNECTING) it.reconnectAttempt else 0,
            nextRetryInSeconds = if (state == ConnectionState.RECONNECTING) it.nextRetryInSeconds else 0,
        )
    }

    fun setMessage(text: String?) = update { it.copy(message = text) }

    /** Egy-egy láb állapotának frissítése (1.0.102). */
    fun updateLink(block: (LinkStatus) -> LinkStatus) = update { it.copy(link = block(it.link)) }
}
