import crypto from 'node:crypto';
import fs from 'node:fs';
import { AVATAR_COLOURS } from '../core/service.js';
import { html } from './html.js';

// Static files are cached for an hour; a content hash in their URLs makes updates show at once.
const ASSET_VERSION = crypto.createHash('sha1')
  .update(fs.readFileSync(new URL('./static/app.css', import.meta.url)))
  .update(fs.readFileSync(new URL('./static/app.js', import.meta.url)))
  .digest('hex').slice(0, 10);

// Layout and styling follow the "Settings page" artboard of the M2 design canvas.

const KIND_LABELS = {
  original: 'Setup',
  auto: 'Automatic',
  pre_switch: 'Before a switch',
  pre_restore: 'Before a restore',
  manual: 'Manual',
  imported: 'Imported',
};

const COLOUR_NAMES = ['Red', 'Orange', 'Amber', 'Green', 'Teal', 'Blue', 'Purple', 'Pink'];

const dateFmt = new Intl.DateTimeFormat('en-CA', { dateStyle: 'medium', timeStyle: 'short' });
const when = (ms) => (ms ? dateFmt.format(new Date(ms)) : 'never');
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function counts(row, { notifs = true } = {}) {
  const parts = [plural(row.library_count, 'title'), plural(row.addon_count, 'add-on')];
  if (notifs) parts.push(row.notif_count == null ? 'notifications not saved' : plural(row.notif_count, 'notification'));
  return parts.join(' · ');
}

const csrfField = (csrf) => html`<input type="hidden" name="_csrf" value="${csrf}">`;

function postButton({ action, csrf, label, style = '', confirm, disabled = false }) {
  return html`<form method="post" action="${action}" class="inline" ${confirm ? html`data-confirm="${confirm}"` : ''}>
    ${csrfField(csrf)}
    <button type="submit" class="${style}" ${disabled ? 'disabled' : ''}>${label}</button>
  </form>`;
}

const initialOf = (name) => [...name][0]?.toLocaleUpperCase() || '?';

const icon = {
  logo: html`<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.2"/><path d="M3.5 19c.8-3 3-4.6 5.5-4.6s4.7 1.6 5.5 4.6"/><path d="M16 5.5a3 3 0 0 1 0 5.6M18 14.6c1.3.6 2.2 2 2.6 4.4"/></svg>`,
  check: html`<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`,
  alert: html`<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5h.01"/></svg>`,
  pencil: html`<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>`,
  plus: html`<svg aria-hidden="true" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>`,
};

function colourPicker(name, selected) {
  return html`<fieldset class="swatches"><legend>Colour</legend>
    ${AVATAR_COLOURS.map((c, i) => html`<label class="swatch" style="--c:${c}">
      <input type="radio" name="${name}" value="${c}" ${c === selected ? 'checked' : ''}><span></span>
      <span class="sr-only">${COLOUR_NAMES[i]}</span></label>`)}
  </fieldset>`;
}

export function layout({ title, body, account, csrf }) {
  return html`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>${title} · OpenProfiles</title>
  <link rel="icon" href="/logo.png">
  <link rel="stylesheet" href="/fonts/400.css">
  <link rel="stylesheet" href="/fonts/600.css">
  <link rel="stylesheet" href="/fonts/800.css">
  <link rel="stylesheet" href="/static/app.css?v=${ASSET_VERSION}">
  <script src="/static/app.js?v=${ASSET_VERSION}" defer></script>
</head>
<body>
  <header class="top">
    <span class="brand"><span class="brand-mark">${icon.logo}</span>OpenProfiles</span>
    ${csrf ? html`<div class="top-right">
      ${account ? html`<span class="hint">${account.email}</span>` : ''}
      ${postButton({ action: '/logout', csrf, label: 'Sign out', style: 'link' })}
    </div>` : ''}
  </header>
  <main>${body}</main>
</body>
</html>`;
}

