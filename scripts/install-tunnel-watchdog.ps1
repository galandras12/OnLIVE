<#
.SYNOPSIS
    OnLIVE — a tunnel watchdog regisztrálása Windows ütemezett feladatként.

.DESCRIPTION
    Létrehoz egy "OnLIVE Tunnel Watchdog" nevű feladatot, ami rendszerindításkor
    automatikusan elindítja a scripts/tunnel-watchdog.ps1 szkriptet SYSTEM
    jogosultsággal (ez kell a service újraindításához), és hiba esetén
    automatikusan újraindul.

    Rendszergazdai PowerShellből futtatandó, a repó gyökeréből:
        powershell -ExecutionPolicy Bypass -File .\scripts\install-tunnel-watchdog.ps1

.PARAMETER Uninstall
    A feladat eltávolítása.
#>

[CmdletBinding()]
param(
    [string] $TaskName = 'OnLIVE Tunnel Watchdog',
    [switch] $Uninstall
)

$ErrorActionPreference = 'Stop'

$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
           ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
    throw 'Ezt a szkriptet rendszergazdai PowerShellből kell futtatni.'
}

if ($Uninstall) {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "Eltávolítva: '$TaskName'" -ForegroundColor Green
    } else {
        Write-Host "Nincs ilyen ütemezett feladat: '$TaskName'" -ForegroundColor Yellow
    }
    return
}

$watchdog = Join-Path $PSScriptRoot 'tunnel-watchdog.ps1'
if (-not (Test-Path $watchdog)) {
    throw "Nem található: $watchdog"
}

$action = New-ScheduledTaskAction `
    -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$watchdog`"" `
    -WorkingDirectory (Split-Path -Parent $PSScriptRoot)

$trigger   = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero)

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Write-Host "Meglévő feladat felülírása: '$TaskName'" -ForegroundColor Yellow
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

Register-ScheduledTask `
    -TaskName $TaskName `
    -Description 'OnLIVE: figyeli a Cloudflare Tunnel állapotát, és megszakadás esetén újraindítja.' `
    -Action $action -Trigger $trigger -Principal $principal -Settings $settings | Out-Null

Start-ScheduledTask -TaskName $TaskName

Write-Host "Regisztrálva és elindítva: '$TaskName'" -ForegroundColor Green
Write-Host "Napló: $(Join-Path (Split-Path -Parent $PSScriptRoot) 'logs\tunnel-watchdog.log')"
Write-Host "Állapot:  Get-ScheduledTask -TaskName '$TaskName' | Get-ScheduledTaskInfo"
