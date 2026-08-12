package com.galandras.onlive.webrtc

import android.content.Context
import android.util.Log
import com.galandras.onlive.settings.Settings
import com.galandras.onlive.stream.StreamStats
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import org.webrtc.AudioSource
import org.webrtc.AudioTrack
import org.webrtc.CapturerObserver
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.DefaultVideoEncoderFactory
import org.webrtc.EglBase
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RtpReceiver
import org.webrtc.RtpSender
import org.webrtc.RtpTransceiver
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import org.webrtc.VideoSource
import org.webrtc.VideoTrack
import org.webrtc.audio.JavaAudioDeviceModule
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * A WebRTC publish motor.
 *
 * Felelőssége szigorúan a jelzés + a küldő oldali média-pipeline. NEM tud
 * semmit az adás állapotgépéről, az introról vagy az outróról — ezeket a
 * vezérlő szerver kezeli (4. szegmens).
 *
 * Tervezési döntés: a videó forrás (kamera vagy képernyő) NEM befolyásolja
 * a PeerConnection felépítését. Egyetlen [VideoSource] van, amibe hol a
 * kamera, hol a képernyő-capturer tolja a képkockákat — így a kamera↔képernyő
 * és a lencse↔lencse váltás NEM igényel újratárgyalást, és nem szakítja meg
 * az adást.
 */
