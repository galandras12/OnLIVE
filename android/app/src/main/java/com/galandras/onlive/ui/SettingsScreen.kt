package com.galandras.onlive.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material.icons.filled.VisibilityOff
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Slider
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.foundation.text.KeyboardOptions
import com.galandras.onlive.BuildConfig
import com.galandras.onlive.net.ControlApi
import com.galandras.onlive.settings.AppSettings
import com.galandras.onlive.settings.AudioBitrate
import com.galandras.onlive.settings.AudioSampleRate
import com.galandras.onlive.settings.ConnectionMode
import com.galandras.onlive.settings.FrameRate
import com.galandras.onlive.settings.Settings
import com.galandras.onlive.settings.StreamOrientation
import com.galandras.onlive.settings.VideoBitrate
import com.galandras.onlive.settings.VideoResolution
import kotlinx.coroutines.launch

/**
 * Beállítás-képernyő — a fogaskerék ide vezet (1.0.010).
 *
 * Két szekció:
 *
 *  1. **Kapcsolat** — a streamkulcs és a Cloudflare Tunnel címei. Enélkül az
 *     app semmit nem tud csinálni: a kulcsot a WEBES FELÜLETEN kell létrehozni
 *     (/admin → Streamkulcs), és ide átmásolni. A szerver csak a kulcs hash-ét
 *     tárolja, ezért onnan visszaolvasni nem lehet — ha elveszett, újat kell
 *     generálni.
 *  2. **Minőség** — felbontás, képfrissítés, bitráta, hang. Ez korábban egy
 *     szűk párbeszédablakban volt; itt már fér is.
 *
 * A „Kapcsolat tesztelése" gomb megmondja, jó-e a cím és a kulcs, anélkül hogy
 * adást kellene indítani hozzá.
 */
