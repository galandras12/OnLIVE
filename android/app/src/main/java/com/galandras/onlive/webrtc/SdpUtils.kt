package com.galandras.onlive.webrtc

/**
 * Minimális SDP-manipuláció.
 *
 * Csak azt csináljuk meg SDP-szinten, amit a WebRTC API-n keresztül nem
 * lehet megbízhatóan beállítani:
 *  - Opus átlagos bitráta (`maxaveragebitrate`),
 *  - H.264 preferálása (a hardveres enkóder és az OBS/böngésző kompatibilitás miatt).
 *
 * A videó bitrátát NEM itt állítjuk (nincs `b=AS` hack): arra az
 * `RtpSender.setParameters(maxBitrateBps)` a helyes API.
 */
object SdpUtils {

    /** Beállítja az Opus fmtp sorában a kért átlagos bitrátát (kbps → bps). */
    fun setOpusBitrate(sdp: String, kbps: Int): String {
        val opusPayload = Regex("""a=rtpmap:(\d+)\s+opus/48000""", RegexOption.IGNORE_CASE)
            .find(sdp)?.groupValues?.get(1) ?: return sdp

        val bps = kbps * 1000
        val fmtpRegex = Regex("""a=fmtp:$opusPayload (.*)""")
        val existing = fmtpRegex.find(sdp)

        return if (existing != null) {
            val params = existing.groupValues[1]
                .split(';')
                .map { it.trim() }
                .filter { it.isNotEmpty() && !it.startsWith("maxaveragebitrate") && !it.startsWith("stereo") }
            val merged = (params + "stereo=0" + "maxaveragebitrate=$bps").joinToString(";")
            sdp.replace(existing.value, "a=fmtp:$opusPayload $merged")
        } else {
            sdp.replace(
                Regex("""(a=rtpmap:$opusPayload opus/48000[^\r\n]*)"""),
                "$1\r\na=fmtp:$opusPayload stereo=0;maxaveragebitrate=$bps",
            )
        }
    }

    /**
     * A videó m-sor payload-listáját úgy rendezi át, hogy a kért kodek
     * kerüljön előre. Ha a kodek nincs az SDP-ben, változatlanul visszaad.
     */
    fun preferVideoCodec(sdp: String, codec: String = "H264"): String {
        val lines = sdp.split(Regex("\r\n|\n")).toMutableList()
        val mLineIndex = lines.indexOfFirst { it.startsWith("m=video") }
        if (mLineIndex < 0) return sdp

        val payloads = lines
            .mapNotNull { Regex("""a=rtpmap:(\d+)\s+$codec/90000""", RegexOption.IGNORE_CASE).find(it) }
            .map { it.groupValues[1] }
        if (payloads.isEmpty()) return sdp

        val parts = lines[mLineIndex].split(" ").toMutableList()
        if (parts.size <= 3) return sdp

        val header = parts.subList(0, 3).toList()
        val rest = parts.subList(3, parts.size).toList()
        val reordered = payloads + rest.filterNot { it in payloads }
        lines[mLineIndex] = (header + reordered).joinToString(" ")

        return lines.joinToString("\r\n")
    }
}
