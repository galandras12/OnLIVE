/**
 * Minimális naplózó. Szándékosan függőség nélkül: egy élő közvetítő
 * szervernél a konzol az elsődleges visszajelzés, nem egy log-aggregátor.
 */

const COLORS = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
};

const stamp = () => new Date().toISOString().slice(11, 19);

function write(stream, color, tag, message, extra) {
  const line = `${COLORS.dim}${stamp()}${COLORS.reset} ${color}${tag.padEnd(5)}${COLORS.reset} ${message}`;
  if (extra === undefined) stream(line);
  else stream(line, extra);
}

export const logger = {
  info: (message, extra) => write(console.log, COLORS.blue, 'INFO', message, extra),
  ok: (message, extra) => write(console.log, COLORS.green, 'OK', message, extra),
  warn: (message, extra) => write(console.warn, COLORS.yellow, 'WARN', message, extra),
  error: (message, extra) => write(console.error, COLORS.red, 'HIBA', message, extra),
  state: (message, extra) => write(console.log, COLORS.magenta, 'ÁLL.', message, extra),
  colors: COLORS,
};
