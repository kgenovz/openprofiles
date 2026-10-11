const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

/**
 * Minimal leveled logger. Callers must never pass Stremio response bodies,
 * auth keys or add-on transport URLs (they carry debrid keys).
 */
export function createLogger(level = 'info', sink = console) {
  const max = LEVELS[level] ?? LEVELS.info;
  const emit = (lvl, msg, fields) => {
    if (LEVELS[lvl] > max) return;
    const line = `${new Date().toISOString()} ${lvl.toUpperCase().padEnd(5)} ${msg}`;
    const out = fields && Object.keys(fields).length ? `${line} ${JSON.stringify(fields)}` : line;
    (lvl === 'error' || lvl === 'warn' ? sink.error : sink.log).call(sink, out);
  };
  return {
    error: (msg, fields) => emit('error', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    debug: (msg, fields) => emit('debug', msg, fields),
  };
}

export const silentLogger = { error() {}, warn() {}, info() {}, debug() {} };
