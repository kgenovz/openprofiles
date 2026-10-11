import fs from 'node:fs';
import { createSelfAddon } from './addon/manifest.js';
import { ConfigError, loadConfig } from './config.js';
import { Cipher, loadOrCreateKey } from './crypto.js';
import { openDatabase } from './db.js';
import { Repo } from './core/repo.js';
import { ProfilesService } from './core/service.js';
import { createLogger } from './log.js';
import { StremioClient } from './stremio/client.js';
import { createApp } from './web/app.js';

const SHUTDOWN_GRACE_MS = 25_000;

function main() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
  const log = createLogger(config.logLevel);

  fs.mkdirSync(config.dataDir, { recursive: true });
  const cipher = new Cipher(loadOrCreateKey(config));
  const db = openDatabase(config.dataDir);
  const repo = new Repo(db, cipher);
  const stremio = new StremioClient({ baseUrl: config.stremioApiUrl, log });
  const service = new ProfilesService({ repo, stremio, log, selfAddon: createSelfAddon(config) });

  const open = repo.getOpenJournal();
  if (open) log.warn('An earlier switch did not finish; resolve it on the web page', { journalId: open.id, kind: open.kind });

  const app = createApp({ config, db, service, log });
  const server = app.listen(config.port, () => {
    log.info(`OpenProfiles listening on port ${config.port}`, { publicUrl: config.publicUrl, dataDir: config.dataDir });
  });

  // Let a running switch finish before exiting; if it can't in time, the
  // journal records it and the web page offers recovery on next boot.
  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    log.info(`${signal} received, shutting down`);
    server.close();
    const timeout = new Promise((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS).unref());
    await Promise.race([service.lock.idle(), timeout]);
    db.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main();
