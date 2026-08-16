@echo off
rem ============================================================================
rem  OnLIVE — a MediaMTX hookok környezete (SABLON)
rem
rem  Másold `hook-env.bat` néven ugyanebbe a mappába, és töltsd ki.
rem  A kitöltött változatot a .gitignore kizárja (titkot tartalmaz).
rem
rem  Miért külön fájl: a MediaMTX-et ütemezett feladat indítja, aminek nincs
rem  meg a felhasználói környezet — így a hookok nem látnák a rendszerváltozókat.
rem ============================================================================

rem A vezérlő szerver alap-URL-je. Helyi hívás, ezért localhost — nem kell
rem kimenni a Cloudflare alagútra ahhoz, hogy a szomszéd folyamatnak szóljunk.
set ONLIVE_CONTROL_URL=http://127.0.0.1:8080

rem Közös titok. A vezérlő szerver ezt ellenőrzi az X-OnLIVE-Hook-Secret
rem fejlécben, hogy senki más ne tudjon hamis ingest-eseményt beküldeni.
set ONLIVE_HOOK_SECRET=valtoztasd-meg

rem A hook naplója (hibakereséshez).
set ONLIVE_HOOK_LOG=C:\OnLIVE\logs\mediamtx-hooks.log
