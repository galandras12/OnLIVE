package com.galandras.onlive

import android.app.Application
import com.galandras.onlive.util.Notifications

class OnLiveApp : Application() {
    override fun onCreate() {
        super.onCreate()
        // A csatornát már indulásnál létrehozzuk, hogy a Service
        // startForeground() hívása sose fusson hiányzó csatornába.
        Notifications.ensureChannel(this)
    }
}