class RtcEngine(
    context: Context,
    /**
     * A mikrofon mintavételi frekvenciája. Az AudioDeviceModule a
     * PeerConnectionFactory-hoz kötődik, ezért ez a beállítás csak a motor
     * újralétrehozásával változtatható — lásd [sampleRateHz] és a
     * StreamService `ensureEngine()` metódusát.
     */
    val sampleRateHz: Int,
) {

    private val appContext = context.applicationContext

    val eglBase: EglBase = EglBase.create()

    private val audioDeviceModule = JavaAudioDeviceModule.builder(appContext)
        .setSampleRate(sampleRateHz)
        .setUseHardwareAcousticEchoCanceler(false)
        .setUseHardwareNoiseSuppressor(false)
        .createAudioDeviceModule()

    private val factory: PeerConnectionFactory

    private var videoSource: VideoSource? = null
    private var videoTrack: VideoTrack? = null
    private var audioSource: AudioSource? = null
    private var audioTrack: AudioTrack? = null
    private var peerConnection: PeerConnection? = null
    private var videoSender: RtpSender? = null

    private var resourceUrl: String? = null
    private var lastVideoBytes = 0L
    private var lastAudioBytes = 0L
    private var lastStatsAt = 0L
    private var publishStartedAt = 0L

    private val whip = WhipClient()

    /** A capture rétegek ide tolják a képkockákat. Null, amíg nincs élő session. */
    val capturerObserver: CapturerObserver?
        get() = videoSource?.capturerObserver

    /** Kifelé jelzett PeerConnection állapotváltozás (a reconnect-logika használja). */
    var onConnectionStateChanged: ((PeerConnection.PeerConnectionState) -> Unit)? = null

    /**
     * Akkor hívódik, amikor a képkockák fogadója megváltozik: publish indulásakor
     * az új observerrel, leálláskor `null`-lal. A [com.galandras.onlive.stream.FrameFanout]
     * ebből tudja, hova (vagy hogy egyáltalán hova kell-e) továbbítani a frame-eket.
     */
    var onCapturerObserverChanged: ((CapturerObserver?) -> Unit)? = null

    init {
        PeerConnectionFactory.initialize(
            PeerConnectionFactory.InitializationOptions.builder(appContext)
                .createInitializationOptions()
        )
        factory = PeerConnectionFactory.builder()
            .setAudioDeviceModule(audioDeviceModule)
            .setVideoEncoderFactory(DefaultVideoEncoderFactory(eglBase.eglBaseContext, true, true))
            .setVideoDecoderFactory(DefaultVideoDecoderFactory(eglBase.eglBaseContext))
            .createPeerConnectionFactory()
    }

    /**
     * Felépíti a PeerConnectiont, és WHIP-en publikál.
     * Hiba esetén dob — az újrapróbálkozás a hívó (StreamService) dolga.
     */
    suspend fun publish(settings: Settings) {
        close(sendDelete = false)

        val iceServers = buildList {
            add(PeerConnection.IceServer.builder("stun:stun.cloudflare.com:3478").createIceServer())
            // A média NEM megy át a Cloudflare Tunnelen: TURN nélkül NAT mögül
            // jellemzően nem jön létre médiaút. Lásd docs/NETWORKING.md 3. fejezet.
            if (settings.turnUrl.isNotBlank()) {
                add(
                    PeerConnection.IceServer.builder(settings.turnUrl)
                        .setUsername(settings.turnUsername)
                        .setPassword(settings.turnCredential)
                        .createIceServer()
                )
            }
        }

        val config = PeerConnection.RTCConfiguration(iceServers).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
            bundlePolicy = PeerConnection.BundlePolicy.MAXBUNDLE
            rtcpMuxPolicy = PeerConnection.RtcpMuxPolicy.REQUIRE
            continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY
            enableCpuOveruseDetection = true
        }

        val gatheringComplete = CompletableDeferred<Unit>()

        val pc = factory.createPeerConnection(config, object : PeerConnection.Observer {
            override fun onIceGatheringChange(newState: PeerConnection.IceGatheringState?) {
                if (newState == PeerConnection.IceGatheringState.COMPLETE) {
                    gatheringComplete.complete(Unit)
                }
            }

            override fun onConnectionChange(newState: PeerConnection.PeerConnectionState) {
                Log.i(TAG, "PeerConnection állapot: $newState")
                onConnectionStateChanged?.invoke(newState)
            }

            override fun onSignalingChange(state: PeerConnection.SignalingState?) = Unit
            override fun onIceConnectionChange(state: PeerConnection.IceConnectionState?) = Unit
            override fun onIceConnectionReceivingChange(receiving: Boolean) = Unit
            override fun onIceCandidate(candidate: IceCandidate?) = Unit
            override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>?) = Unit
            override fun onAddTrack(receiver: RtpReceiver?, streams: Array<out MediaStream>?) = Unit
            override fun onAddStream(stream: MediaStream?) = Unit
            override fun onRemoveStream(stream: MediaStream?) = Unit
            override fun onDataChannel(channel: org.webrtc.DataChannel?) = Unit
            override fun onRenegotiationNeeded() = Unit
        }) ?: throw IllegalStateException("Nem sikerült létrehozni a PeerConnectiont.")

        peerConnection = pc

        // --- Videó: egyetlen forrás, amibe a kamera VAGY a képernyő tolja a képet ---
        val vSource = factory.createVideoSource(false).also { videoSource = it }
        vSource.adaptOutputFormat(
            settings.resolution.width,
            settings.resolution.height,
            settings.frameRate.fps,
        )
        val vTrack = factory.createVideoTrack(VIDEO_TRACK_ID, vSource).also { videoTrack = it }

        // --- Audió: mikrofon, feldolgozás nélkül (élő közvetítéshez ez a kívánatos) ---
        val aConstraints = MediaConstraints().apply {
            mandatory.add(MediaConstraints.KeyValuePair("googEchoCancellation", "false"))
            mandatory.add(MediaConstraints.KeyValuePair("googAutoGainControl", "false"))
            mandatory.add(MediaConstraints.KeyValuePair("googNoiseSuppression", "false"))
            mandatory.add(MediaConstraints.KeyValuePair("googHighpassFilter", "false"))
        }
        val aSource = factory.createAudioSource(aConstraints).also { audioSource = it }
        val aTrack = factory.createAudioTrack(AUDIO_TRACK_ID, aSource).also { audioTrack = it }

        // WHIP = csak küldés.
        val sendOnly = RtpTransceiver.RtpTransceiverInit(
            RtpTransceiver.RtpTransceiverDirection.SEND_ONLY,
            listOf(STREAM_ID),
        )
        pc.addTransceiver(vTrack, sendOnly)
        pc.addTransceiver(aTrack, sendOnly)
        videoSender = pc.senders.firstOrNull { it.track()?.kind() == "video" }

        applyVideoBitrate(settings.videoBitrateKbps)

        // --- SDP offer ---
        val offer = createOffer(pc)
        setLocalDescription(pc, offer)

        // Nem trickle: megvárjuk az ICE gathering végét (max 5 s), majd a
        // teljes, jelöltekkel együtt kigyűjtött SDP-t küldjük el.
        withTimeoutOrNull(ICE_GATHERING_TIMEOUT_MS) { gatheringComplete.await() }

        val localSdp = pc.localDescription?.description
            ?: throw IllegalStateException("Nincs local description az offer után.")

        val mungedOffer = SdpUtils.preferVideoCodec(
            SdpUtils.setOpusBitrate(localSdp, settings.audioBitrate.kbps),
            "H264",
        )

        val session = whip.publish(settings.whipUrl, mungedOffer, settings.streamKey)
        resourceUrl = session.resourceUrl

        setRemoteDescription(
            pc,
            SessionDescription(SessionDescription.Type.ANSWER, session.answerSdp),
        )

        publishStartedAt = System.currentTimeMillis()
        lastStatsAt = 0
        lastVideoBytes = 0
        lastAudioBytes = 0

        capturerObserver?.onCapturerStarted(true)
        onCapturerObserverChanged?.invoke(capturerObserver)
        Log.i(TAG, "Publish elindult: ${settings.whipUrl}")
    }

    /** Menet közbeni bitráta-módosítás, újratárgyalás nélkül. */
    fun applyVideoBitrate(kbps: Int) {
        val sender = videoSender ?: return
        val params = sender.parameters ?: return
        params.encodings.forEach { encoding ->
            encoding.maxBitrateBps = kbps * 1000
            encoding.minBitrateBps = (kbps * 1000 * 0.3).toInt()
        }
        sender.setParameters(params)
    }

    /** Menet közbeni felbontás/fps módosítás, újratárgyalás nélkül. */
    fun adaptOutput(width: Int, height: Int, fps: Int) {
        videoSource?.adaptOutputFormat(width, height, fps)
    }

    /** Az audió track némítása szünet közben (a session marad, csak nem megy hang). */
    fun setAudioEnabled(enabled: Boolean) {
        audioTrack?.setEnabled(enabled)
    }

    fun setVideoEnabled(enabled: Boolean) {
        videoTrack?.setEnabled(enabled)
    }

    suspend fun collectStats(): StreamStats {
        val pc = peerConnection ?: return StreamStats()
        val report = suspendCancellableCoroutine { cont ->
            pc.getStats { cont.resume(it) }
        }

        var videoBytes = 0L
        var audioBytes = 0L
        var fps = 0
        var rttMs = 0
        var packetsSent = 0L
        var packetsLost = 0L

        report.statsMap.values.forEach { stat ->
            when (stat.type) {
                "outbound-rtp" -> {
                    val kind = stat.members["kind"] as? String ?: stat.members["mediaType"] as? String
                    val bytes = (stat.members["bytesSent"] as? Number)?.toLong() ?: 0L
                    if (kind == "video") {
                        videoBytes += bytes
                        fps = (stat.members["framesPerSecond"] as? Number)?.toInt() ?: fps
                        packetsSent += (stat.members["packetsSent"] as? Number)?.toLong() ?: 0L
                    } else if (kind == "audio") {
                        audioBytes += bytes
                    }
                }

                "remote-inbound-rtp" -> {
                    packetsLost += (stat.members["packetsLost"] as? Number)?.toLong() ?: 0L
                    val rtt = (stat.members["roundTripTime"] as? Number)?.toDouble()
                    if (rtt != null && rtt > 0) rttMs = (rtt * 1000).toInt()
                }

                "candidate-pair" -> {
                    val nominated = stat.members["nominated"] as? Boolean ?: false
                    if (nominated && rttMs == 0) {
                        val rtt = (stat.members["currentRoundTripTime"] as? Number)?.toDouble()
                        if (rtt != null) rttMs = (rtt * 1000).toInt()
                    }
                }
            }
        }

        val now = System.currentTimeMillis()
        val elapsedSec = if (lastStatsAt == 0L) 0.0 else (now - lastStatsAt) / 1000.0
        val videoKbps = if (elapsedSec > 0) ((videoBytes - lastVideoBytes) * 8 / 1000.0 / elapsedSec).toInt() else 0
        val audioKbps = if (elapsedSec > 0) ((audioBytes - lastAudioBytes) * 8 / 1000.0 / elapsedSec).toInt() else 0

        lastStatsAt = now
        lastVideoBytes = videoBytes
        lastAudioBytes = audioBytes

        return StreamStats(
            videoBitrateKbps = videoKbps.coerceAtLeast(0),
            audioBitrateKbps = audioKbps.coerceAtLeast(0),
            fps = fps,
            rttMs = rttMs,
            packetLossPercent = if (packetsSent > 0) packetsLost * 100.0 / packetsSent else 0.0,
            uptimeSeconds = if (publishStartedAt == 0L) 0 else (now - publishStartedAt) / 1000,
        )
    }

    suspend fun close(sendDelete: Boolean = true, streamKey: String = "") {
        if (sendDelete) whip.delete(resourceUrl, streamKey)
        resourceUrl = null

        // Előbb elvágjuk a képkocka-utat, csak utána bontjuk le a forrásokat —
        // különben egy futó capture szál már felszabadított objektumba írna.
        onCapturerObserverChanged?.invoke(null)
        runCatching { capturerObserver?.onCapturerStopped() }

        peerConnection?.dispose()
        peerConnection = null
        videoSender = null

        videoTrack?.dispose(); videoTrack = null
        videoSource?.dispose(); videoSource = null
        audioTrack?.dispose(); audioTrack = null
        audioSource?.dispose(); audioSource = null
        publishStartedAt = 0
    }

    /** A teljes motor elengedése — a Service onDestroy-ában. */
    suspend fun release() {
        close(sendDelete = false)
        factory.dispose()
        audioDeviceModule.release()
        eglBase.release()
    }

    // ---------------------------------------------------------------------
    // SDP segédfüggvények (callback → coroutine)
    // ---------------------------------------------------------------------

    private suspend fun createOffer(pc: PeerConnection): SessionDescription =
        suspendCancellableCoroutine { cont ->
            pc.createOffer(object : SdpObserver {
                override fun onCreateSuccess(sdp: SessionDescription) = cont.resume(sdp)
                override fun onCreateFailure(error: String?) =
                    cont.resumeWithException(IllegalStateException("createOffer: $error"))

                override fun onSetSuccess() = Unit
                override fun onSetFailure(error: String?) = Unit
            }, MediaConstraints())
        }

    private suspend fun setLocalDescription(pc: PeerConnection, sdp: SessionDescription) =
        suspendCancellableCoroutine { cont ->
            pc.setLocalDescription(object : SdpObserver {
                override fun onSetSuccess() = cont.resume(Unit)
                override fun onSetFailure(error: String?) =
                    cont.resumeWithException(IllegalStateException("setLocalDescription: $error"))

                override fun onCreateSuccess(sdp: SessionDescription?) = Unit
                override fun onCreateFailure(error: String?) = Unit
            }, sdp)
        }

    private suspend fun setRemoteDescription(pc: PeerConnection, sdp: SessionDescription) =
        suspendCancellableCoroutine { cont ->
            pc.setRemoteDescription(object : SdpObserver {
                override fun onSetSuccess() = cont.resume(Unit)
                override fun onSetFailure(error: String?) =
                    cont.resumeWithException(IllegalStateException("setRemoteDescription: $error"))

                override fun onCreateSuccess(sdp: SessionDescription?) = Unit
                override fun onCreateFailure(error: String?) = Unit
            }, sdp)
        }

    companion object {
        private const val TAG = "OnLIVE/Rtc"
        private const val VIDEO_TRACK_ID = "onlive-video"
        private const val AUDIO_TRACK_ID = "onlive-audio"
        private const val STREAM_ID = "onlive"
        private const val ICE_GATHERING_TIMEOUT_MS = 5_000L
    }
}
