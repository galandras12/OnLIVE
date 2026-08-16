package com.galandras.onlive.settings

/**
 * Melyik úton érjük el a szervert (1.0.101).
 *
 * MIÉRT VAN EZ EGYÁLTALÁN: a Cloudflare Tunnelen a WHIP **jelzés** átmegy, a
 * WebRTC **média nem** — ahhoz TURN relay kell. Ha viszont a telefon és a
 * szerver ugyanazon a hálózaton van (otthoni wifi), vagy ugyanabban a Tailscale
 * hálózatban, akkor az alagút megkerülhető: a kép a hálózaton belül marad.
 * Ilyenkor TURN nélkül is van adás, és a késleltetés is kisebb.
 *
 * A döntés szándékosan **tiszta függvény**: a hálózati próbát a hívó végzi el,
 * itt csak a szabály él. Így az elágazások végiggondolhatók anélkül, hogy
 * hálózatot kellene szimulálni.
 */
enum class ConnectionMode(val label: String, val hint: String) {
    /** Ha a helyi cím válaszol, azt használjuk; ha nem, megyünk az alagúton. */
    AUTO(
        "Automatikus",
        "Ha a helyi cím elérhető, azon megy — különben a Tunnelen. Ez az ajánlott.",
    ),

    /** Csak a helyi cím. Ha nincs megadva, ezt meg is mondjuk. */
    LOCAL_ONLY(
        "Csak helyi",
        "Kizárólag LAN / Tailscale. Ha a szerver nem érhető el helyben, nem indul adás.",
    ),

    /** Csak a publikus Tunnel-cím — akkor is, ha van helyi cím. */
    TUNNEL_ONLY(
        "Csak Tunnel",
        "Kizárólag a publikus címek. A médiához TURN kell.",
    );

    companion object {
        val DEFAULT = AUTO
        fun fromName(name: String?): ConnectionMode = entries.firstOrNull { it.name == name } ?: DEFAULT
    }
}

/**
 * A ténylegesen használandó címek.
 *
 * @param reason emberi mondat arról, MIÉRT ez lett — ez kerül a naplóba és a
 *   beállítás-képernyő kapcsolat-tesztjébe. Néma választás helyett látható
 *   választás: ha valaki „csak helyit" kért, de az nincs kitöltve, azt tudnia
 *   kell, nem pedig azon csodálkozni, miért megy mégis az alagúton.
 */
data class ResolvedEndpoints(
    val control: String,
    val whip: String,
    val isLocal: Boolean,
    val reason: String,
)

object Endpoints {

    /**
     * @param localReachable a helyi vezérlő cím válaszolt-e az imént
     *   (a hívó méri meg; `AUTO` módban ez dönt)
     */
    fun choose(settings: Settings, localReachable: Boolean): ResolvedEndpoints {
        val tunnel = ResolvedEndpoints(
            control = settings.controlBaseUrl.trimEnd('/'),
            whip = settings.whipUrl,
            isLocal = false,
            reason = "Publikus cím (Cloudflare Tunnel).",
        )
        val local = ResolvedEndpoints(
            control = settings.localControlBaseUrl.trimEnd('/'),
            whip = settings.localWhipUrl,
            isLocal = true,
            reason = "Helyi cím (LAN / Tailscale) — a média nem megy ki az internetre.",
        )

        return when (settings.connectionMode) {
            ConnectionMode.TUNNEL_ONLY -> tunnel

            ConnectionMode.LOCAL_ONLY ->
                if (settings.hasLocalEndpoints) {
                    local
                } else {
                    tunnel.copy(
                        reason = "A „Csak helyi” mód van kiválasztva, de nincs megadva helyi cím — " +
                            "a publikus címre esik vissza.",
                    )
                }

            ConnectionMode.AUTO ->
                if (settings.hasLocalEndpoints && localReachable) {
                    local
                } else if (settings.hasLocalEndpoints) {
                    tunnel.copy(reason = "A helyi cím nem válaszolt — publikus címen megyünk.")
                } else {
                    tunnel
                }
        }
    }
}
