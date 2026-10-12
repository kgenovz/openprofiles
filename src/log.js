const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const PROBLEM_KINDS = 50;

/**
 * Minimal leveled logger. Callers must never pass Stremio response bodies,
 * auth keys or add-on transport URLs (they carry debrid keys).
 *
 * Errors and warnings are also counted by message (whatever the level), for
 * the Server tab. Only the message is kept, never the fields, so the counts
 * can't carry anything about an account.
 */
export function createLogger(level = 'info', sink = console, now = () => Date.now()) {
  let max = LEVELS[level] ?? LEVELS.info;
  const problems = new Map();
  const count = (lvl, msg) => {
    const key = `${lvl}|${msg}`;
    const seen = problems.get(key);
    if (seen) {
      seen.count++;
      seen.last = now();
      problems.delete(key);
      problems.set(key, seen);
      return;
    }
    if (problems.size >= PROBLEM_KINDS) problems.delete(problems.keys().next().value);
    problems.set(key, { level: lvl, message: String(msg).slice(0, 200), count: 1, first: now(), last: now() });
  };
  const emit = (lvl, msg, fields) => {
    if (lvl === 'error' || lvl === 'warn') count(lvl, msg);
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
    setLevel(next) {
      if (Object.hasOwn(LEVELS, next)) max = LEVELS[next];
    },
    /** Errors and warnings since start, newest first. */
    problems: () => [...problems.values()].reverse().map((p) => ({ ...p })),
  };
}

export const silentLogger = { error() {}, warn() {}, info() {}, debug() {}, setLevel() {}, problems: () => [] };
