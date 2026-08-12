/**
 * IDEIGLENES `/live` oldal — a 4. szegmens végponttól végpontig teszteléséhez.
 *
 * Csak annyit tesz, hogy Socket.io-n figyeli az állapotot, és kiírja, melyik
 * képernyőt KELLENE mutatni. Nincs benne overlay, intro/outro média, widget —
 * mindaz az 5–7. szegmens dolga, és akkor ez a fájl lecserélődik.
 *
 * Már most úgy viselkedik, ahogy egy OBS Browser Source-tól elvárt:
 * nincs görgetősáv, nincs interaktív elem, a háttér egyszínű.
 */

export function livePlaceholderPage() {
  return `<!doctype html>
<html lang="hu">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OnLIVE</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 100%; height: 100%; overflow: hidden; background: #0B0D10; }
  body {
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    color: #e5e7eb;
    display: grid;
    place-items: center;
    text-align: center;
  }
  .screen { display: none; }
  .screen.active { display: block; }
  .label { font-size: clamp(2rem, 8vw, 5rem); font-weight: 800; letter-spacing: -0.02em; }
  .sub { margin-top: .75rem; color: #9ca3af; font-size: clamp(.9rem, 2.5vw, 1.25rem); }
  .dot { display: inline-block; width: .6em; height: .6em; border-radius: 50%; margin-right: .4em; }
  .live .dot { background: #ef4444; animation: pulse 1.4s ease-in-out infinite; }
  .intro .dot { background: #f59e0b; }
  .interrupted .dot { background: #f59e0b; }
  .outro .dot { background: #6366f1; }
  @keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: .35 } }
  .note {
    position: fixed; left: 0; right: 0; bottom: 0;
    padding: .5rem; font-size: .75rem; color: #4b5563;
    border-top: 1px solid #1f2937;
  }
  .timer { margin-top: .5rem; font-variant-numeric: tabular-nums; color: #6b7280; }
</style>
</head>
<body>

  <div id="blank" class="screen active"><div class="label" style="color:#374151">OnLIVE</div></div>

  <div id="intro" class="screen intro">
    <div class="label"><span class="dot"></span>Hamarosan kezdünk</div>
    <div class="sub" id="introReason"></div>
  </div>

  <div id="live" class="screen live">
    <div class="label"><span class="dot"></span>ÉLŐ</div>
    <div class="timer" id="elapsed"></div>
  </div>

  <div id="interrupted" class="screen interrupted">
    <div class="label"><span class="dot"></span>Megszakadt</div>
    <div class="sub" id="interruptedSub">Mindjárt folytatjuk…</div>
  </div>

  <div id="outro" class="screen outro">
    <div class="label"><span class="dot"></span>Köszönjük, hogy velünk voltál!</div>
    <div class="timer" id="outroTimer"></div>
  </div>

  <div class="note">Ideiglenes képernyő — az overlay-kompozíció az 5–7. szegmensben készül el.</div>

<script src="/socket.io/socket.io.js"></script>
<script>
  const socket = io({ query: { role: 'live' } });
  let current = null;

  function show(screen) {
    for (const el of document.querySelectorAll('.screen')) {
      el.classList.toggle('active', el.id === screen);
    }
  }

  function render(state) {
    current = state;
    show(state.screen);

    const reason = {
      start: 'Az adás indul, várjuk a képet…',
      interrupted: 'A kapcsolat megszakadt, újraindítjuk…',
      resume: 'Folytatjuk, várjuk a képet…',
    }[state.introReason] ?? '';
    document.getElementById('introReason').textContent = reason;

    document.getElementById('interruptedSub').textContent =
      state.state === 'paused' ? 'Mindjárt folytatjuk…' : 'A kapcsolat helyreállítása folyamatban…';
  }

  function tick() {
    if (!current) return;
    if (current.screen === 'live') {
      const total = Math.floor((current.liveElapsedMs ?? 0) / 1000) +
                    Math.floor((Date.now() - current.at) / 1000);
      const mm = String(Math.floor(total / 60)).padStart(2, '0');
      const ss = String(total % 60).padStart(2, '0');
      document.getElementById('elapsed').textContent = mm + ':' + ss;
    }
    if (current.screen === 'outro' && current.outro?.endsAt) {
      const left = Math.max(0, Math.ceil((current.outro.endsAt - Date.now()) / 1000));
      document.getElementById('outroTimer').textContent = left + ' mp';
    }
  }

  socket.on('onlive:state', render);
  socket.on('connect_error', () => show('blank'));
  setInterval(tick, 250);
</script>
</body>
</html>`;
}
