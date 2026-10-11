import { GuardError, checkAddons, checkLibrary, checkNotifs } from './guard.js';
import { countActive } from './library.js';

const LABEL = 'The backup file';

/**
 * Read a StremShare account backup export. Two shapes exist (StremShare
 * docs/snapshot-profiles-retirement-plan.md, "Appendix: backup export format v1"):
 *   v1:     format "stremshare-account-backup", version 1, snake_case, `notifications`
 *   pre-v1: schemaVersion 1, camelCase (stremioEmail, createdAt), `notifs`, counts required
 * Returns the snapshot plus what's known about where it came from. Throws
 * GuardError on anything that could damage the account if applied.
 */
export function parseStremShareBackup(raw) {
  const fail = (code, msg) => {
    throw new GuardError(code, msg);
  };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('NOT_A_BACKUP', "That file isn't a StremShare backup.");
  }

  let notifs;
  let meta;
  if (raw.format !== undefined) {
    if (raw.format !== 'stremshare-account-backup') fail('NOT_A_BACKUP', "That file isn't a StremShare backup.");
    if (raw.version !== 1) fail('UNSUPPORTED', `This backup file is version ${raw.version ?? '(missing)'}; OpenProfiles reads version 1.`);
    notifs = raw.notifications;
    meta = {
      sourceUserId: typeof raw.stremio_user_id === 'string' ? raw.stremio_user_id : null,
      sourceEmail: typeof raw.stremio_email === 'string' ? raw.stremio_email : null,
      createdAt: raw.created_at ?? raw.exported_at ?? null,
    };
  } else if (raw.schemaVersion !== undefined) {
    if (raw.schemaVersion !== 1) fail('UNSUPPORTED', `This backup file is version ${raw.schemaVersion}; OpenProfiles reads version 1.`);
    if (!raw.counts || typeof raw.counts.library !== 'number') {
      fail('CORRUPT', 'This older StremShare backup is missing its item counts, so it may be damaged. Refusing to import it.');
    }
    notifs = raw.notifs;
    meta = {
      sourceUserId: null,
      sourceEmail: typeof raw.stremioEmail === 'string' ? raw.stremioEmail : null,
      createdAt: raw.createdAt ?? null,
    };
  } else {
    fail('NOT_A_BACKUP', "That file isn't a StremShare backup.");
  }

  const { library, addons } = raw;
  checkLibrary(library, LABEL);
  checkAddons(addons, LABEL);
  if (!Array.isArray(notifs)) fail('MALFORMED', `${LABEL} is missing its notifications.`);
  checkNotifs(notifs, LABEL);
  if (raw.counts && typeof raw.counts.library === 'number' && raw.counts.library > 0 && countActive(library) === 0) {
    fail('CORRUPT', `${LABEL} says it has ${raw.counts.library} library items but none could be read. Refusing to import it.`);
  }

  return {
    snapshot: { library, addons, notifs },
    label: typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim().slice(0, 80) : null,
    kind: typeof raw.kind === 'string' ? raw.kind : null,
    ...meta,
  };
}

/** "Profile: Kids" → "Kids"; anything else → the label itself. */
export function suggestedProfileName(label) {
  if (!label) return 'Imported';
  const m = /^Profile:\s*(.+)$/i.exec(label);
  return (m ? m[1] : label).trim().slice(0, 40) || 'Imported';
}

/**
 * Whether the file came from the linked account: true, false, or null when
 * the file doesn't say (older exports only carry an email, some nothing).
 */
export function sameAccount(parsed, account) {
  if (parsed.sourceUserId) return parsed.sourceUserId === account.stremio_user_id;
  if (parsed.sourceEmail) return parsed.sourceEmail.toLowerCase() === account.stremio_email.toLowerCase();
  return null;
}
