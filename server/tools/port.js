#!/usr/bin/env node
/**
 * Kiírja azt a portot, amin a szerver indulni fog — semmi mást (1.0.012).
 *
 * A `start.bat` ezt olvassa be, hogy MÉG az indítás előtt ki tudja írni, hol
 * lesz elérhető a felület, és hogy meg tudja nézni, foglalt-e a port. Ezért a
 * kimenet szándékosan egyetlen szám, sortöréssel — batch `for /f`-fel így
 * dolgozható fel egyszerűen.
 *
 * A forrás-sorrend ugyanaz, mint a szerverben (felület → env → 8080), mert
 * ugyanabból a konfigurációból olvas.
 */

import { config } from '../src/config.js';

process.stdout.write(`${config.port}\n`);
