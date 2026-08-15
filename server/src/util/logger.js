/**
 * A projekt közös naplózója (11. szegmens).
 *
 * Korábban ez egy egyszerű konzol-wrapper volt. Mostantól a strukturált
 * `log/logger.js` példánya, ami a konzol mellé JSON sorokat is ír a
 * `logs/YYYY-MM-DD.log` fájlba. A régi API (`info`/`warn`/`error`/`ok`/
 * `state`/`colors`) változatlan, tehát minden korábbi hívás működik tovább.
 */

import { Logger } from '../log/logger.js';
import { config } from '../config.js';

export const logger = new Logger({ logDir: config.logDir });

export { LogEvent, Source, clientId, diffSettings, describeChanges } from '../log/logger.js';
