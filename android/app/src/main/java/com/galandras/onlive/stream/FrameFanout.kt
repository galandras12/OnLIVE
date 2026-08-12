package com.galandras.onlive.stream

import org.webrtc.CapturerObserver
import org.webrtc.VideoFrame

/**
 * Egyetlen belépési pont a képkockáknak, forrástól függetlenül.
 *
 * Ide tolja a [CameraSource] (CameraX ImageAnalysis) és a [ScreenSource]
 * (MediaProjection + SurfaceTextureHelper) is a frame-eket. A fanout:
 *   1. továbbadja a WebRTC-nek (ha épp van élő session),
 *   2. eltárolja a legutolsó képkockát a „fényképezőgép" gombhoz.
 *
 * Ez teszi lehetővé, hogy a kamera↔képernyő váltás és a lencseváltás NE
 * igényeljen WebRTC újratárgyalást: a PeerConnection ugyanazt a VideoSource-ot
 * látja végig, csak más tolja bele a képet.
 */
class FrameFanout {

    /** A WebRTC oldali fogadó. Null, amíg nincs publish session. */
    @Volatile
    var downstream: CapturerObserver? = null

    private val lastFrameLock = Any()
    private var lastFrame: VideoFrame? = null

    fun onFrame(frame: VideoFrame) {
        synchronized(lastFrameLock) {
            lastFrame?.release()
            frame.retain()
            lastFrame = frame
        }
        downstream?.onFrameCaptured(frame)
    }

    /**
     * A legutóbbi képkocka kikérése fotó mentéshez.
     * A hívó felelőssége a [VideoFrame.release] meghívása!
     */
    fun acquireLastFrame(): VideoFrame? = synchronized(lastFrameLock) {
        lastFrame?.also { it.retain() }
    }

    fun clear() = synchronized(lastFrameLock) {
        lastFrame?.release()
        lastFrame = null
    }
}
