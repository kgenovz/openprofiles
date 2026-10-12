import path from 'node:path';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const LOG_LEVELS = new Set(['error', 'warn', 'info', 'debug']);
const ACCESS_MODES = new Set(['owner', 'list', 'open']);

export class ConfigError extends Error {
  constructor(problems) {
    super(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
    this.problems = problems;
  }
}

/**
 * Read and validate settings from the environment. Throws ConfigError listing
 * every problem at once so a first `docker compose up` shows them all.
 */
export function loadConfig(env = process.env) {
  const problems = [];

  const publicUrl = (env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
  if (!publicUrl) {
    problems.push('PUBLIC_URL is required (the https address this server is reachable at)');
  } else {
    let url = null;
    try {
      url = new URL(publicUrl);
    } catch {
      problems.push('PUBLIC_URL is not a valid URL');
    }
    // Stremio only installs add-ons over https, except from localhost.
    if (url && url.protocol !== 'https:' && !LOCAL_HOSTS.has(url.hostname)) {
      problems.push('PUBLIC_URL must start with https:// (Stremio refuses plain-http add-ons)');
    }
  }

  // Who may sign in with their Stremio account (see core/accounts.js accessDecision).
  const mode = (env.ACCESS || 'owner').toLowerCase();
  if (!ACCESS_MODES.has(mode)) problems.push(`ACCESS must be one of: ${[...ACCESS_MODES].join(', ')}`);
  const allowed = (env.ALLOWED_ACCOUNTS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (mode === 'list' && allowed.length === 0) problems.push('ACCESS=list needs ALLOWED_ACCOUNTS (Stremio emails or user ids, comma-separated)');
  const maxAccounts = env.MAX_ACCOUNTS ? Number(env.MAX_ACCOUNTS) : Infinity;
  if (!(maxAccounts > 0)) problems.push('MAX_ACCOUNTS must be a positive number');

  const port = env.PORT ? Number(env.PORT) : 7000;
  if (!Number.isInteger(port) || port < 1 || port > 65535) problems.push('PORT must be a port number');

  const logLevel = (env.LOG_LEVEL || 'info').toLowerCase();
  if (!LOG_LEVELS.has(logLevel)) problems.push(`LOG_LEVEL must be one of: ${[...LOG_LEVELS].join(', ')}`);

  if (problems.length) throw new ConfigError(problems);

  return {
    publicUrl,
    access: { mode, allowed, maxAccounts },
    // Ignored since sign-in moved to Stremio accounts; server.js warns if it's still set.
    legacyAdminPassword: Boolean(env.ADMIN_PASSWORD),
    port,
    logLevel,
    dataDir: path.resolve(env.DATA_DIR || './data'),
    secretKey: env.SECRET_KEY || null,
    stremioApiUrl: (env.STREMIO_API_URL || 'https://api.strem.io').replace(/\/+$/, ''),
    // Express "trust proxy": the default covers a reverse proxy on the same
    // host or Docker network (Caddy, Traefik, nginx).
    trustProxy: env.TRUST_PROXY ?? 'loopback, uniquelocal',
    // Let the add-on manager fetch add-ons on private networks (a home server's LAN). Off by default.
    allowPrivateAddons: /^(1|true|yes)$/i.test(env.ALLOW_PRIVATE_ADDONS || ''),
    // Shown to people signing in to a shared server: who runs it, and anything the
    // operator adds about their setup (e.g. "The web proxy keeps no access logs.").
    operator: (env.OPERATOR || '').trim().slice(0, 80) || null,
    privacyNote: (env.PRIVACY_NOTE || '').trim().slice(0, 500) || null,
  };
}
