# OnLIVE — cloudflared gyorstalpaló

Teljes leírás (döntések, buktatók, watchdog, hibakeresés):
[`docs/NETWORKING.md`](../../docs/NETWORKING.md).

Ez a fájl csak a parancsok sorrendje, másolható formában.

## Egyszeri beállítás

```powershell
# 1) telepítés
winget install --id Cloudflare.cloudflared

# 2) bejelentkezés (válaszd a galandras.com zónát)
cloudflared tunnel login

# 3) named tunnel létrehozása — jegyezd fel a kiírt tunnel ID-t
cloudflared tunnel create livestream

# 4) DNS route-ok (mindhárom subdomain egy tunnelen)
cloudflared tunnel route dns livestream admin.galandras.com
cloudflared tunnel route dns livestream live.galandras.com
cloudflared tunnel route dns livestream ingest.galandras.com

# 5) konfiguráció
mkdir "$env:USERPROFILE\.cloudflared" -Force
copy config.example.yml "$env:USERPROFILE\.cloudflared\config.yml"
notepad "$env:USERPROFILE\.cloudflared\config.yml"   # töltsd ki a <...> helyeket

# 6) próbafuttatás előtérben
cloudflared tunnel --config "$env:USERPROFILE\.cloudflared\config.yml" run livestream

# 7) ha jó: Windows service (autostart reboot után) — rendszergazdaként
cloudflared service install
Start-Service cloudflared

# 8) watchdog regisztrálása — rendszergazdaként, a repó gyökeréből
powershell -ExecutionPolicy Bypass -File .\scripts\install-tunnel-watchdog.ps1
```

## Napi ellenőrzés

```powershell
Get-Service cloudflared
cloudflared tunnel info livestream
curl.exe http://127.0.0.1:20241/ready
curl.exe -I https://admin.galandras.com
```

## Titkok

A `<tunnel-id>.json` credentials fájl és a `cert.pem` **soha nem kerülhet a
repóba** — a `.gitignore` tiltja őket. Ha véletlenül mégis bekerült, azonnal:

```powershell
cloudflared tunnel delete livestream   # és hozd létre újra
```
