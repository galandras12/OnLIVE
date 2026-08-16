package com.galandras.onlive.ui

import androidx.compose.ui.graphics.Color

/**
 * Az app színei — ugyanazok a jelentés-színek, mint a webes felületen
 * (`server/src/web/admin.css`), hogy a két felület egy rendszernek látsszon.
 *
 * Azért külön fájlban, mert a Kotlinban a fájl tetején álló `private val` csak
 * az adott fájlból látszik: a beállítás-képernyő így nem érné el őket.
 */
internal val Live = Color(0xFFE11D48)   // élő adás, hiba
internal val Warn = Color(0xFFF59E0B)   // átmeneti állapot
internal val Ok = Color(0xFF10B981)     // rendben, sikeres teszt
internal val Bg = Color(0xFF0B0D10)     // háttér