@Composable
fun SettingsScreen(
    settings: Settings,
    appSettings: AppSettings,
    onApply: () -> Unit,
    onClose: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    val controlApi = remember { ControlApi() }

    // A rendszer vissza-gombja a beállításokat zárja, nem az appot — adás közben
    // egy véletlen kilépés a közvetítést szakítaná meg.
    BackHandler { onClose() }

    // A szövegmezők külön állapotban élnek, hogy gépelés közben ne mentsünk
    // minden karakternél — a mentés a „Mentés" gombra történik.
    var streamKey by remember(settings.streamKey) { mutableStateOf(settings.streamKey) }
    var controlUrl by remember(settings.controlBaseUrl) { mutableStateOf(settings.controlBaseUrl) }
    var ingestUrl by remember(settings.ingestBaseUrl) { mutableStateOf(settings.ingestBaseUrl) }
    var streamPath by remember(settings.streamPath) { mutableStateOf(settings.streamPath) }
    var ingestUser by remember(settings.ingestUser) { mutableStateOf(settings.ingestUser) }
    var turnUrl by remember(settings.turnUrl) { mutableStateOf(settings.turnUrl) }
    var turnUser by remember(settings.turnUsername) { mutableStateOf(settings.turnUsername) }
    var turnSecret by remember(settings.turnCredential) { mutableStateOf(settings.turnCredential) }
    var localControl by remember(settings.localControlBaseUrl) { mutableStateOf(settings.localControlBaseUrl) }
    var localIngest by remember(settings.localIngestBaseUrl) { mutableStateOf(settings.localIngestBaseUrl) }
    var mode by remember(settings.connectionMode) { mutableStateOf(settings.connectionMode) }

    var keyVisible by remember { mutableStateOf(false) }
    var bitrate by remember(settings.videoBitrateKbps) { mutableStateOf(settings.videoBitrateKbps.toFloat()) }

    var testing by remember { mutableStateOf(false) }
    var testResult by remember { mutableStateOf<String?>(null) }
    var testOk by remember { mutableStateOf(false) }

    /**
     * A kapcsolati mezők mentése — ezt a teszt is használja.
     *
     * A két címet mentés előtt alap-címmé alakítjuk (1.0.019): a bemásolt
     * `.../admin` vagy `.../onlive/whip` végződés levágásra kerül, és a mezőben
     * is a javított érték marad — hogy látszódjon, mi lett elmentve.
     */
    suspend fun persistConnection(): Settings {
        val path = streamPath.trim().trim('/')
        controlUrl = Settings.normalizeControlBase(controlUrl)
        ingestUrl = Settings.normalizeIngestBase(ingestUrl, path.ifBlank { Settings.DEFAULT_STREAM_PATH })

        appSettings.setEndpoints(
            ingest = ingestUrl,
            control = controlUrl,
            path = path,
            key = streamKey.trim(),
            ingestUser = ingestUser.trim().ifBlank { Settings.DEFAULT_INGEST_USER },
        )
        appSettings.setTurn(turnUrl.trim(), turnUser.trim(), turnSecret.trim())
        appSettings.setLocalEndpoints(
            control = Settings.normalizeControlBase(localControl),
            ingest = Settings.normalizeIngestBase(localIngest, path.ifBlank { Settings.DEFAULT_STREAM_PATH }),
            mode = mode,
        )
        localControl = Settings.normalizeControlBase(localControl)
        localIngest = Settings.normalizeIngestBase(localIngest, path.ifBlank { Settings.DEFAULT_STREAM_PATH })
        return appSettings.current()
    }

    Surface(color = Bg, modifier = Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize()) {

            // ---------------------------------------------------------------
            //  Fejléc
            // ---------------------------------------------------------------
            Row(
                Modifier
                    .fillMaxWidth()
                    .background(Color(0xFF12161C))
                    .padding(horizontal = 8.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                IconButton(onClick = onClose) {
                    Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Vissza", tint = Color.White)
                }
                Text(
                    "Beállítások",
                    color = Color.White,
                    fontWeight = FontWeight.Bold,
                    fontSize = 18.sp,
                )
            }

            Column(
                Modifier
                    .fillMaxSize()
                    .verticalScroll(rememberScrollState())
                    .padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp),
            ) {

                // -----------------------------------------------------------
                //  KAPCSOLAT
                // -----------------------------------------------------------
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {

                        SectionTitle("Kapcsolat")
                        Hint(
                            "A streamkulcsot a webes felületen hozd létre: " +
                                "Admin → Streamkulcs fül. Ott generálhatsz egyet, vagy megadhatsz " +
                                "sajátot (legalább 16 karakter, kis- és nagybetűvel, számmal és " +
                                "speciális karakterrel). A kulcs a szerveren titkosítva tárolódik, " +
                                "ezért csak a létrehozáskor látszik — ide kézzel másold át.",
                        )

                        OutlinedTextField(
                            value = streamKey,
                            onValueChange = { streamKey = it; testResult = null },
                            label = { Text("Streamkulcs") },
                            singleLine = true,
                            visualTransformation =
                                if (keyVisible) VisualTransformation.None else PasswordVisualTransformation(),
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                            trailingIcon = {
                                IconButton(onClick = { keyVisible = !keyVisible }) {
                                    Icon(
                                        if (keyVisible) Icons.Default.VisibilityOff else Icons.Default.Visibility,
                                        contentDescription = if (keyVisible) "Elrejt" else "Megmutat",
                                    )
                                }
                            },
                            modifier = Modifier.fillMaxWidth(),
                        )

                        SubTitle("Cloudflare Tunnel címek")
                        Hint(
                            "Ezek a fix, publikus címek — nem változnak IP-váltáskor vagy " +
                                "újraindításkor. A vezérlő szerver kapja a gombnyomásokat, az " +
                                "ingest pedig a képet.\n\n" +
                                "Mindkettő ALAP-cím: az /admin és a /<stream>/whip részt az app " +
                                "teszi hozzá. Ha mégis bemásolod, mentéskor levágom.",
                        )

                        OutlinedTextField(
                            value = controlUrl,
                            onValueChange = { controlUrl = it; testResult = null },
                            label = { Text("Vezérlő szerver (alap-cím)") },
                            placeholder = { Text(Settings.DEFAULT_CONTROL_URL) },
                            singleLine = true,
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                            modifier = Modifier.fillMaxWidth(),
                        )

                        OutlinedTextField(
                            value = ingestUrl,
                            onValueChange = { ingestUrl = it; testResult = null },
                            label = { Text("Ingest (WHIP)") },
                            placeholder = { Text(Settings.DEFAULT_INGEST_URL) },
                            singleLine = true,
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                            modifier = Modifier.fillMaxWidth(),
                        )

                        // Az ingest alap-cím hibái MENTÉS ELŐTT látszanak (1.0.103):
                        // egy bennfelejtett `/ingest` útvonalból végtelen
                        // újracsatlakozás lesz, és semmi nem mondja meg, miért.
                        Settings.ingestBaseIssue(ingestUrl, streamPath)?.let { issue ->
                            Text(issue, color = Live, fontSize = 12.sp)
                        }

                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            OutlinedTextField(
                                value = streamPath,
                                onValueChange = { streamPath = it; testResult = null },
                                label = { Text("Stream útvonal") },
                                singleLine = true,
                                modifier = Modifier.weight(1f),
                            )
                            OutlinedTextField(
                                value = ingestUser,
                                onValueChange = { ingestUser = it },
                                label = { Text("Ingest felhasználó") },
                                singleLine = true,
                                modifier = Modifier.weight(1f),
                            )
                        }

                        Text(
                            "Publish cím: ${buildWhipUrl(ingestUrl, streamPath)}",
                            fontSize = 11.sp,
                            color = Color.Gray,
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis,
                        )

                        // -------------------------------------------------------
                        //  Kapcsolat tesztelése
                        // -------------------------------------------------------
                        Row(
                            horizontalArrangement = Arrangement.spacedBy(10.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            OutlinedButton(
                                onClick = {
                                    scope.launch {
                                        testing = true
                                        testResult = null
                                        // A teszt a MENTETT értékekkel fut, hogy pontosan azt
                                        // mérje, amivel az adás is menne.
                                        val current = persistConnection()
                                        controlApi.ping(current)
                                            .onSuccess { ping ->
                                                // A vezérlő út rendben — de ez ÖNMAGÁBAN nem
                                                // jelenti, hogy a kép is fel tud menni (1.0.103).
                                                val mismatch = ping.streamPath.isNotBlank() &&
                                                    ping.streamPath.trim('/') != current.streamPath.trim('/')

                                                testOk = !mismatch
                                                testResult = buildString {
                                                    append("A vezérlő szerver válaszol, a kulcs jó. ")
                                                    append("Állapot: ${ping.state}")
                                                    if (ping.route.isNotBlank()) append("\n${ping.route}")
                                                    append("\nPublish cím: ${current.whipUrl}")
                                                    if (mismatch) {
                                                        append(
                                                            "\nHIBA: a stream útvonal nem egyezik a szerverével " +
                                                                "(telefon: ${current.streamPath}, szerver: ${ping.streamPath}). " +
                                                                "Emiatt a WHIP publish 404-et kapna.",
                                                        )
                                                    }
                                                    ping.ack?.let { ack ->
                                                        append(
                                                            "\nA szerver most " +
                                                                if (ack.ingestFlowing) "LÁTJA a bejövő képet." else "nem lát bejövő képet.",
                                                        )
                                                    }
                                                    append("\nEz a teszt a vezérlő utat méri; a WHIP publish külön út.")
                                                }
                                            }
                                            .onFailure {
                                                testOk = false
                                                testResult = it.message ?: "A kapcsolat nem jött létre."
                                            }
                                        testing = false
                                    }
                                },
                                enabled = !testing,
                            ) { Text("Kapcsolat tesztelése") }

                            if (testing) {
                                CircularProgressIndicator(Modifier.height(20.dp), strokeWidth = 2.dp)
                            }
                        }

                        testResult?.let { message ->
                            Text(
                                message,
                                color = if (testOk) Ok else Live,
                                fontSize = 13.sp,
                            )
                        }
                    }
                }

                // -----------------------------------------------------------
                //  HELYI ELÉRÉS — LAN / Tailscale (1.0.101)
                // -----------------------------------------------------------
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        SectionTitle("Helyi elérés — LAN / Tailscale")
                        Hint(
                            "A Cloudflare Tunnelen a WHIP jelzés átmegy, a videó viszont NEM. " +
                                "Ha a telefon ugyanazon a hálózaton (vagy ugyanabban a Tailscale " +
                                "hálózatban) van, mint a szerver, itt megadhatod a helyi címét: " +
                                "akkor a kép a hálózaton belül marad, TURN nélkül is van adás, és " +
                                "a késleltetés is kisebb. A címeket az admin felület Streamkulcs " +
                                "fülén írja ki a szerver.",
                        )

                        OutlinedTextField(
                            value = localControl,
                            onValueChange = { localControl = it; testResult = null },
                            label = { Text("Helyi vezérlő szerver") },
                            placeholder = { Text("http://100.x.y.z:8080") },
                            singleLine = true,
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                            modifier = Modifier.fillMaxWidth(),
                        )

                        OutlinedTextField(
                            value = localIngest,
                            onValueChange = { localIngest = it; testResult = null },
                            label = { Text("Helyi ingest (WHIP)") },
                            placeholder = { Text("http://100.x.y.z:8889") },
                            singleLine = true,
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                            modifier = Modifier.fillMaxWidth(),
                        )

                        Settings.ingestBaseIssue(localIngest, streamPath)?.let { issue ->
                            Text(issue, color = Live, fontSize = 12.sp)
                        }

                        SubTitle("Kapcsolat mód")
                        ChipRow {
                            ConnectionMode.entries.forEach { option ->
                                FilterChip(
                                    selected = option == mode,
                                    onClick = { mode = option; testResult = null },
                                    label = { Text(option.label) },
                                )
                            }
                        }
                        Hint(mode.hint)
                    }
                }

                // -----------------------------------------------------------
                //  TURN
                // -----------------------------------------------------------
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        SectionTitle("TURN relay")
                        Hint(
                            "A WHIP jelzés átmegy a Cloudflare Tunnelen, a videó viszont NEM: " +
                                "a WebRTC média közvetlen útvonalat keres. Mobilhálózatról ehhez " +
                                "jellemzően TURN szerver kell, különben a kapcsolat felépül, de kép " +
                                "nem érkezik.",
                        )

                        OutlinedTextField(
                            value = turnUrl,
                            onValueChange = { turnUrl = it },
                            label = { Text("TURN URL (turn:… vagy turns:…)") },
                            singleLine = true,
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                            modifier = Modifier.fillMaxWidth(),
                        )
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            OutlinedTextField(
                                value = turnUser,
                                onValueChange = { turnUser = it },
                                label = { Text("Felhasználó") },
                                singleLine = true,
                                modifier = Modifier.weight(1f),
                            )
                            OutlinedTextField(
                                value = turnSecret,
                                onValueChange = { turnSecret = it },
                                label = { Text("Jelszó") },
                                singleLine = true,
                                visualTransformation = PasswordVisualTransformation(),
                                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                                modifier = Modifier.weight(1f),
                            )
                        }
                    }
                }

                // -----------------------------------------------------------
                //  MINŐSÉG
                // -----------------------------------------------------------
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        SectionTitle("Minőség")
                        Hint("Adás közben is állítható; a szerver a web felületről is átállíthatja.")

                        SubTitle("Kép-irány")
                        ChipRow {
                            StreamOrientation.entries.forEach { option ->
                                FilterChip(
                                    selected = option == settings.orientation,
                                    onClick = { scope.launch { appSettings.setOrientation(option) } },
                                    label = { Text(option.label) },
                                )
                            }
                        }
                        Hint(
                            "Az adás INDÍTÁSAKOR rögzül: élő közvetítés közben nem vált, mert a " +
                                "nézőnél átugrana a kompozíció. A főképernyőn is ott a gomb.",
                        )

                        SubTitle("Felbontás")
                        ChipRow {
                            VideoResolution.entries.forEach { option ->
                                FilterChip(
                                    selected = option == settings.resolution,
                                    onClick = { scope.launch { appSettings.setResolution(option) } },
                                    label = { Text(option.label) },
                                )
                            }
                        }

                        SubTitle("Képfrissítés")
                        ChipRow {
                            FrameRate.entries.forEach { option ->
                                FilterChip(
                                    selected = option == settings.frameRate,
                                    onClick = { scope.launch { appSettings.setFrameRate(option) } },
                                    label = { Text(option.label) },
                                )
                            }
                        }

                        SubTitle("Videó bitráta: ${bitrate.toInt()} kbps")
                        Slider(
                            value = bitrate,
                            onValueChange = { bitrate = it },
                            onValueChangeFinished = { scope.launch { appSettings.setVideoBitrate(bitrate.toInt()) } },
                            valueRange = VideoBitrate.MIN_KBPS.toFloat()..VideoBitrate.MAX_KBPS.toFloat(),
                            steps = 22,
                        )
                        Text(
                            "Ajánlott: ${VideoBitrate.recommendedKbps(settings.resolution, settings.frameRate)} kbps",
                            fontSize = 12.sp,
                            color = Color.Gray,
                        )

                        SubTitle("Hang mintavétel")
                        ChipRow {
                            AudioSampleRate.entries.forEach { option ->
                                FilterChip(
                                    selected = option == settings.audioSampleRate,
                                    onClick = { scope.launch { appSettings.setAudioSampleRate(option) } },
                                    label = { Text(option.label) },
                                )
                            }
                        }

                        SubTitle("Hang bitráta")
                        ChipRow {
                            AudioBitrate.entries.forEach { option ->
                                FilterChip(
                                    selected = option == settings.audioBitrate,
                                    onClick = { scope.launch { appSettings.setAudioBitrate(option) } },
                                    label = { Text(option.label) },
                                )
                            }
                        }
                    }
                }

                // -----------------------------------------------------------
                //  Mentés
                // -----------------------------------------------------------
                Button(
                    onClick = {
                        scope.launch {
                            persistConnection()
                            appSettings.setVideoBitrate(bitrate.toInt())
                            onApply()
                            onClose()
                        }
                    },
                    modifier = Modifier.fillMaxWidth(),
                ) { Text("Mentés") }

                Text(
                    "A kapcsolati beállítások a következő adásindításkor lépnek életbe. " +
                        "A minőségi beállítások menet közben is érvényesülnek.",
                    fontSize = 11.sp,
                    color = Color.Gray,
                )

                // -----------------------------------------------------------
                //  Névjegy (1.0.101)
                // -----------------------------------------------------------
                About()

                Spacer(Modifier.height(24.dp))
            }
        }
    }
}

