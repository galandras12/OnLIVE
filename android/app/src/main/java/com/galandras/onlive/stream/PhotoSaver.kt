package com.galandras.onlive.stream

import android.content.ContentValues
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageFormat
import android.graphics.Matrix
import android.graphics.Rect
import android.graphics.YuvImage
import android.os.Build
import android.provider.MediaStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.webrtc.VideoFrame
import java.io.ByteArrayOutputStream
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * „Fényképezőgép" gomb: az ÉPPEN futó adás aktuális képkockáját menti JPEG-ként
 * a telefon galériájába.
 *
 * Szándékosan nem külön `ImageCapture` use case-t használunk: az egy második
 * capture-kérést jelentene a kamerának (kép-kiesés, esetleg vaku-villanás),
 * és képernyő módban egyáltalán nem működne. Így viszont a mentés a
 * [FrameFanout]-ban tárolt utolsó képkockából történik — nulla hatással a
 * stream folytonosságára, és kamera/képernyő módban egyaránt működik.
 */
object PhotoSaver {

    private val TIMESTAMP = SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US)

    suspend fun save(context: Context, frame: VideoFrame, quality: Int = 92): Result<String> =
        withContext(Dispatchers.IO) {
            runCatching {
                val i420 = frame.buffer.toI420() ?: error("Nem sikerült I420-ra alakítani a képkockát.")
                try {
                    val width = i420.width
                    val height = i420.height
                    val nv21 = toNv21(i420)

                    val jpegStream = ByteArrayOutputStream()
                    YuvImage(nv21, ImageFormat.NV21, width, height, null)
                        .compressToJpeg(Rect(0, 0, width, height), quality, jpegStream)

                    val bytes = rotateIfNeeded(jpegStream.toByteArray(), frame.rotation, quality)
                    writeToGallery(context, bytes)
                } finally {
                    i420.release()
                }
            }
        }

    private fun toNv21(buffer: org.webrtc.VideoFrame.I420Buffer): ByteArray {
        val width = buffer.width
        val height = buffer.height
        val chromaWidth = (width + 1) / 2
        val chromaHeight = (height + 1) / 2
        val out = ByteArray(width * height + chromaWidth * chromaHeight * 2)

        val y = buffer.dataY
        var index = 0
        for (row in 0 until height) {
            y.position(row * buffer.strideY)
            y.get(out, index, width)
            index += width
        }

        val u = buffer.dataU
        val v = buffer.dataV
        val uRow = ByteArray(chromaWidth)
        val vRow = ByteArray(chromaWidth)
        for (row in 0 until chromaHeight) {
            u.position(row * buffer.strideU)
            u.get(uRow, 0, chromaWidth)
            v.position(row * buffer.strideV)
            v.get(vRow, 0, chromaWidth)
            for (col in 0 until chromaWidth) {
                out[index++] = vRow[col] // NV21: V és U felváltva, V-vel kezdve
                out[index++] = uRow[col]
            }
        }
        return out
    }

    private fun rotateIfNeeded(jpeg: ByteArray, rotation: Int, quality: Int): ByteArray {
        if (rotation % 360 == 0) return jpeg

        val bitmap = BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size) ?: return jpeg
        val matrix = Matrix().apply { postRotate(rotation.toFloat()) }
        val rotated = Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true)
        val out = ByteArrayOutputStream()
        rotated.compress(Bitmap.CompressFormat.JPEG, quality, out)
        bitmap.recycle()
        rotated.recycle()
        return out.toByteArray()
    }

    private fun writeToGallery(context: Context, jpeg: ByteArray): String {
        val name = "OnLIVE_${TIMESTAMP.format(Date())}.jpg"
        val values = ContentValues().apply {
            put(MediaStore.Images.Media.DISPLAY_NAME, name)
            put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg")
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                put(MediaStore.Images.Media.RELATIVE_PATH, "Pictures/OnLIVE")
            }
        }

        val uri = context.contentResolver
            .insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values)
            ?: error("Nem sikerült létrehozni a képfájlt a galériában.")

        context.contentResolver.openOutputStream(uri)?.use { it.write(jpeg) }
            ?: error("Nem sikerült megnyitni a képfájlt írásra.")

        return name
    }
}
