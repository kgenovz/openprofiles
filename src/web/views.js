import { AVATAR_COLOURS } from '../core/service.js';
import { html } from './html.js';

const KIND_LABELS = {
  original: 'Setup',
  auto: 'Automatic',
  pre_switch: 'Before a switch',
  pre_restore: 'Before a restore',
  manual: 'Manual',
  imported: 'Imported',
};

const dateFmt = new Intl.DateTimeFormat('en-CA', { dateStyle: 'medium', timeStyle: 'short' });
const when = (ms) => (ms ? dateFmt.format(new Date(ms)) : 'never');
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function counts(row) {
  const notifs = row.notif_count == null ? 'notifications not saved' : plural(row.notif_count, 'notification');
  return `${plural(row.library_count, 'title')} · ${plural(row.addon_count, 'add-on')} · ${notifs}`;
}

const csrfField = (csrf) => html`<input type="hidden" name="_csrf" value="${csrf}">`;

function postButton({ action, csrf, label, style = '', confirm, disabled = false }) {
  return html`<form method="post" action="${action}" class="inline" ${confirm ? html`data-confirm="${confirm}"` : ''}>
    ${csrfField(csrf)}
    <button type="submit" class="${style}" ${disabled ? 'disabled' : ''}>${label}</button>
  </form>`;
}

function avatar(profile, size = 'lg') {
  const initial = [...profile.name][0]?.toUpperCase() || '?';
  return html`<span class="avatar avatar-${size}" style="background:${profile.avatar_colour}" aria-hidden="true">${initial}</span>`;
}

function colourPicker(name, selected) {
  return html`<fieldset class="swatches"><legend>Colour</legend>
    ${AVATAR_COLOURS.map((c) => html`<label class="swatch" style="--c:${c}">
      <input type="radio" name="${name}" value="${c}" ${c === selected ? 'checked' : ''}><span></span>
      <span class="sr-only">${c}</span></label>`)}
  </fieldset>`;
}

export function layout({ title, body, signedIn = false, csrf }) {
  return html`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>${title} · OpenProfiles</title>
  <link rel="stylesheet" href="/static/app.css">
  <script src="/static/app.js" defer></script>
</head>
<body>
  <header class="top">
    <span class="brand">OpenProfiles</span>
    ${signedIn ? postButton({ action: '/logout', csrf, label: 'Sign out', style: 'link' }) : ''}
  </header>
  <main>${body}</main>
</body>
</html>`;
}

function flashBlock(flash) {
  if (!flash) return '';
  return html`<div class="flash flash-${flash.type}" role="status">
    <p>${flash.text}</p>
    ${flash.details?.length ? html`<ul>${flash.details.map((d) => html`<li>${d}</li>`)}</ul>` : ''}
  </div>`;
}

export function loginPage({ error }) {
  return layout({
    title: 'Sign in',
    body: html`<section class="card narrow">
      <h1>Sign in</h1>
      ${error ? html`<p class="flash flash-error">${error}</p>` : ''}
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
    signedIn: true,
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
    <div class="profile-head">
      ${avatar(p)}
      <div>
        <h3>${p.name} ${active ? html`<span class="badge">In use</span>` : ''}</h3>
        <p class="hint">${counts(p)}</p>
        <p class="hint">Saved ${when(p.snapshot_taken_at)}</p>
      </div>
    </div>
    <div class="row">
      ${active
        ? postButton({ action: `/profiles/${p.id}/save`, csrf, label: 'Save now' })
        : postButton({ action: `/profiles/${p.id}/switch`, csrf, label: `Switch to ${p.name}`, style: 'primary', disabled: locked })}
    </div>
    <details>
      <summary>Edit</summary>
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
      ${active ? '' : postButton({ action: `/profiles/${p.id}/delete`, csrf, label: 'Delete profile', style: 'danger', confirm: `Delete "${p.name}"? Its saved library, add-ons and notifications are gone for good.` })}
    </details>
  </article>`;
}

export function dashboardPage({ csrf, flash, status, backups, journal }) {
  const { account, profiles, activeProfileId, openJournal } = status;
  const locked = Boolean(openJournal);
  return layout({
    title: 'Profiles',
    signedIn: true,
    csrf,
    body: html`${flashBlock(flash)}
    ${recoveryBanner(openJournal, csrf)}

    <section>
      <div class="section-head">
        <h1>Profiles</h1>
        <p class="hint">Stremio account: ${account.email}</p>
      </div>
      <p class="hint">Switching rewrites the library and add-ons on every device signed in to this
        account. Afterwards, close and reopen Stremio to see the change. Finished watching something on
        another device? Use <em>Save now</em> before switching.</p>
      <div class="grid">
        ${profiles.map((p) => profileCard(p, { active: p.id === activeProfileId, csrf, locked }))}
      </div>
    </section>

    <section class="card">
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
      <h2>Backups</h2>
      <p class="hint">Taken automatically before every switch and restore. Downloads contain your add-on
        links, which can include debrid keys: keep them private.</p>
      <form method="post" action="/backups" class="row">
        ${csrfField(csrf)}
        <input name="label" placeholder="Label (optional)" maxlength="80">
        <button type="submit">Back up now</button>
      </form>
      <div class="table-wrap"><table>
        <thead><tr><th>When</th><th>Type</th><th>Label</th><th>Contents</th><th></th></tr></thead>
        <tbody>
          ${backups.map((b) => html`<tr>
            <td>${when(b.created_at)}</td>
            <td>${KIND_LABELS[b.kind] ?? b.kind}</td>
            <td>${b.label}</td>
            <td class="hint">${counts(b)}</td>
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
          <span>${when(j.started_at)}</span>
          <span>${j.kind === 'switch' ? 'Switch' : 'Restore'}: ${j.status === 'open' ? 'unfinished' : j.status === 'rolled_back' ? 'rolled back' : 'done'}</span>
          ${j.warnings.length ? html`<span class="hint">${j.warnings.join(' ')}</span>` : ''}
        </li>`)}
      </ul>`}
    </section>

    <section class="card">
      <h2>Stremio sign-in</h2>
      <details>
        <summary>Sign in to Stremio again (if switching says the sign-in expired)</summary>
        ${stremioSignInForm(csrf, { renew: true })}
      </details>
    </section>`,
  });
}

export function restorePreviewPage({ csrf, backup, active, locked }) {
  return layout({
    title: 'Restore backup',
    signedIn: true,
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
      ${locked ? html`<p class="flash flash-error">Resolve the unfinished switch first.</p>` : ''}
      <div class="row">
        ${locked ? '' : postButton({ action: `/backups/${backup.id}/restore`, csrf, label: 'Restore', style: 'primary' })}
        <a href="/configure">Cancel</a>
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