function flashBlock(flash) {
  if (!flash) return '';
  return html`<div class="flash flash-${flash.type}" role="status">
    ${flash.type === 'ok' ? icon.check : icon.alert}
    <div>
      <p>${flash.text}</p>
      ${flash.details?.length ? html`<ul>${flash.details.map((d) => html`<li>${d}</li>`)}</ul>` : ''}
    </div>
  </div>`;
}

export function loginPage({ error }) {
  return layout({
    title: 'Sign in',
    body: html`<section class="card narrow">
      <h1>Sign in</h1>
      ${error ? html`<div class="flash flash-error">${icon.alert}<p>${error}</p></div>` : ''}
      <form method="post" action="/login" class="stack">
        <label>Admin password <input type="password" name="password" autocomplete="current-password" required autofocus></label>
        <button type="submit" class="primary">Sign in</button>
      </form>
    </section>`,
  });
}

function stremioSignInForm(csrf, { renew = false } = {}) {
  return html`<form method="post" action="/account/link" class="stack">
    ${csrfField(csrf)}
    <label>Stremio email <input type="email" name="email" autocomplete="username" required></label>
    <label>Stremio password <input type="password" name="password" autocomplete="current-password" required></label>
    <p class="hint">Your password goes to Stremio once to get a sign-in key, and is never stored.</p>
    <button type="submit" class="primary">${renew ? 'Sign in again' : 'Connect Stremio account'}</button>
  </form>`;
}

export function setupPage({ csrf, flash }) {
  return layout({
    title: 'Set up',
    csrf,
    body: html`${flashBlock(flash)}
    <section class="card narrow">
      <h1>Connect your Stremio account</h1>
      <p>OpenProfiles gives one Stremio account several profiles. Each profile keeps its own library,
        add-ons and notifications. Switching saves the current state into the profile you're leaving
        and loads the one you pick.</p>
      <p>Your account as it is right now becomes the <strong>Original</strong> profile, and a
        permanent backup of it is kept.</p>
      <p class="hint">Stremio Supporter accounts have built-in profiles that work on several devices
        at once. If you have that, use it instead.</p>
      ${stremioSignInForm(csrf)}
    </section>`,
  });
}

function recoveryBanner(j, csrf) {
  if (!j) return '';
  const what = j.kind === 'switch'
    ? html`switching from <strong>${j.fromName ?? '(none)'}</strong> to <strong>${j.toName ?? '(deleted)'}</strong>`
    : html`restoring the backup <strong>${j.targetBackup?.label ?? '(deleted)'}</strong>`;
  return html`<section class="card banner" role="alert">
    <h2>A ${j.kind} didn't finish</h2>
    <p>On ${when(j.started_at)}, ${what} stopped partway, so the Stremio account may be a mix of both.
      Nothing else can change until this is resolved.</p>
    ${j.error ? html`<p class="hint">Reason: ${j.error}</p>` : ''}
    <div class="row">
      ${postButton({ action: '/recovery/finish', csrf, label: j.kind === 'switch' ? `Finish switching to ${j.toName ?? 'the target'}` : 'Finish restoring', style: 'primary' })}
      ${postButton({ action: '/recovery/rollback', csrf, label: j.kind === 'switch' ? `Go back to ${j.fromName ?? 'the previous state'}` : 'Go back to before the restore' })}
    </div>
  </section>`;
}

