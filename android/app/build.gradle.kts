plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
}

android {
    namespace = "com.galandras.onlive"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.galandras.onlive"
        minSdk = 26
        // A 2. szegmens explicit elvárása: Android 14 (API 34) target.
        // A 34-es szint hozza a kötelező foregroundServiceType deklarációkat,
        // és azt a szabályt, hogy a mediaProjection típusú FGS-t a
        // MediaProjection megszerzése ELŐTT kell elindítani.
        // API 35-re lépés előtt lásd docs/ANDROID.md → "TargetSdk 35".
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
        debug {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    // A kotlinOptions blokk elavult a Kotlin 2.x-ben; a fordító beállításai a
    // lenti `kotlin { compilerOptions { … } }` blokkban vannak.

    buildFeatures {
        compose = true
        buildConfig = true
    }

    packaging {
        resources.excludes += "/META-INF/{AL2.0,LGPL2.1}"

        /*
          16 KB-os lapméret (Android 15+, pl. Galaxy S26).

          A natív .so fájloknak tömörítetlenül, laphatárra igazítva kell az
          APK-ba kerülniük. Az AGP ezt minSdk 23 felett alapból így csinálja —
          itt csak kimondjuk, hogy egy későbbi módosítás se kapcsolja vissza a
          régi, tömörített csomagolást.

          Maga az ELF-igazítás a KÖNYVTÁRAK dolga: azt a függőségek verziója
          adja (lásd gradle/libs.versions.toml).
        */
        jniLibs {
            useLegacyPackaging = false
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.service)
    implementation(libs.androidx.lifecycle.process)
    implementation(libs.androidx.activity.compose)

    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.graphics)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.material.icons)

    implementation(libs.androidx.camera.core)
    implementation(libs.androidx.camera.camera2)
    implementation(libs.androidx.camera.lifecycle)
    implementation(libs.androidx.camera.view)
    implementation(libs.androidx.camera.video)

    implementation(libs.androidx.datastore.preferences)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.okhttp)
    implementation(libs.webrtc.android)
}
