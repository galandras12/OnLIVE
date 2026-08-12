package com.galandras.onlive.util

import android.content.Context
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.util.Log

/**
 * Zseblámpa a kamera-session-től függetlenül.
 *
 * Ha épp fut a CameraX kamera, a torch-ot a `CameraControl.enableTorch()`-csal
 * kapcsoljuk (a [com.galandras.onlive.stream.CameraSource] intézi). Ha viszont
 * képernyő-megosztás megy — vagy nincs is adás —, nincs bekötött kamera, ekkor
 * jön ez a közvetlen Camera2 út.
 */
class TorchController(private val context: Context) {

    private val manager: CameraManager? =
        runCatching { context.getSystemService(Context.CAMERA_SERVICE) as CameraManager }.getOrNull()

    private val torchCameraId: String? by lazy {
        runCatching {
            manager?.cameraIdList?.firstOrNull { id ->
                val characteristics = manager.getCameraCharacteristics(id)
                val hasFlash = characteristics.get(CameraCharacteristics.FLASH_INFO_AVAILABLE) ?: false
                val isBack = characteristics.get(CameraCharacteristics.LENS_FACING) ==
                    CameraCharacteristics.LENS_FACING_BACK
                hasFlash && isBack
            }
        }.getOrNull()
    }

    fun isAvailable(): Boolean = torchCameraId != null

    fun setTorch(on: Boolean): Boolean {
        val id = torchCameraId ?: return false
        return runCatching {
            manager?.setTorchMode(id, on)
            true
        }.onFailure {
            // CAMERA_IN_USE: a kamerát épp más session tartja — ilyenkor a
            // CameraSource.setTorch() a helyes út.
            Log.w(TAG, "setTorchMode sikertelen: ${it.message}")
        }.getOrDefault(false)
    }

    companion object {
        private const val TAG = "OnLIVE/Torch"
    }
}
