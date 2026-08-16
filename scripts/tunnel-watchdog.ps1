<#
.SYNOPSIS
    OnLIVE — Cloudflare Tunnel watchdog (1. szegmens).

.DESCRIPTION
    Folyamatosan figyeli, hogy az alagút él-e, és megszakadás esetén
    automatikusan újraindítja a `cloudflared` Windows service-t.

    Három szinten ellenőriz:
      1) Folyamat-szint  — fut-e a cloudflared service.
      2) Konnektor-szint — a cloudflared metrics /ready végpontja 200-at ad-e,
                           és van-e legalább egy élő kapcsolat a Cloudflare felé.
      3) Végpont-szint   — a publikus URL kívülről válaszol-e.

    A 3) ellenőrzés csak akkor számít hibának, ha a helyi origin (a vezérlő
    szerver) egyébként fut. Ha maga a Node szerver áll, az NEM az alagút hibája,
    ezért a watchdog ilyenkor nem indítja újra a tunnelt.

    Amit a watchdog KIFEJEZETTEN nem kezel: a telefon hálózatvesztését.
    Azt az Android app reconnect-logikája (2. szegmens) és a vezérlő szerver
    INTERRUPTED állapota kezeli.

.PARAMETER ServiceName
    A cloudflared Windows service neve. Alapértelmezés: cloudflared

.PARAMETER ReadyUrl
    A cloudflared metrics /ready végpontja (config.yml → metrics:).

.PARAMETER PublicUrl
    Kívülről ellenőrzött publikus URL.

.PARAMETER OriginPort
    A helyi vezérlő szerver portja (ennek állása nem tunnel-hiba).

.PARAMETER IntervalSeconds
    Két ellenőrzés között eltelt idő.

.PARAMETER FailureThreshold
    Ennyi egymást követő sikertelen ellenőrzés után indul újra a service.

.PARAMETER RunOnce
    Csak egyetlen ellenőrzési kört futtat, majd kilép (teszthez).

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\scripts\tunnel-watchdog.ps1 -Verbose

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\scripts\tunnel-watchdog.ps1 -RunOnce
#>

[CmdletBinding()]
param(
    [string] $ServiceName      = 'cloudflared',
    [string] $ReadyUrl         = 'http://127.0.0.1:20241/ready',
    [string] $PublicUrl        = 'https://live.galandras.com/healthz',
    [int]    $OriginPort       = 8080,
    [int]    $IntervalSeconds  = 30,
    [int]    $FailureThreshold = 3,
    [int]    $RequestTimeoutSeconds = 10,
    [int]    $MaxBackoffSeconds     = 300,
    [string] $LogPath          = (Join-Path $PSScriptRoot '..\logs\tunnel-watchdog.log'),
    [int]    $LogMaxBytes      = 5MB,
    [string] $Webhook          = $env:ONLIVE_WATCHDOG_WEBHOOK,
    [switch] $RunOnce
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# ----------------------------------------------------------------------------
# Naplózás
# ----------------------------------------------------------------------------

$script:LogPath = [IO.Path]::GetFullPath($LogPath)
$logDir = Split-Path -Parent $script:LogPath
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }

function Write-Log {
    param(
        [Parameter(Mandatory)] [string] $Message,
        [ValidateSet('INFO', 'WARN', 'ERROR', 'OK')] [string] $Level = 'INFO'
    )

    $line = '{0} [{1,-5}] {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Level, $Message

    try {
        if ((Test-Path $script:LogPath) -and ((Get-Item $script:LogPath).Length -gt $LogMaxBytes)) {
            Move-Item $script:LogPath "$script:LogPath.1" -Force
        }
        Add-Content -Path $script:LogPath -Value $line -Encoding UTF8
    } catch {
        # A naplózás hibája soha ne állítsa meg a watchdogot.
    }

    switch ($Level) {
        'ERROR' { Write-Host $line -ForegroundColor Red }
        'WARN'  { Write-Host $line -ForegroundColor Yellow }
        'OK'    { Write-Host $line -ForegroundColor Green }
        default { Write-Host $line }
    }
}

