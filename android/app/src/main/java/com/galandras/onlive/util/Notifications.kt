package com.galandras.onlive.util

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import com.galandras.onlive.MainActivity
import com.galandras.onlive.R
import com.galandras.onlive.stream.ConnectionState
import com.galandras.onlive.stream.StreamService

/**
 * A Foreground Service kitartó értesítése.
 *
 * Nem csak formalitás: ez az egyetlen felület, amin a felhasználó akkor is
 * látja és vezérli az adást, amikor épp másik appot használ. Ezért mutatja az
 * aktuális állapotot, és tartalmaz gyors műveleteket (Szünet/Folytatás,
 * Befejezés) — így nem kell visszaváltani az OnLIVE-ra.
 */
object Notifications {

    const val CHANNEL_ID = "onlive_stream"
    const val NOTIFICATION_ID = 4201

    fun ensureChannel(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return

        val manager = context.getSystemService(NotificationManager::class.java)
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return

        val channel = NotificationChannel(
            CHANNEL_ID,
            context.getString(R.string.notification_channel_name),
            NotificationManager.IMPORTANCE_LOW, // csendes, de mindig látható
        ).apply {
            description = context.getString(R.string.notification_channel_desc)
            setShowBadge(false)
            enableVibration(false)
            lockscreenVisibility = Notification.VISIBILITY_PUBLIC
        }
        manager.createNotificationChannel(channel)
    }

    fun build(
        context: Context,
        state: ConnectionState,
        detail: String? = null,
        recording: Boolean = false,
    ): Notification {
        val title = when (state) {
            ConnectionState.IDLE -> context.getString(R.string.state_idle)
            ConnectionState.CONNECTING -> context.getString(R.string.state_connecting)
            ConnectionState.LIVE -> "● " + context.getString(R.string.state_live)
            ConnectionState.RECONNECTING -> context.getString(R.string.state_reconnecting)
            ConnectionState.PAUSED -> context.getString(R.string.state_paused)
            ConnectionState.ERROR -> context.getString(R.string.state_error)
        }

        val text = buildString {
            append(detail ?: "OnLIVE")
            if (recording) append(" · helyi felvétel")
        }

        val contentIntent = PendingIntent.getActivity(
            context,
            0,
            Intent(context, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

        val builder = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_onlive)
            .setContentTitle(title)
            .setContentText(text)
            .setContentIntent(contentIntent)
            .setOngoing(true)
            .setSilent(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setPriority(NotificationCompat.PRIORITY_LOW)

        when (state) {
            ConnectionState.PAUSED -> builder.addAction(
                0,
                context.getString(R.string.action_resume),
                serviceAction(context, StreamService.ACTION_RESUME, 1),
            )

            ConnectionState.LIVE, ConnectionState.CONNECTING, ConnectionState.RECONNECTING ->
                builder.addAction(
                    0,
                    context.getString(R.string.action_pause),
                    serviceAction(context, StreamService.ACTION_PAUSE, 2),
                )

            else -> Unit
        }

        if (state != ConnectionState.IDLE) {
            builder.addAction(
                0,
                context.getString(R.string.action_end),
                serviceAction(context, StreamService.ACTION_STOP, 3),
            )
        }

        return builder.build()
    }

    fun update(context: Context, notification: Notification) {
        context.getSystemService(NotificationManager::class.java)
            .notify(NOTIFICATION_ID, notification)
    }

    private fun serviceAction(context: Context, action: String, requestCode: Int): PendingIntent =
        PendingIntent.getService(
            context,
            requestCode,
            Intent(context, StreamService::class.java).setAction(action),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
}
