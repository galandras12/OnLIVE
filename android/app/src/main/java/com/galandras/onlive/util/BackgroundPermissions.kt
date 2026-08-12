package com.galandras.onlive.util

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import android.util.Log

/**
 * Háttérfutás-engedélyek.
 *
 * A helyes Foreground Service implementáció ÖNMAGÁBAN NEM ELÉG ahhoz, hogy
 * egy adás órákig fusson háttérben. Két további réteget kell kezelni:
 *
 *  1. **Rendszerszintű Doze / akkumulátor-optimalizálás** — ez korlátozhatja a
 *     hálózati kapcsolatot, ha az app háttérben van és a képernyő kikapcsol.
 *     Megoldás: `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` kérése.
 *
 *  2. **Gyártói (Samsung One UI) agresszív háttér-kezelés** — a One UI a
 *     rendszerszintű beállítás FELETT saját „Alvó alkalmazások" / „Mélyalvó
 *     alkalmazások" listát is vezet. Erre nincs API: a felhasználót kell
 *     elvinni a megfelelő beállítási képernyőre.
 */
object BackgroundPermissions {

    private const val TAG = "OnLIVE/Background"

    // -----------------------------------------------------------------------
    // 1) Akkumulátor-optimalizálás
    // -----------------------------------------------------------------------

    fun isIgnoringBatteryOptimizations(context: Context): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true
        val manager = context.getSystemService(Context.POWER_SERVICE) as PowerManager
        return manager.isIgnoringBatteryOptimizations(context.packageName)
    }

    /**
     * A rendszer párbeszédpanele, ami egy kattintással kiveszi az appot az
     * akkumulátor-optimalizálás alól.
     *
     * A `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` intentet a Play Store szigorúan
     * bírálja el, de az OnLIVE nem a Play Store-ból települ, és az élő
     * közvetítés pontosan az a felhasználási eset, amire ez az engedély való.
     */
    fun requestIgnoreBatteryOptimizations(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return
        if (isIgnoringBatteryOptimizations(context)) return

        val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
            .setData(Uri.parse("package:${context.packageName}"))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

        try {
            context.startActivity(intent)
        } catch (e: ActivityNotFoundException) {
            Log.w(TAG, "Nincs kezelő az akkumulátor-optimalizálás kéréshez, listát nyitunk.")
            openBatteryOptimizationList(context)
        }
    }

    private fun openBatteryOptimizationList(context: Context) {
        runCatching {
            context.startActivity(
                Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            )
        }
    }

    // -----------------------------------------------------------------------
    // 2) Gyártói háttérkorlátozás (Samsung és társai)
    // -----------------------------------------------------------------------

    /** Samsung eszközön külön, egyszeri instrukciót mutatunk a „Sosem alszik" listáról. */
    fun isSamsung(): Boolean = Build.MANUFACTURER.equals("samsung", ignoreCase = true)

    /**
     * Megnyitja a gyártói akkumulátor-beállításokat. Ha a konkrét képernyő nem
     * érhető el (gyártótól és One UI verziótól függ), az app rendszerbeállítási
     * oldalára esünk vissza — onnan a felhasználó két kattintással odaér.
     */
    fun openOemBatterySettings(context: Context) {
        val candidates = listOf(
            // Samsung One UI — akkumulátor-beállítások (eszközkarbantartó)
            Intent().setClassName(
                "com.samsung.android.lool",
                "com.samsung.android.sm.battery.ui.BatteryActivity",
            ),
            Intent().setClassName(
                "com.samsung.android.lool",
                "com.samsung.android.sm.ui.battery.BatteryActivity",
            ),
            // Általános: az app rendszerbeállítási oldala
            Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
                .setData(Uri.parse("package:${context.packageName}")),
        )

        for (intent in candidates) {
            try {
                context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                return
            } catch (e: Exception) {
                Log.d(TAG, "Beállítási képernyő nem elérhető: ${intent.component ?: intent.action}")
            }
        }
    }
}
