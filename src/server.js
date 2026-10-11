import fs from 'node:fs';
import { createSelfAddon } from './addon/manifest.js';
import { ConfigError, loadConfig } from './config.js';
import { Cipher, loadOrCreateKey } from './crypto.js';
import { openDatabase } from './db.js';
import { AccountsService } from './core/accounts.js';
import { WrongKeyError, checkSecretKey } from './core/keycheck.js';
import { upgradeLegacyEncryption } from './core/rekey.js';
import { startScheduler } from './core/scheduler.js';
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
  if (config.legacyAdminPassword) {
    log.warn('ADMIN_PASSWORD is no longer used: people sign in with their Stremio account. Remove it from your settings.');
  }

  fs.mkdirSync(config.dataDir, { recursive: true });
  const key = loadOrCreateKey(config);
  const cipher = new Cipher(key);
  const db = openDatabase(config.dataDir);
  upgradeLegacyEncryption(db, cipher, log);
  try {
    checkSecretKey(db, key, cipher);
  } catch (err) {
    if (err instanceof WrongKeyError) {
      log.error(err.message);
      process.exit(1);
    }
    throw err;
  }
  const stremio = new StremioClient({ baseUrl: config.stremioApiUrl, log });
  const accounts = new AccountsService({ db, cipher, stremio, log, selfAddon: createSelfAddon(config), access: config.access });

  const open = db.prepare("SELECT COUNT(*) AS n FROM switch_journal WHERE status = 'open'").get().n;
  if (open) log.warn('Some earlier switches did not finish; each account sees a recovery prompt on its page', { open });
  log.info('Access rule', { mode: config.access.mode, accounts: accounts.accounts.count() });

  const scheduler = startScheduler({ db, dataDir: config.dataDir, accounts, log });

  const app = createApp({ config, db, accounts, log });
  const server = app.listen(config.port, () => {
    log.info(`OpenProfiles listening on port ${config.port}`, { publicUrl: config.publicUrl, dataDir: config.dataDir });
  });

  // Let running switches finish before exiting; if one can't in time, its
  // journal records it and the web page offers recovery on next boot.
  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    log.info(`${signal} received, shutting down`);
    scheduler.stop();
    server.close();
    const timeout = new Promise((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS).unref());
    const idle = Promise.all([...accounts.services.values()].map((s) => s.lock.idle()));
    await Promise.race([idle, timeout]);
    db.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main();