// ---------------------------------------------------------------------------
//  Apró építőelemek
// ---------------------------------------------------------------------------

/**
 * Névjegy — alkalmazás neve és verziója (1.0.101).
 *
 * A verzió a `BuildConfig`-ból jön, tehát nem lehet elfelejteni frissíteni:
 * az érték a `build.gradle.kts` `versionName`-jével egyezik, azt pedig a
 * kiadás állítja.
 */
@Composable
private fun About() {
    Card(Modifier.fillMaxWidth()) {
        Row(
            Modifier.padding(16.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(Icons.Default.Info, contentDescription = null, tint = Color(0xFF9CA3AF))
            Column {
                Text("OnLIVE", color = Color.White, fontWeight = FontWeight.Bold, fontSize = 15.sp)
                Text(
                    "Verzió ${BuildConfig.VERSION_NAME} (build ${BuildConfig.VERSION_CODE})",
                    color = Color.Gray,
                    fontSize = 12.sp,
                )
                Text("Élő közvetítés — telefon, szerver, OBS", color = Color.Gray, fontSize = 11.sp)
            }
        }
    }
}

@Composable
private fun SectionTitle(text: String) {
    Text(text, color = Color.White, fontWeight = FontWeight.Bold, fontSize = 16.sp)
}

@Composable
private fun SubTitle(text: String) {
    Text(text, color = Color.White, fontWeight = FontWeight.SemiBold, fontSize = 13.sp)
}

@Composable
private fun Hint(text: String) {
    Text(text, color = Color.Gray, fontSize = 12.sp)
}

@Composable
private fun ChipRow(content: @Composable () -> Unit) {
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) { content() }
}

/** Ugyanaz a szabály, mint a Settings.whipUrl — de a még nem mentett mezőkből. */
private fun buildWhipUrl(ingest: String, path: String): String =
    "${ingest.trim().trimEnd('/')}/${path.trim().trim('/')}/whip"