function profileCard(p, { active, csrf, locked }) {
  return html`<article class="profile ${active ? 'is-active' : ''}">
    <div class="profile-banner" style="background:${p.avatar_colour}">
      <span class="profile-initial" aria-hidden="true">${initialOf(p.name)}</span>
      ${active ? html`<span class="pill">In use</span>` : ''}
    </div>
    <div class="profile-body">
      <div>
        <h3>${p.name}</h3>
        <p class="hint">${counts(p, { notifs: false })}</p>
        <p class="hint">Saved ${when(p.snapshot_taken_at)}</p>
      </div>
      <div class="profile-actions">
        ${active
          ? postButton({ action: `/profiles/${p.id}/save`, csrf, label: 'Save now', style: 'grow' })
          : postButton({ action: `/profiles/${p.id}/switch`, csrf, label: html`Switch<span class="sr-only"> to ${p.name}</span>`, style: 'primary grow', disabled: locked })}
        <details class="edit">
          <summary class="icon-button" aria-label="Edit ${p.name}">${icon.pencil}</summary>
          <div class="edit-panel">
            <form method="post" action="/profiles/${p.id}/rename" class="stack">
              ${csrfField(csrf)}
              <label>Name <input name="name" value="${p.name}" maxlength="40" required></label>
              <button type="submit">Rename</button>
            </form>
            <form method="post" action="/profiles/${p.id}/avatar" class="stack">
              ${csrfField(csrf)}
              ${colourPicker('colour', p.avatar_colour)}
              <button type="submit">Save colour</button>
            </form>
            ${active ? html`<p class="hint">The profile in use can't be deleted.</p>` : postButton({ action: `/profiles/${p.id}/delete`, csrf, label: 'Delete profile', style: 'danger', confirm: `Delete "${p.name}"? Its saved library, add-ons and notifications are gone for good.` })}
          </div>
        </details>
      </div>
    </div>
  </article>`;
}

function addonCard(addon, csrf) {
  if (!addon) return '';
  const status = addon.installed === true
    ? html`<span class="status status-ok">${icon.check} Installed on this account</span>`
    : addon.installed === false
      ? html`<span class="status">Not installed yet</span>`
      : '';
  return html`<section class="card" id="install">
    <div class="card-head">
      <h2>Switch from inside Stremio</h2>
      ${status}
    </div>
    <p class="lede">Installing adds a <strong>Switch profile</strong> row to Stremio's Home. Opening a
      profile there switches to it; then close and reopen Stremio. Every profile keeps the add-on, so the
      row never disappears.</p>
    <div class="row">
      <a class="button primary" href="${addon.installUrl}">Install in Stremio</a>
      <button type="button" data-copy="${addon.manifestUrl}" data-copied="Copied">Copy add-on link</button>
    </div>
    <details class="fold">
      <summary>The link is a password</summary>
      <p class="hint">Anyone with the add-on link can switch this account's profile. If it leaks, get a
        new link: the old one stops working, and if the add-on is installed, Stremio's copy is updated
        for you.</p>
      <div class="row align-end">
        <label class="grow">Add-on link <input readonly value="${addon.manifestUrl}" class="mono"></label>
        ${postButton({ action: '/addon/rotate', csrf, label: 'Get a new link', style: 'danger', confirm: 'Make a new add-on link? The current one stops working.' })}
      </div>
    </details>
  </section>`;
}

export function dashboardPage({ csrf, flash, status, backups, journal, addon }) {
  const { account, profiles, activeProfileId, openJournal } = status;
  const locked = Boolean(openJournal);
  return layout({
    title: 'Profiles',
    account,
    csrf,
    body: html`${flashBlock(flash)}
    ${recoveryBanner(openJournal, csrf)}

    <section class="stack-lg">
      <div class="section-head">
        <h1>Profiles</h1>
        <p class="hint">Switching changes every device on this Stremio account</p>
      </div>
      <div class="grid">
        ${profiles.map((p) => profileCard(p, { active: p.id === activeProfileId, csrf, locked }))}
        <a class="new-tile" href="#new">${icon.plus}New profile</a>
      </div>
      <p class="hint">Finished watching something on another device? Use <em>Save now</em> before switching.</p>
    </section>

    ${addonCard(addon, csrf)}

    <section class="card" id="new">
      <h2>New profile</h2>
      <form method="post" action="/profiles" class="stack">
        ${csrfField(csrf)}
        <label>Name <input name="name" maxlength="40" required></label>
        <fieldset>
          <legend>Start with</legend>
          <label class="radio"><input type="radio" name="from" value="empty" checked> An empty library (same add-ons as now)</label>
          <label class="radio"><input type="radio" name="from" value="current"> A copy of the account as it is now</label>
        </fieldset>
        ${colourPicker('colour', AVATAR_COLOURS[5])}
        <button type="submit" class="primary">Create profile</button>
      </form>
    </section>

    <section class="card">
      <div class="card-head">
        <h2>Backups</h2>
        <form method="post" action="/backups" class="row">
          ${csrfField(csrf)}
          <input name="label" placeholder="Label (optional)" maxlength="80" aria-label="Backup label">
          <button type="submit">Back up now</button>
        </form>
      </div>
      <p class="hint">Taken automatically before every switch and restore. Downloads contain your add-on
        links, which can include debrid keys: keep them private.</p>
      <div class="table-wrap"><table>
        <thead><tr><th>When</th><th>What</th><th>Contents</th><th><span class="sr-only">Actions</span></th></tr></thead>
        <tbody>
          ${backups.map((b) => html`<tr>
            <td>${when(b.created_at)}</td>
            <td>${b.label} <span class="hint">(${KIND_LABELS[b.kind] ?? b.kind}${b.kind === 'original' ? ', kept forever' : ''})</span></td>
            <td class="hint">${counts(b, { notifs: false })}</td>
            <td><div class="actions">
              <a href="/backups/${b.id}/restore">Restore…</a>
              <a href="/backups/${b.id}/download">Download</a>
              ${b.kind === 'original' ? '' : postButton({ action: `/backups/${b.id}/delete`, csrf, label: 'Delete', style: 'link danger', confirm: 'Delete this backup?' })}
            </div></td>
          </tr>`)}
        </tbody>
      </table></div>
    </section>

    <section class="card">
      <h2>Recent activity</h2>
      ${journal.length === 0 ? html`<p class="hint">No switches yet.</p>` : html`<ul class="activity">
        ${journal.map((j) => html`<li>
          <span class="hint">${when(j.started_at)}</span>
          <span>${j.kind === 'switch' ? 'Switch' : 'Restore'}: ${j.status === 'open' ? 'unfinished' : j.status === 'rolled_back' ? 'rolled back' : 'done'}</span>
          ${j.warnings.length ? html`<span class="hint">${j.warnings.join(' ')}</span>` : ''}
        </li>`)}
      </ul>`}
    </section>

    <section class="card">
      <h2>Stremio sign-in</h2>
      <details class="fold">
        <summary>Sign in to Stremio again (if switching says the sign-in expired)</summary>
        ${stremioSignInForm(csrf, { renew: true })}
      </details>
    </section>`,
  });
}

export function restorePreviewPage({ csrf, backup, active, locked, account }) {
  return layout({
    title: 'Restore backup',
    account,
    csrf,
    body: html`<section class="card narrow">
      <h1>Restore this backup?</h1>
      <dl class="compare">
        <dt>Backup</dt><dd>${backup.label}<br><span class="hint">${when(backup.created_at)} · ${counts(backup)}</span></dd>
        <dt>Replaces</dt><dd>${active ? html`${active.name}<br><span class="hint">last saved ${when(active.snapshot_taken_at)} · ${counts(active)}</span>` : 'the current account state'}</dd>
      </dl>
      <p>The Stremio account's library, add-ons and notifications are replaced with the backup's, and
        <strong>${active?.name ?? 'the active profile'}</strong> is saved that way. A backup of the current
        state is taken first, so you can undo this.</p>
      ${locked ? html`<div class="flash flash-error">${icon.alert}<p>Resolve the unfinished switch first.</p></div>` : ''}
      <div class="row">
        ${locked ? '' : postButton({ action: `/backups/${backup.id}/restore`, csrf, label: 'Restore', style: 'primary' })}
        <a class="button" href="/configure">Cancel</a>
      </div>
    </section>`,
  });
}

export function errorPage({ status, message }) {
  return layout({
    title: status === 404 ? 'Not found' : 'Error',
    body: html`<section class="card narrow"><h1>${status === 404 ? 'Not found' : 'Something went wrong'}</h1>
      <p>${message}</p><p><a href="/configure">Back to OpenProfiles</a></p></section>`,
  });
}
