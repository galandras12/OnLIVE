<#
.SYNOPSIS
    OnLIVE — ingest health-check (3. szegmens).

.DESCRIPTION
    Ugyanazt kérdezi le a MediaMTX API-jától, amit a vezérlő szerver is
    pollozni fog, csak emberi olvasásra formázva. Két dolgot mutat meg:

      1. ready  — van-e éppen aktív bejövő stream (publisher csatlakozva).
      2. stall  — nő-e a bytesReceived. A publisher maradhat "ready" úgy is,
                  hogy közben már nem küld képkockát (befagyott telefon,
                  félig élő mobilhálózat) — ezt CSAK a bájtszámláló mozgásából
                  lehet észrevenni.

    Kimenet: emberi szöveg, `-Json` kapcsolóval gépi feldolgozásra alkalmas
    JSON. A kilépési kód 0, ha az útvonal él és mozog; 1, ha nem.

.EXAMPLE
    powershell -File .\ingest-probe.ps1
    powershell -File .\ingest-probe.ps1 -Json -Watch
#>

[CmdletBinding()]
param(
    [string] $ApiBase = 'http://127.0.0.1:9997',
    [string] $Path = 'onlive',
    [int]    $StallSeconds = 3,
    [switch] $Json,
    [switch] $Watch
)

$ErrorActionPreference = 'Stop'

function Get-PathState {
    param([long] $PreviousBytes = -1)

    $result = [ordered]@{
        timestamp     = (Get-Date).ToString('o')
        apiReachable  = $false
        ready         = $false
        stalled       = $false
        sourceType    = $null
        bytesReceived = 0
        tracks        = @()
        readers       = 0
        error         = $null
    }

    try {
        $path = Invoke-RestMethod -Uri "$ApiBase/v3/paths/get/$Path" -TimeoutSec 5
        $result.apiReachable = $true
        $result.ready = [bool]$path.ready
        $result.sourceType = $path.source.type
        $result.bytesReceived = [long]$path.bytesReceived
        $result.tracks = @($path.tracks)
        $result.readers = @($path.readers).Count
    } catch {
        if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 404) {
            # 404 = az útvonal létezik a konfigurációban, de még sosem volt aktív.
            $result.apiReachable = $true
            $result.error = "A(z) '$Path' útvonal még nem aktív."
        } else {
            $result.error = "A MediaMTX API nem elérhető: $($_.Exception.Message)"
        }
        return $result
    }

    if ($PreviousBytes -ge 0 -and $result.ready -and $result.bytesReceived -eq $PreviousBytes) {
        $result.stalled = $true
    }

    return $result
}

function Write-Human {
    param($State)

    if (-not $State.apiReachable) {
        Write-Host "✖ $($State.error)" -ForegroundColor Red
        return
    }
    if (-not $State.ready) {
        $reason = if ($State.error) { $State.error } else { 'nincs csatlakozott publisher' }
        Write-Host "○ NINCS ADÁS — $reason" -ForegroundColor Yellow
        return
    }
    if ($State.stalled) {
        Write-Host "▲ MEGÁLLT — a publisher csatlakozva van, de $StallSeconds mp-e nem érkezik adat" -ForegroundColor Yellow
        return
    }

    $tracks = ($State.tracks -join ', ')
    Write-Host ("● ÉLŐ — forrás: {0} · sávok: {1} · {2:N1} MB érkezett · {3} olvasó" -f `
            $State.sourceType, $tracks, ($State.bytesReceived / 1MB), $State.readers) -ForegroundColor Green
}

if ($Watch) {
    $previous = -1
    while ($true) {
        $state = Get-PathState -PreviousBytes $previous
        $previous = if ($state.apiReachable) { $state.bytesReceived } else { -1 }
        if ($Json) { $state | ConvertTo-Json -Compress } else { Write-Human $state }
        Start-Sleep -Seconds $StallSeconds
    }
}

# Egyszeri futás: két mintavétel kell a "megállt" állapot eldöntéséhez.
$first = Get-PathState
if ($first.apiReachable -and $first.ready) {
    Start-Sleep -Seconds $StallSeconds
    $state = Get-PathState -PreviousBytes $first.bytesReceived
} else {
    $state = $first
}

if ($Json) { $state | ConvertTo-Json -Depth 4 } else { Write-Human $state }
exit $(if ($state.ready -and -not $state.stalled) { 0 } else { 1 })