function Send-Notification {
    param([string] $Text)

    if ([string]::IsNullOrWhiteSpace($Webhook)) { return }

    try {
        $body = @{ text = "[OnLIVE watchdog] $Text" } | ConvertTo-Json -Compress
        Invoke-RestMethod -Uri $Webhook -Method Post -Body $body `
            -ContentType 'application/json' -TimeoutSec $RequestTimeoutSeconds | Out-Null
    } catch {
        Write-Log "Webhook értesítés sikertelen: $($_.Exception.Message)" 'WARN'
    }
}

# ----------------------------------------------------------------------------
# Ellenőrzések
# ----------------------------------------------------------------------------

function Test-TunnelService {
    $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if (-not $svc) {
        return @{ Ok = $false; Reason = "A(z) '$ServiceName' service nincs telepítve (cloudflared service install)." }
    }
    if ($svc.Status -ne 'Running') {
        return @{ Ok = $false; Reason = "A(z) '$ServiceName' service állapota: $($svc.Status)." }
    }
    return @{ Ok = $true; Reason = 'service fut' }
}

function Test-TunnelReady {
    try {
        $resp = Invoke-WebRequest -Uri $ReadyUrl -UseBasicParsing -TimeoutSec $RequestTimeoutSeconds
    } catch {
        return @{ Ok = $false; Reason = "A /ready végpont nem elérhető: $($_.Exception.Message)" }
    }

    if ($resp.StatusCode -ne 200) {
        return @{ Ok = $false; Reason = "A /ready HTTP $($resp.StatusCode) választ adott." }
    }

    # A cloudflared válasza pl.: {"status":200,"readyConnections":4}
    try {
        $data = $resp.Content | ConvertFrom-Json
        if ($null -ne $data.readyConnections -and [int]$data.readyConnections -lt 1) {
            return @{ Ok = $false; Reason = 'Nincs élő konnektor a Cloudflare felé (readyConnections = 0).' }
        }
        return @{ Ok = $true; Reason = "readyConnections = $($data.readyConnections)" }
    } catch {
        # 200-as válasz értelmezhetetlen törzzsel: elfogadjuk élőnek.
        return @{ Ok = $true; Reason = '/ready 200' }
    }
}

function Test-OriginUp {
    try {
        $client = [Net.Sockets.TcpClient]::new()
        $async  = $client.BeginConnect('127.0.0.1', $OriginPort, $null, $null)
        $ok     = $async.AsyncWaitHandle.WaitOne(2000, $false)
        if ($ok) { $client.EndConnect($async) }
        $client.Close()
        return [bool]$ok
    } catch {
        return $false
    }
}

function Test-PublicEndpoint {
    try {
        $resp = Invoke-WebRequest -Uri $PublicUrl -UseBasicParsing -TimeoutSec $RequestTimeoutSeconds
        return @{ Ok = ($resp.StatusCode -lt 500); Reason = "HTTP $($resp.StatusCode)" }
    } catch {
        $status = $null
        if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }

        # 5xx a Cloudflare felől (502/530/1033) tunnel-hibát jelez.
        if ($status -and $status -lt 500) {
            return @{ Ok = $true; Reason = "HTTP $status (a tunnel válaszol)" }
        }
        return @{ Ok = $false; Reason = "publikus végpont hiba: $($_.Exception.Message)" }
    }
}

function Invoke-TunnelRestart {
    param([string] $Reason)

    Write-Log "ALAGÚT ÚJRAINDÍTÁSA — ok: $Reason" 'WARN'
    Send-Notification "Alagút újraindítása — $Reason"

    try {
        $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
        if (-not $svc) {
            Write-Log "Nem indítható újra: a(z) '$ServiceName' service nem létezik." 'ERROR'
            return $false
        }

        if ($svc.Status -eq 'Running') {
            Stop-Service -Name $ServiceName -Force -ErrorAction Stop
            $svc.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30))
        }

        Start-Service -Name $ServiceName -ErrorAction Stop
        (Get-Service -Name $ServiceName).WaitForStatus('Running', [TimeSpan]::FromSeconds(30))

        Write-Log 'A cloudflared service újraindult.' 'OK'
        return $true
    } catch {
        Write-Log "Az újraindítás sikertelen: $($_.Exception.Message)" 'ERROR'
        return $false
    }
}

# ----------------------------------------------------------------------------
# Fő ciklus
# ----------------------------------------------------------------------------

Write-Log "OnLIVE tunnel watchdog indul (service=$ServiceName, intervallum=${IntervalSeconds}s, küszöb=$FailureThreshold)" 'INFO'

$consecutiveFailures = 0
$restartCount        = 0
$wasHealthy          = $true

while ($true) {

    $failure = $null

    $svcCheck = Test-TunnelService
    if (-not $svcCheck.Ok) {
        $failure = $svcCheck.Reason
    } else {
        $readyCheck = Test-TunnelReady
        if (-not $readyCheck.Ok) {
            $failure = $readyCheck.Reason
        } elseif (Test-OriginUp) {
            $publicCheck = Test-PublicEndpoint
            if (-not $publicCheck.Ok) {
                $failure = $publicCheck.Reason
            } else {
                Write-Verbose "OK — $($readyCheck.Reason); publikus: $($publicCheck.Reason)"
            }
        } else {
            # Az origin nem fut: a publikus hiba nem az alagút hibája.
            Write-Verbose "A helyi origin (:$OriginPort) nem fut — a publikus ellenőrzés kihagyva."
        }
    }

    if ($failure) {
        $consecutiveFailures++
        Write-Log "Sikertelen ellenőrzés ($consecutiveFailures/$FailureThreshold): $failure" 'WARN'

        if ($consecutiveFailures -ge $FailureThreshold) {
            $restarted = Invoke-TunnelRestart -Reason $failure
            $restartCount++
            $consecutiveFailures = 0
            $wasHealthy = $false

            # Exponenciális visszalépés: 30s → 60s → 120s → … max $MaxBackoffSeconds
            $backoff = [Math]::Min($IntervalSeconds * [Math]::Pow(2, [Math]::Min($restartCount, 6)), $MaxBackoffSeconds)
            Write-Log ("Várakozás {0}s a következő ellenőrzésig (restart #{1}, sikeres: {2})" -f [int]$backoff, $restartCount, $restarted) 'INFO'

            if ($RunOnce) { break }
            Start-Sleep -Seconds ([int]$backoff)
            continue
        }
    } else {
        if (-not $wasHealthy) {
            Write-Log 'Az alagút helyreállt (recovered).' 'OK'
            Send-Notification 'Az alagút helyreállt.'
            $wasHealthy   = $true
            $restartCount = 0
        }
        $consecutiveFailures = 0
    }

    if ($RunOnce) { break }
    Start-Sleep -Seconds $IntervalSeconds
}

Write-Log 'A watchdog leállt.' 'INFO'
