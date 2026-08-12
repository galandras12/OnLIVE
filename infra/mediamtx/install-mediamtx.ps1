<#
.SYNOPSIS
    OnLIVE — MediaMTX telepítése és rendszerindításkori futtatása (3. szegmens).

.DESCRIPTION
    1. Letölti a legfrissebb MediaMTX Windows kiadást a GitHub-ról.
    2. Kicsomagolja a célmappába.
    3. Ha még nincs `mediamtx.yml`, létrehozza a repóban lévő sablonból, és
       beleírja a megadott streamkulcsot.
    4. Regisztrál egy ütemezett feladatot, ami rendszerindításkor elindítja.

    Miért ütemezett feladat, és nem Windows service: a MediaMTX-nek nincs
    beépített service-telepítője. Ugyanazt a mintát követjük, mint a tunnel
    watchdognál (1. szegmens) — így egy helyen, egyformán kezelhető minden
    háttérfolyamat. Ha `nssm` elérhető, azzal igazi service is csinálható.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\install-mediamtx.ps1 -StreamKey "titkos-kulcs"

.PARAMETER Uninstall
    Az ütemezett feladat eltávolítása (a fájlokat nem törli).
#>

[CmdletBinding()]
param(
    [string] $InstallDir = 'C:\OnLIVE\mediamtx',
    [string] $StreamKey,
    [string] $TaskName = 'OnLIVE MediaMTX',
    [switch] $Uninstall
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
           ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { throw 'Ezt a szkriptet rendszergazdai PowerShellből kell futtatni.' }

if ($Uninstall) {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "Eltávolítva: '$TaskName'" -ForegroundColor Green
    } else {
        Write-Host "Nincs ilyen ütemezett feladat: '$TaskName'" -ForegroundColor Yellow
    }
    return
}

# ---------------------------------------------------------------------------
# 1) Letöltés
# ---------------------------------------------------------------------------

Write-Host 'A legfrissebb MediaMTX kiadás keresése…'
$release = Invoke-RestMethod -Uri 'https://api.github.com/repos/bluenviron/mediamtx/releases/latest' `
    -Headers @{ 'User-Agent' = 'OnLIVE-Installer' }

$asset = $release.assets | Where-Object { $_.name -like '*windows_amd64.zip' } | Select-Object -First 1
if (-not $asset) { throw 'Nem található windows_amd64 kiadási csomag.' }

Write-Host "Verzió: $($release.tag_name) — $($asset.name)"

$temp = Join-Path $env:TEMP $asset.name
Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $temp -UseBasicParsing

# ---------------------------------------------------------------------------
# 2) Kicsomagolás
# ---------------------------------------------------------------------------

if (-not (Test-Path $InstallDir)) { New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null }

# A meglévő konfigurációt nem írjuk felül: a zip mediamtx.yml-jét félretesszük.
$existingConfig = Join-Path $InstallDir 'mediamtx.yml'
$configBackup = $null
if (Test-Path $existingConfig) {
    $configBackup = Join-Path $env:TEMP "mediamtx.yml.onlive-backup"
    Copy-Item $existingConfig $configBackup -Force
}

Expand-Archive -Path $temp -DestinationPath $InstallDir -Force
Remove-Item $temp -Force

if ($configBackup) {
    Copy-Item $configBackup $existingConfig -Force
    Remove-Item $configBackup -Force
    Write-Host 'A meglévő mediamtx.yml megmaradt.' -ForegroundColor Yellow
}

# ---------------------------------------------------------------------------
# 3) Konfiguráció a repóbeli sablonból
# ---------------------------------------------------------------------------

if (-not (Test-Path $existingConfig)) {
    $template = Join-Path $PSScriptRoot 'mediamtx.example.yml'
    if (-not (Test-Path $template)) { throw "Nem található a sablon: $template" }

    $content = Get-Content $template -Raw
    if ($StreamKey) {
        $content = $content.Replace('<streamkulcs>', $StreamKey)
    } else {
        Write-Host 'FIGYELEM: nem adtál meg -StreamKey értéket, a <streamkulcs> helyőrző benne maradt!' -ForegroundColor Yellow
    }
    Set-Content -Path $existingConfig -Value $content -Encoding UTF8
    Write-Host "Konfiguráció létrehozva: $existingConfig" -ForegroundColor Green
}

$logDir = 'C:\OnLIVE\logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }

# ---------------------------------------------------------------------------
# 4) Ütemezett feladat rendszerindításra
# ---------------------------------------------------------------------------

$exe = Join-Path $InstallDir 'mediamtx.exe'
if (-not (Test-Path $exe)) { throw "Nem található: $exe" }

$action = New-ScheduledTaskAction -Execute $exe -Argument "`"$existingConfig`"" -WorkingDirectory $InstallDir
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero)

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

Register-ScheduledTask -TaskName $TaskName `
    -Description 'OnLIVE: MediaMTX media ingest (WHIP be, WebRTC/RTMP/HLS ki).' `
    -Action $action -Trigger $trigger -Principal $principal -Settings $settings | Out-Null

Start-ScheduledTask -TaskName $TaskName

Write-Host ''
Write-Host "MediaMTX telepítve és elindítva ($InstallDir)." -ForegroundColor Green
Write-Host 'Ellenőrzés:  powershell -File .\ingest-probe.ps1'
Write-Host 'Napló:       C:\OnLIVE\logs\mediamtx.log'
Write-Host ''
Write-Host 'Ne felejtsd el: hooks\hook-env.bat létrehozása a sablonból!' -ForegroundColor Yellow
