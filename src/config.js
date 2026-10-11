import path from 'node:path';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const LOG_LEVELS = new Set(['error', 'warn', 'info', 'debug']);

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

  const adminPassword = env.ADMIN_PASSWORD || '';
  if (!adminPassword) problems.push('ADMIN_PASSWORD is required');
  else if (adminPassword.length < 8) problems.push('ADMIN_PASSWORD must be at least 8 characters');

  const port = env.PORT ? Number(env.PORT) : 7000;
  if (!Number.isInteger(port) || port < 1 || port > 65535) problems.push('PORT must be a port number');

  const logLevel = (env.LOG_LEVEL || 'info').toLowerCase();
  if (!LOG_LEVELS.has(logLevel)) problems.push(`LOG_LEVEL must be one of: ${[...LOG_LEVELS].join(', ')}`);

  if (problems.length) throw new ConfigError(problems);

  return {
    publicUrl,
    adminPassword,
    port,
    logLevel,
    dataDir: path.resolve(env.DATA_DIR || './data'),
    secretKey: env.SECRET_KEY || null,
    stremioApiUrl: (env.STREMIO_API_URL || 'https://api.strem.io').replace(/\/+$/, ''),
    // Express "trust proxy": the default covers a reverse proxy on the same
    // host or Docker network (Caddy, Traefik, nginx).
    trustProxy: env.TRUST_PROXY ?? 'loopback, uniquelocal',
  };
}
