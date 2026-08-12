package com.galandras.onlive.stream

import androidx.camera.core.ImageProxy
import org.webrtc.JavaI420Buffer
import java.nio.ByteBuffer

/**
 * CameraX [ImageProxy] (YUV_420_888) → WebRTC [JavaI420Buffer] konverzió.
 *
 * Miért kell egyáltalán: a CameraX ImageAnalysis CPU-oldali YUV puffereket ad,
 * a WebRTC VideoSource viszont I420-at (vagy textúrát) vár. A kamerát azért
 * mégis CameraX-szel kezeljük, mert a lencseváltás, a torch, a fókusz és a
 * párhuzamos helyi MP4-rögzítés így egyetlen, konzisztens API-n megy.
 *
 * Költség: 1080p30-nál ez másodpercenként ~93 MB memóriamásolás. Ha ez
 * mérhető gondot okoz (melegedés, akku), a felváltó megoldás a textúra-alapú
 * út: a CameraX Preview felületét egy SurfaceTextureHelper-nek adjuk, és
 * zero-copy textúra-frame-eket küldünk — lásd docs/ANDROID.md.
 */
object ImageProxyConverter {

    fun toI420(image: ImageProxy): JavaI420Buffer {
        val width = image.width
        val height = image.height
        val chromaWidth = (width + 1) / 2
        val chromaHeight = (height + 1) / 2

        val buffer = JavaI420Buffer.allocate(width, height)

        copyPlane(image.planes[0], width, height, buffer.dataY, buffer.strideY)
        copyPlane(image.planes[1], chromaWidth, chromaHeight, buffer.dataU, buffer.strideU)
        copyPlane(image.planes[2], chromaWidth, chromaHeight, buffer.dataV, buffer.strideV)

        return buffer
    }

    /**
     * Egy sík másolása a cél I420 pufferbe.
     *
     * Két esetet kell kezelni:
     *  - `pixelStride == 1`: sűrű (planar) sík, sorfolytonos másolás.
     *  - `pixelStride == 2`: félig síkolt (semi-planar, NV12/NV21) króma sík,
     *    ahol az U és V bájtok váltakoznak — minden második bájtot kell kiszedni.
     */
    private fun copyPlane(
        plane: ImageProxy.PlaneProxy,
        width: Int,
        height: Int,
        dst: ByteBuffer,
        dstStride: Int,
    ) {
        val src = plane.buffer
        val rowStride = plane.rowStride
        val pixelStride = plane.pixelStride

        val rowBuffer = ByteArray(rowStride)
        val outRow = ByteArray(width)

        dst.clear()

        for (row in 0 until height) {
            val rowStart = row * rowStride
            if (rowStart >= src.limit()) break

            val readable = minOf(rowStride, src.limit() - rowStart)
            src.position(rowStart)
            src.get(rowBuffer, 0, readable)

            val usable = if (pixelStride == 1) {
                minOf(width, readable)
            } else {
                var count = 0
                var index = 0
                while (count < width && index < readable) {
                    outRow[count] = rowBuffer[index]
                    count++
                    index += pixelStride
                }
                count
            }

            dst.position(row * dstStride)
            if (pixelStride == 1) {
                dst.put(rowBuffer, 0, usable)
            } else {
                dst.put(outRow, 0, usable)
            }
        }

        dst.rewind()
        src.rewind()
    }
}
