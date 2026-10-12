import crypto from 'node:crypto';
import fs from 'node:fs';
import { CHARACTERS, GENERATED_STYLES, avatarLabel, parseAvatar, randomSeed } from '../addon/avatars.js';
import { addonDetail } from '../core/addons.js';
import { STOCK_SETTINGS, describeSettings } from '../core/cinemeta.js';
import { ACCENT_COLOURS, DEFAULT_HEADLINE, DEFAULT_INTRO } from '../core/settings.js';
import { AVATAR_COLOURS, BIN_DAYS, DEFAULT_COLOUR, MAX_PROFILES } from '../core/service.js';
import { html } from './html.js';
import { buttonColours } from './theme.js';

// Static files are cached for an hour; a content hash in their URLs makes updates show at once.
const ASSET_VERSION = crypto.createHash('sha1')
  .update(fs.readFileSync(new URL('./static/app.css', import.meta.url)))
  .update(fs.readFileSync(new URL('./static/app.js', import.meta.url)))
  .digest('hex').slice(0, 10);

// Layout follows the Phase 2 boards of the design canvas: SignIn, Wizard,
// Profiles, AddonsCinemeta and Account.

const TABS = [
  ['profiles', 'Profiles', '/configure'],
  ['backups', 'Backups', '/backups'],
  ['install', 'Install in Stremio', '/install'],
  ['account', 'Account', '/account'],
];
// Only whoever runs the server sees this one.
const ADMIN_TAB = ['server', 'Server', '/admin'];

/** How the pages present the server when nothing was customised (Settings.branding() plus who's looking). */
export const DEFAULT_SITE = {
  name: 'OpenProfiles', accent: null, appearance: 'auto', customLogo: false, logoVersion: null, themeVersion: null,
  headline: DEFAULT_HEADLINE, intro: DEFAULT_INTRO, selfHostLinks: true, announcement: null, contact: null,
  operator: null, privacyNote: null, shared: false, admin: false, removeUnusedDays: 0,
};

/** A contact the owner gave: an https link or an email address. */
const contactHref = (contact) => (contact.startsWith('https://') ? contact : `mailto:${contact}`);

const BACKUP_GROUPS = [
  { title: 'Automatic', keep: 'daily, the last 14 kept', kinds: ['auto'] },
  { title: 'Before changes', keep: 'switches, restores and edits', kinds: ['pre_switch', 'pre_restore', 'pre_change'] },
  { title: 'Made by you', keep: 'the last 10 kept', kinds: ['manual'] },
  { title: 'Imported', keep: 'the last 10 kept', kinds: ['imported'] },
  { title: 'Setup', keep: 'kept forever', kinds: ['original'] },
];

const REPO_URL = 'https://github.com/kgenovz/openprofiles';

const NO_CINEMETA_EFFECT =
  "Stremio's Calendar and new-episode notifications only come from Cinemeta, so they won't work without it.";

const COLOUR_NAMES =['Red', 'Orange', 'Amber', 'Green', 'Teal', 'Blue', 'Purple', 'Pink'];

const CINEMETA_SWITCHES = [
  ['popular', 'hidePopular', 'Popular', 'Popular movies and series, on Home and in Discover'],
  ['new', 'hideNew', 'New', 'New releases by year, in Discover'],
  ['featured', 'hideFeatured', 'Featured', 'Top-rated picks, on Home and in Discover'],
  ['search', 'removeSearch', 'Search with Cinemeta', 'Titles from Cinemeta show up in search'],
  ['meta', 'removeMeta', 'Details pages', 'Descriptions, cast and episode lists'],
];

const dateFmt = new Intl.DateTimeFormat('en-CA', { dateStyle: 'medium', timeStyle: 'short' });
const when = (ms) => (ms ? dateFmt.format(new Date(ms)) : 'never');
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "just now", "5 min ago", "3 hours ago", then the date. */
function ago(ms, now = Date.now()) {
  if (!ms) return 'never';
  const minutes = Math.round((now - ms) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${plural(hours, 'hour')} ago`;
  return when(ms);
}

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

const pictureVersion = (p) => crypto.createHash('sha1').update(`${p.name}|${p.avatar_colour}|${p.avatar_preset}`).digest('hex').slice(0, 8);
const avatarUrl = (p) => `/avatars/profile/${p.id}.svg?v=${pictureVersion(p)}`;

function previewSrc(avatar, p) {
  return `/avatars/preview.svg?${new URLSearchParams({ avatar, colour: p.avatar_colour, name: p.name })}`;
}

/**
 * Picture choices in tabs (Letter / Characters / Faces, and Photo for a
 * profile that exists). Without JavaScript the groups simply show; app.js
 * turns them into tabs and wires Shuffle, the live colour preview and the
 * photo upload.
 */
function picturePicker(p, { photo = false, csrf = null } = {}) {
  const current = parseAvatar(p.avatar_preset) ?? { kind: 'initial' };
  const option = (value, label, src = null) => html`<label class="pic">
    <input type="radio" name="picture" value="${value}" ${value === p.avatar_preset ? 'checked' : ''}>
    ${src
      ? html`<img src="${src}" alt="" width="64" height="64" loading="lazy">`
      : html`<img src="${previewSrc(value, p)}" alt="" width="64" height="64" data-avatar="${value}" loading="lazy">`}
    <span class="sr-only">${label}</span>
  </label>`;
  const generated = Object.entries(GENERATED_STYLES).flatMap(([id, s]) => [1, 2].map(() => ({ value: `gen:${id}:${randomSeed()}`, label: `${s.label} face` })));
  if (current.kind === 'gen') generated.unshift({ value: p.avatar_preset, label: avatarLabel(p.avatar_preset) });
  const tab = { gen: 'gen', char: 'char', photo: photo ? 'photo' : 'letter' }[current.kind] ?? 'letter';
  return html`<fieldset class="picker" data-tab="${tab}">
    <legend>Picture</legend>
    <div class="picker-tabs" role="tablist" hidden>
      <button type="button" role="tab" data-tab-for="letter">Letter</button>
      <button type="button" role="tab" data-tab-for="char">Characters</button>
      <button type="button" role="tab" data-tab-for="gen">Faces</button>
      ${photo ? html`<button type="button" role="tab" data-tab-for="photo">Photo</button>` : ''}
    </div>
    <div class="pic-grid" data-tab-panel="letter">${option('initial', 'Letter')}</div>
    <div class="pic-grid" data-tab-panel="char">${Object.entries(CHARACTERS).map(([id, c]) => option(`char:${id}`, c.label))}</div>
    <div class="pic-grid" data-tab-panel="gen">${generated.map((g) => option(g.value, g.label))}</div>
    ${photo ? photoPanel(p, csrf, option) : ''}
    <button type="button" class="shuffle" data-shuffle hidden>Shuffle faces</button>
  </fieldset>`;
}

/** The Photo tab: this profile's one uploaded photo, and uploading or removing it. */
function photoPanel(p, csrf, option) {
  const has = Boolean(p.photo_hash);
  return html`<div class="pic-grid photo-panel" data-tab-panel="photo">
    ${has ? option(`photo:${p.photo_hash}`, 'Photo', `/avatars/profile/${p.id}/photo.jpg?v=${p.photo_hash}`) : ''}
    <div class="stack-sm">
      <label class="button" data-photo-upload hidden>${has ? 'Upload another photo' : 'Upload a photo'}
        <input type="file" accept="image/png,image/jpeg,image/webp" class="sr-only" data-photo-file data-url="/profiles/${p.id}/photo" data-csrf="${csrf}"></label>
      ${has ? html`<button type="submit" class="link small" formaction="/profiles/${p.id}/photo/remove" formnovalidate>Remove the photo</button>` : ''}
      <span class="hint" role="status" data-photo-status>${has ? '' : 'One photo per profile. It fills the whole tile in Stremio.'}</span>
      <noscript><span class="hint">Uploading needs JavaScript turned on.</span></noscript>
    </div>
  </div>`;
}

const icon = {
  logo: html`<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.2"/><path d="M3.5 19c.8-3 3-4.6 5.5-4.6s4.7 1.6 5.5 4.6"/><path d="M16 5.5a3 3 0 0 1 0 5.6M18 14.6c1.3.6 2.2 2 2.6 4.4"/></svg>`,
  check: html`<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`,
  alert: html`<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5h.01"/></svg>`,
  lock: html`<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="inline-icon"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>`,
  plus: html`<svg aria-hidden="true" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>`,
  shield: html`<svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z"/><path d="M8.5 12l2.5 2.5 4.5-5"/></svg>`,
  grip: html`<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>`,
  up: html`<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M6 11l6-6 6 6"/></svg>`,
  down: html`<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M6 13l6 6 6-6"/></svg>`,
  megaphone: html`<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 10v4h3l5 4V6L7 10z"/><path d="M16 9.5a3.5 3.5 0 0 1 0 5"/></svg>`,
  back: html`<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6l-6 6 6 6"/></svg>`,
};

function colourPicker(name, selected) {
  return html`<fieldset class="swatches"><legend>Colour</legend>
    ${AVATAR_COLOURS.map((c, i) => html`<label class="swatch" style="--c:${c}">
      <input type="radio" name="${name}" value="${c}" ${c === selected ? 'checked' : ''}><span></span>
      <span class="sr-only">${COLOUR_NAMES[i]}</span></label>`)}
  </fieldset>`;
}

/**
 * `tab` highlights a section of the signed-in navigation; without `csrf` the header is bare (sign-in, errors).
 * `site`: the server's name, colours, logo and notices from the Server tab, and whether the viewer runs it.
 */
export function layout({ title, body, account, csrf, tab = null, wide = false, site = DEFAULT_SITE }) {
  const logo = `/logo.png${site.logoVersion ? `?v=${site.logoVersion}` : ''}`;
  const tabs = site.admin ? [...TABS, ADMIN_TAB] : TABS;
  return html`<!doctype html>
<html lang="en" ${site.appearance === 'light' || site.appearance === 'dark' ? html`data-theme="${site.appearance}"` : ''}>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="same-origin">
  <title>${title} · ${site.name}</title>
  <link rel="icon" href="${logo}">
  <link rel="stylesheet" href="/fonts/400.css">
  <link rel="stylesheet" href="/fonts/600.css">
  <link rel="stylesheet" href="/fonts/800.css">
  <link rel="stylesheet" href="/static/app.css?v=${ASSET_VERSION}">
  ${site.accent ? html`<link rel="stylesheet" href="/theme.css?v=${site.themeVersion ?? ''}">` : ''}
  <script src="/static/app.js?v=${ASSET_VERSION}" defer></script>
</head>
<body>
  <header class="top">
    <div class="top-inner">
      <div class="top-row">
        <a class="brand" href="/configure">${site.customLogo
          ? html`<img class="brand-logo" src="${logo}" alt="" width="30" height="30">`
          : html`<span class="brand-mark">${icon.logo}</span>`}${site.name}</a>
        ${csrf ? html`<div class="top-right">
          ${account ? html`<span class="hint top-email">${account.email}</span>` : ''}
          ${postButton({ action: '/logout', csrf, label: 'Sign out', style: 'link' })}
        </div>` : ''}
      </div>
      ${csrf && tab ? html`<nav class="tabs" aria-label="Sections">
        ${tabs.map(([id, label, href]) => html`<a href="${href}" ${id === tab ? html`aria-current="page"` : ''}>${label}</a>`)}
      </nav>` : ''}
    </div>
  </header>
  ${site.announcement ? html`<div class="announcement" role="status"><div class="announcement-inner">${icon.megaphone}<p>${site.announcement}</p></div></div>` : ''}
  <main class="${wide ? 'wide' : ''}">${body}</main>
  <footer class="foot"><a href="/privacy">What this server keeps</a>${site.contact ? html` · <a href="${contactHref(site.contact)}" rel="noopener">Contact</a>` : ''}${site.selfHostLinks ? html` · <a href="${REPO_URL}" rel="noopener">OpenProfiles on GitHub</a>` : ''}</footer>
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

/** The last add-on or Cinemeta edit, undoable for 24 hours. */
function undoBanner(undo, csrf) {
  if (!undo) return '';
  const what = undo.edit_kind === 'cinemeta' ? 'Cinemeta' : 'add-ons';
  return html`<div class="undo" role="status">
    <span>Changed ${undo.profile_name}'s ${what} ${ago(undo.created_at)}. A backup was taken first.</span>
    <span class="row">
      ${postButton({ action: `/edits/${undo.id}/undo`, csrf, label: 'Undo', style: 'undo-button' })}
      <form method="post" action="/edits/${undo.id}/hide" class="inline" data-undo-hide>
        ${csrfField(csrf)}
        <button type="submit" class="undo-button undo-hide" aria-label="Hide this bar">Hide</button>
      </form>
    </span>
  </div>`;
}

/** From the "Sign in with Stremio" board of the Phase 2 design. */
/** `site.shared`: anyone (or a list) can sign in here, so say who runs it and what it keeps. */
export function signInPage({ site = DEFAULT_SITE, error, notice, email = '', again = false } = {}) {
  const steps = [
    html`Sign in with Stremio. Your account as it is now becomes your <strong>Original</strong> profile, and a permanent backup of it is kept.`,
    html`Make more profiles: a name and picture, the add-ons each one should have.`,
    html`Install the add-on once. Every profile shows up on Stremio's Home; open one to switch.`,
  ];
  return layout({
    site,
    title: 'Sign in',
    body: html`<div class="signin">
      <section class="signin-pitch">
        <h1>${site.headline}</h1>
        <p class="lede">${site.intro}</p>
        <ol class="steps">${steps.map((s, i) => html`<li><span class="step-n">${i + 1}</span><span>${s}</span></li>`)}</ol>
      </section>
      <section class="card signin-card">
        <h2>${again ? 'Sign in to Stremio again' : 'Sign in with Stremio'}</h2>
        ${again ? html`<p class="hint">Stremio signed ${site.name} out. Sign in again; your profiles are all still here.</p>` : ''}
        ${notice ? html`<div class="flash flash-ok">${icon.check}<p>${notice}</p></div>` : ''}
        ${error ? html`<div class="flash flash-error" role="alert">${icon.alert}<p>${error}</p></div>` : ''}
        <form method="post" action="/signin" class="stack">
          <label>Stremio email <input type="email" name="email" value="${email}" autocomplete="username" required ${email ? '' : 'autofocus'}></label>
          <label>Stremio password <input type="password" name="password" autocomplete="current-password" required ${email ? 'autofocus' : ''}></label>
          <button type="submit" class="primary">Sign in</button>
        </form>
        <p class="hint">${icon.lock} Your password goes to Stremio once to get a sign-in key, and is never stored. ${site.name} only changes your own account.</p>
        ${site.shared ? html`<div class="shared-note">
          <p><strong>A shared server${site.operator ? html`, run by ${site.operator}` : ''}.</strong>
            It keeps your profiles, backups and Stremio sign-in key, encrypted. No tracking, and no logs of your email, IP address or add-on links.
            <a href="/privacy">What it keeps</a></p>
          ${site.selfHostLinks ? html`<p>Rather keep it to yourself? OpenProfiles is free and very light to run: <a href="${REPO_URL}" rel="noopener">host your own</a>.</p>` : ''}
        </div>` : ''}
        <p class="hint fold-top">Have Stremio Supporter? It has built-in profiles that work on several devices at once; use those instead.</p>
      </section>
    </div>`,
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

// ── Profiles tab ─────────────────────────────────────────────────────────────

function profileCard(p, { active, csrf, locked, editing }) {
  return html`<article class="profile ${active ? 'is-active' : ''} ${editing ? 'is-editing' : ''}">
    <div class="profile-banner" style="background:${p.avatar_colour}">
      <img src="${avatarUrl(p)}" alt="" width="256" height="256">
      ${active ? html`<span class="pill">In use</span>` : ''}
    </div>
    <div class="profile-body">
      <div>
        <h3>${p.name}</h3>
        <p class="hint">${counts(p, { notifs: false })}</p>
      </div>
      <div class="profile-actions">
        ${active
          ? postButton({ action: `/profiles/${p.id}/save`, csrf, label: html`Save now<span class="sr-only"> ${p.name}</span>`, style: 'grow', disabled: locked })
          : postButton({ action: `/profiles/${p.id}/switch`, csrf, label: html`Switch<span class="sr-only"> to ${p.name}</span>`, style: 'primary grow', disabled: locked })}
        ${editing
          ? html`<a class="button is-current" href="/configure" aria-expanded="true">Close<span class="sr-only"> ${p.name}'s editor</span></a>`
          : html`<a class="button" href="/profiles/${p.id}#edit">Edit<span class="sr-only"> ${p.name}</span></a>`}
      </div>
    </div>
  </article>`;
}

/** The first-run checklist: make a profile, install the add-on. */
function getStarted({ profiles, addon }) {
  const firstDone = profiles.length > 1;
  const installed = addon?.installed === true;
  if (firstDone && installed) return '';
  if (firstDone && addon?.installed == null) return '';
  const step = (n, done, title, body, action) => html`<li class="${done ? 'is-done' : ''}">
    <span class="step-n">${done ? icon.check : n}</span>
    <div><h3>${title}</h3><p class="hint">${body}</p></div>
    ${done ? html`<span class="status status-ok">Done</span>` : action}
  </li>`;
  return html`<section class="card get-started">
    <h2>${firstDone ? 'One more step' : 'Get set up'}</h2>
    <ol class="checklist">
      ${step(1, true, 'Your account is saved as "Original"', 'Its library, add-ons and notifications, with a backup kept forever.', '')}
      ${step(2, firstDone, 'Make your first profile', 'Pick a name, a picture and the add-ons it should have. Stremio only changes when you switch to it.',
        html`<a class="button primary" href="/profiles/new">New profile</a>`)}
      ${addon ? step(3, installed, 'Install the switcher in Stremio', 'Adds a "Switch profile" row to Stremio\'s Home, with every profile in it.',
        html`<a class="button ${firstDone ? 'primary' : ''}" href="${addon.installUrl}">Install in Stremio</a>`) : ''}
    </ol>
  </section>`;
}

function profileEditor(d, { csrf, locked }) {
  const p = d.profile;
  const sections = [['basics', 'Basics'], ['picture', 'Picture'], ['addons', 'Add-ons'], ['cinemeta', 'Cinemeta'], ['saved', "What's saved"], ['danger', 'Danger zone']];
  const addonNames = d.addons?.filter((a) => !a.self).map((a) => a.name) ?? [];
  const stat = (label, value) => html`<div><dt>${label}</dt><dd>${value}</dd></div>`;
  return html`<section class="editor" id="edit" aria-label="Editing ${p.name}">
    <nav class="editor-nav" aria-label="${p.name}'s sections">
      <div class="editor-who"><img src="${avatarUrl(p)}" alt="" width="36" height="36"><strong>${p.name}</strong>
        <a class="editor-close" href="/configure" aria-label="Close ${p.name}'s editor">×</a></div>
      ${sections.map(([id, label]) => html`<a href="#${id}">${label}</a>`)}
    </nav>
    <div class="editor-body">
      <div class="editor-section" id="basics">
        <h2>Basics</h2>
        <form method="post" action="/profiles/${p.id}/rename" class="row align-end">
          ${csrfField(csrf)}
          <label class="grow">Name <input name="name" value="${p.name}" maxlength="40" required></label>
          <button type="submit">Rename</button>
        </form>
      </div>

      <div class="editor-section" id="picture">
        <h2>Picture</h2>
        <form method="post" action="/profiles/${p.id}/avatar" class="stack" data-picture-form>
          ${csrfField(csrf)}
          ${picturePicker(p, { photo: true, csrf })}
          ${colourPicker('colour', p.avatar_colour)}
          <button type="submit" class="self-start">Save picture</button>
        </form>
      </div>

      <div class="editor-section" id="addons">
        <div class="section-head"><h2>Add-ons</h2><a href="/profiles/${p.id}/addons">Manage add-ons</a></div>
        <p class="hint">${d.addons ? `${plural(addonNames.length, 'add-on')}${addonNames.length ? `: ${addonNames.join(', ')}` : ''}.` : "Its saved add-ons can't be read."}</p>
      </div>

      <div class="editor-section" id="cinemeta">
        <div class="section-head"><h2>Cinemeta</h2>${d.cinemeta?.present ? html`<a href="/profiles/${p.id}/addons#cinemeta-panel">Change</a>` : ''}</div>
        <p class="hint">${d.cinemeta?.present ? describeSettings(d.cinemeta.settings) : `${p.name} doesn't have Cinemeta, Stremio's built-in catalogs.`}</p>
        ${d.cinemeta && !d.cinemeta.present ? html`<div class="warn">${icon.alert}<span>${NO_CINEMETA_EFFECT}${d.cinemeta.wrapped ? ` ${d.cinemeta.wrappedName} doesn't count: Stremio looks for Cinemeta's own add-on.` : ''} <a href="/profiles/${p.id}/addons#cinemeta-panel">Add it back</a>.</span></div>` : ''}
        ${d.cinemeta?.wrapped ? html`<p class="hint">${p.name} also has ${d.cinemeta.wrappedName}, which shows its own copy of Cinemeta's catalogs.</p>` : ''}
      </div>

      <div class="editor-section" id="saved">
        <h2>What's saved</h2>
        <dl class="stats">
          ${stat('Library', plural(p.library_count, 'title'))}
          ${stat('Continue Watching', d.continueWatching ?? '?')}
          ${stat('Add-ons', p.addon_count)}
          ${stat('Last saved', ago(p.snapshot_taken_at))}
        </dl>
        ${d.active
          ? html`<div class="row">${postButton({ action: `/profiles/${p.id}/save?back=edit`, csrf, label: 'Save now', disabled: locked })}
              <span class="hint">${p.name} is in use, so Stremio holds the newest copy. Save now copies it here; switching away does too.</span></div>`
          : html`<p class="hint">This is what ${p.name} holds while it isn't in use. Switching to it puts it into Stremio.</p>`}
      </div>

      <div class="editor-section danger" id="danger">
        <h2>Danger zone</h2>
        <div class="danger-row">
          <span>Delete ${p.name}. It goes to the bin for ${BIN_DAYS} days, so you can bring it back.</span>
          ${d.active
            ? html`<button type="button" disabled>Switch away first</button>`
            : postButton({ action: `/profiles/${p.id}/delete`, csrf, label: 'Delete profile', style: 'danger', confirm: `Delete "${p.name}"? It stays in the bin for ${BIN_DAYS} days.` })}
        </div>
      </div>
    </div>
  </section>`;
}

export function profilesPage({ site, csrf, flash, status, addon, undo, editing = null }) {
  const { account, profiles, activeProfileId, openJournal } = status;
  const locked = Boolean(openJournal);
  return layout({
    site,
    title: editing ? `Edit ${editing.profile.name}` : 'Profiles',
    account,
    csrf,
    tab: 'profiles',
    body: html`${flashBlock(flash)}
    ${recoveryBanner(openJournal, csrf)}
    ${undoBanner(undo, csrf)}
    ${getStarted({ profiles, addon })}

    <section class="stack-lg">
      <div class="section-head">
        <h1>Profiles</h1>
        <p class="hint">Switching changes every device on this Stremio account</p>
      </div>
      <div class="grid">
        ${profiles.map((p) => profileCard(p, { active: p.id === activeProfileId, csrf, locked, editing: editing?.profile.id === p.id }))}
        ${profiles.length < MAX_PROFILES ? html`<a class="new-tile" href="/profiles/new">${icon.plus}New profile</a>` : ''}
      </div>
      <p class="hint">Finished watching something on another device? Use <em>Save now</em> on the profile in use before switching.</p>
    </section>

    ${editing ? profileEditor(editing, { csrf, locked }) : ''}`,
  });
}

// ── the new-profile wizard ───────────────────────────────────────────────────

const WIZARD_STEPS = ['Name and picture', 'Start from', 'Add-ons', 'Cinemeta', 'Review'];

/** One add-on in the wizard's list. The checkbox's order in the form is the add-on order. */
export function wizardAddonRow(a, { checked = false, locked = false } = {}) {
  const note = a.self ? 'The Switch profile row on Home'
    : a.from?.length ? `In ${a.from.join(', ')}` : addonDetail(a);
  return html`<li class="addon-row" data-ref="${a.ref}" data-name="${a.name}"
      data-serves-meta="${a.servesMeta ? '1' : ''}" data-protected="${a.protected || a.self ? '1' : ''}" data-cinemeta="${a.cinemeta ? '1' : ''}"
      data-wraps-cinemeta="${a.wrapsCinemeta ? '1' : ''}">
    <span class="grip">${icon.grip}</span>
    <input type="checkbox" name="addon" value="${a.ref}" ${checked ? 'checked' : ''} ${locked ? 'data-locked' : ''} aria-label="Include ${a.name}">
    <span class="addon-tile" style="background:${a.colour}" aria-hidden="true">${a.initial}</span>
    <span class="addon-text">
      <span class="addon-title"><span class="addon-name">${a.name}</span>
        <span class="badge" data-lock-badge ${locked ? '' : 'hidden'}>${a.self ? 'Always kept' : "Can't remove"}</span></span>
      <span class="hint">${note}</span>
    </span>
    <button type="button" class="icon-button" data-move="-1" aria-label="Move ${a.name} up">${icon.up}</button>
    <button type="button" class="icon-button" data-move="1" aria-label="Move ${a.name} down">${icon.down}</button>
  </li>`;
}

/**
 * A wrapped copy of Cinemeta (a ratings wrapper, say) shows its own Popular,
 * New and Featured, so rows turned on for the stock Cinemeta appear twice.
 */
function wrapperWarning({ name, profile, hidden, action }) {
  return html`<div class="warn" data-wrapper-warning ${hidden ? 'hidden' : ''}>${icon.alert}<span class="stack-sm">
    <span>${profile} also has <strong data-wrapper-name>${name}</strong>, which shows its own copy of these catalogs. Rows turned on here appear twice.</span>
    ${action}
  </span></div>`;
}

function cinemetaSwitches(prefix, settings) {
  return CINEMETA_SWITCHES.map(([key, setting, title, body]) => html`<label class="switch-row">
    <span><strong>${title}</strong><span class="hint">${body}</span></span>
    <input type="checkbox" role="switch" name="${prefix}${key}" value="1" ${settings[setting] ? '' : 'checked'} data-cm="${key}">
  </label>`);
}

/**
 * Five steps in one form. With JavaScript, app.js shows one step at a time
 * and keeps the add-on ticks and Cinemeta switches in step with "Start from";
 * without it, every step shows and the form still works.
 */
export function wizardPage({ site, csrf, account, options, error = null, values = {} }) {
  const { starts, pool, activeName } = options;
  const from = values.from ?? 'empty';
  const sourceStart = starts.profiles.find((p) => String(p.id) === String(values.source)) ?? null;
  const start = from === 'profile' && sourceStart ? sourceStart : starts.live;
  const ticked = values.addons ?? start.refs;
  const byRef = new Map(pool.map((a) => [a.ref, a]));
  const ordered = [...ticked.filter((r) => byRef.has(r)).map((r) => byRef.get(r)), ...pool.filter((a) => !ticked.includes(a.ref))];
  const lockedRefs = new Set(start.refs.filter((r) => byRef.get(r)?.protected || byRef.get(r)?.self));
  const cm = values.cinemeta ?? start.cinemeta.settings ?? STOCK_SETTINGS;
  const colour = values.colour ?? DEFAULT_COLOUR;
  const picture = values.picture ?? 'initial';
  const name = values.name ?? '';
  const preview = { name: name || '?', avatar_colour: colour, avatar_preset: picture };
  const startData = JSON.stringify({
    live: { refs: starts.live.refs, cinemeta: starts.live.cinemeta.settings },
    profiles: Object.fromEntries(starts.profiles.map((p) => [p.id, { refs: p.refs, cinemeta: p.cinemeta.settings }])),
  });
  const choice = (value, title, body, extra = '') => html`<label class="choice">
    <input type="radio" name="from" value="${value}" ${from === value ? 'checked' : ''}>
    <span class="choice-text"><strong>${title}</strong><span class="hint">${body}</span>${extra}</span>
  </label>`;

  return layout({
    site,
    title: 'New profile',
    account,
    csrf,
    tab: 'profiles',
    body: html`<form method="post" action="/profiles" class="card wizard" data-wizard data-starts="${startData}">
      ${csrfField(csrf)}
      <input type="hidden" name="wizard" value="1">
      <div class="wizard-head">
        <div class="section-head"><h1>New profile</h1><a href="/configure" class="button icon-button" aria-label="Close">×</a></div>
        <ol class="wizard-steps" hidden>
          ${WIZARD_STEPS.map((label, i) => html`<li><button type="button" data-go="${i + 1}"><span class="bar"></span><span>${i + 1}. ${label}</span></button></li>`)}
        </ol>
      </div>
      ${error ? html`<div class="flash flash-error" role="alert">${icon.alert}<p>${error}</p></div>` : ''}

      <section class="wizard-step" data-step="1" aria-label="Name and picture">
        <h2 class="step-title" tabindex="-1">1. Name and picture</h2>
        <label class="name-field">Name <input name="name" value="${name}" maxlength="40" required autocomplete="off" data-wizard-name></label>
        <div class="wizard-picture" data-picture-form>
          <img class="big-preview" src="${previewSrc(picture, preview)}" alt="" width="180" height="180" data-wizard-preview>
          <div class="stack grow">
            ${picturePicker(preview)}
            ${colourPicker('colour', colour)}
          </div>
        </div>
      </section>

      <section class="wizard-step" data-step="2" aria-label="Start from">
        <h2 class="step-title" tabindex="-1">2. Start from</h2>
        <p>What should <span data-name-echo>it</span> start with? You can change everything later.</p>
        <fieldset class="choices">
          <legend class="sr-only">Start from</legend>
          ${choice('empty', 'Empty library', 'No titles and no Continue Watching. You pick the add-ons next.')}
          ${choice('current', 'A copy of the account as it is now', `Same library and add-ons as ${activeName ?? 'the profile in use'}.`)}
          ${starts.profiles.length ? choice('profile', 'A copy of another profile', 'Its saved library and add-ons, then change what you like.',
            html`<select name="source" aria-label="Profile to copy" data-source>
              ${starts.profiles.map((p) => html`<option value="${p.id}" ${String(p.id) === String(values.source) ? 'selected' : ''}>${p.name}</option>`)}
            </select>`) : ''}
        </fieldset>
      </section>

      <section class="wizard-step" data-step="3" aria-label="Add-ons">
        <h2 class="step-title" tabindex="-1">3. Add-ons</h2>
        <p>Tick the add-ons it should have. Top to bottom is the order Stremio uses for catalogs and streams.</p>
        <ul class="addon-list" data-addon-list data-kind="wizard">
          ${ordered.map((a) => wizardAddonRow(a, { checked: ticked.includes(a.ref), locked: lockedRefs.has(a.ref) }))}
        </ul>
        <noscript><p class="hint">Changing the order needs JavaScript. Without it, ticked add-ons keep this order.</p></noscript>
        <div class="add-by-link" data-add-link data-kind="wizard">
          <label class="grow">Add an add-on by its link <input name="addonUrl" placeholder="https://…/manifest.json" autocomplete="off" inputmode="url" data-add-url></label>
          <button type="button" data-add-go hidden>Add</button>
          <p class="hint" role="status" data-add-status></p>
        </div>
      </section>

      <section class="wizard-step" data-step="4" aria-label="Cinemeta">
        <h2 class="step-title" tabindex="-1">4. Cinemeta</h2>
        <p>Cinemeta is Stremio's built-in catalog add-on. Pick which of its catalogs this profile sees on Home and in Discover.</p>
        <div class="warn" data-cm-none ${start.cinemeta.present ? 'hidden' : ''}>${icon.alert}<span>This profile won't have Cinemeta. ${NO_CINEMETA_EFFECT} Tick it in step 3 to keep them.</span></div>
        <div class="switches" data-cm-switches ${start.cinemeta.present ? '' : 'hidden'}>${cinemetaSwitches('cm_', cm)}</div>
        <div class="warn" data-meta-warning hidden>${icon.alert}<span>Details pages are off and none of the ticked add-ons provide them. Titles will open without descriptions or episode lists.</span></div>
        ${wrapperWarning({ name: 'another add-on', profile: 'This profile', hidden: true, action: html`<button type="button" class="link" data-cm-to-wrapper>Turn Cinemeta's own catalogs off and let it show them</button>` })}
      </section>

      <section class="wizard-step" data-step="5" aria-label="Review">
        <h2 class="step-title" tabindex="-1">5. Review</h2>
        <div class="review">
          <img class="big-preview" src="${previewSrc(picture, preview)}" alt="" width="150" height="150" data-wizard-preview>
          <dl class="compare">
            <dt>Name</dt><dd data-review="name">${name || '—'}</dd>
            <dt>Starts with</dt><dd data-review="start">—</dd>
            <dt>Add-ons</dt><dd data-review="addons">—</dd>
            <dt>Cinemeta</dt><dd data-review="cinemeta">—</dd>
          </dl>
        </div>
        <label class="radio"><input type="checkbox" name="switchNow" value="1" ${values.switchNow ? 'checked' : ''}> Switch to it right after creating it</label>
        <p class="hint">Creating it doesn't change Stremio. Your account only changes when you switch to it.</p>
      </section>

      <div class="wizard-foot">
        <button type="button" data-back hidden>Back</button>
        <span class="hint" data-step-count></span>
        <button type="button" class="primary" data-next hidden>Next</button>
        <button type="submit" class="primary" data-create>Create profile</button>
      </div>
    </form>`,
  });
}

// ── add-on manager and Cinemeta ──────────────────────────────────────────────

/** One add-on in the manager. Hidden `ref` inputs carry the order; `remove` ticks drop one. */
export function managerAddonRow(a, { isNew = false } = {}) {
  const locked = a.protected || a.self;
  return html`<li class="addon-row ${isNew ? 'is-new' : ''}" data-ref="${a.ref}" data-name="${a.name}" data-serves-meta="${a.servesMeta ? '1' : ''}">
    <span class="grip">${icon.grip}</span>
    <input type="hidden" name="ref" value="${a.ref}">
    <span class="addon-tile" style="background:${a.colour}" aria-hidden="true">${a.initial}</span>
    <span class="addon-text">
      <span class="addon-title">
        <span class="addon-name">${a.name}</span>
        <span class="health" data-health hidden></span>
        ${locked ? html`<span class="badge">${a.self ? 'Always kept' : 'Protected'}</span>` : ''}
        ${isNew ? html`<span class="badge badge-new">New</span>` : ''}
      </span>
      <span class="hint">${a.self ? 'The Switch profile row on Home' : addonDetail(a)}</span>
      ${a.catalogs.length && !a.self ? html`<details class="catalogs">
        <summary>Rename catalogs</summary>
        <div class="stack">
          ${a.catalogs.map((c) => html`<label>${c.type} · ${c.key.slice(c.type.length + 1)}
            <input name="name:${a.ref}:${c.key}" value="${c.name}" maxlength="60" data-original="${c.name}"></label>`)}
        </div>
      </details>` : ''}
    </span>
    <span class="row-buttons">
      <button type="button" class="icon-button" data-move="-1" aria-label="Move ${a.name} up">${icon.up}</button>
      <button type="button" class="icon-button" data-move="1" aria-label="Move ${a.name} down">${icon.down}</button>
      ${locked ? '' : html`<label class="remove-toggle" title="Remove ${a.name}"><input type="checkbox" name="remove" value="${a.ref}"><span aria-hidden="true">✕</span><span class="sr-only">Remove ${a.name}</span></label>`}
    </span>
  </li>`;
}

/**
 * Where details pages come from, and a way to pick another source. Stremio
 * takes them from the first add-on in the list that gives them, so the pick
 * moves to the top (and Cinemeta's own details go off unless it's the pick).
 */
function metadataCard(p, metadata, { csrf, base }) {
  return html`<form method="post" action="/profiles/${p.id}/metadata" class="card" id="metadata" data-metadata-form aria-label="${p.name}'s metadata">
    ${csrfField(csrf)}
    <input type="hidden" name="base" value="${base}">
    <h2>${p.name} · Metadata</h2>
    <p class="hint">${metadata.currentName
      ? html`Details pages (descriptions, cast, episode lists) come from <strong>${metadata.currentName}</strong>${metadata.currentOwnIds ? ', for titles with its own ids' : ''}.`
      : `No add-on of ${p.name} gives details pages for movies and series, so titles open without them.`}</p>
    ${metadata.options.length > 1 || (metadata.options.length === 1 && !metadata.current) ? html`<div class="add-by-link">
      <label class="grow">Get details pages from
        <select name="source" data-current="${metadata.current ?? ''}">
          ${metadata.options.map((o) => html`<option value="${o.ref}" ${o.ref === metadata.current ? 'selected' : ''} ${o.ownIds ? 'data-own-ids' : ''}>${o.name}${o.ownIds ? ' (its own ids)' : ''}</option>`)}
        </select></label>
      <button type="submit" data-metadata-go>Change</button>
    </div>
    <p class="hint" data-meta-pick-hint hidden>It moves to the top of the list, and Cinemeta's own details pages turn off (back on if it's Cinemeta).</p>
    <p class="hint" data-own-ids-hint hidden>It only covers titles with its own ids (e.g. TMDB ids). Pick it if this profile runs on those alone.</p>` : ''}
  </form>`;
}

export function addonManagerPage({ site, csrf, account, flash, manager, undo }) {
  const { profile: p, active, base, addons, pool, cinemeta } = manager;
  return layout({
    site,
    title: `${p.name}'s add-ons`,
    account,
    csrf,
    tab: 'profiles',
    wide: true,
    body: html`<a class="back-link" href="/profiles/${p.id}#edit">${icon.back}Back to ${p.name}</a>
    ${flashBlock(flash)}
    ${undoBanner(undo, csrf)}
    <div class="manager">
      <form method="post" action="/profiles/${p.id}/addons" class="card" data-addon-form aria-label="${p.name}'s add-ons">
        ${csrfField(csrf)}
        <input type="hidden" name="base" value="${base}">
        <div class="card-head">
          <h1 class="h2">${p.name} · Add-ons</h1>
          <button type="button" data-health-check="/profiles/${p.id}/addons/health" hidden>Check they're working</button>
        </div>
        <p class="hint">Top to bottom is the order Stremio uses. ${active ? 'Saving updates Stremio right away.' : `Stremio gets these when you switch to ${p.name}.`}</p>
        <ul class="addon-list" data-addon-list data-kind="manager">${addons.map((a) => managerAddonRow(a))}</ul>
        <noscript><p class="hint">Changing the order needs JavaScript; removing and adding work without it.</p></noscript>

        <div class="add-grid">
          <div class="add-by-link" data-add-link data-kind="manager">
            <label class="grow">Add by link <input name="addUrl" placeholder="https://…/manifest.json" autocomplete="off" inputmode="url" data-add-url></label>
            <button type="button" data-add-go hidden>Add</button>
            <p class="hint" role="status" data-add-status></p>
          </div>
          ${pool.length ? html`<div class="add-by-link" data-add-pool>
            <label class="grow">From your other profiles
              <select name="addRef" data-pool-select>
                <option value="">Choose an add-on…</option>
                ${pool.map((a) => html`<option value="${a.ref}">${a.name} (${a.from.join(', ')})</option>`)}
              </select></label>
            <button type="button" data-pool-go hidden>Add</button>
          </div>` : ''}
        </div>
        ${pool.map((a) => html`<template data-pool-item="${a.ref}">${managerAddonRow(a, { isNew: true })}</template>`)}

        <div class="savebar" data-savebar>
          <span data-changes>Changes are saved when you press Save.</span>
          <span class="row">
            <a class="button" href="/profiles/${p.id}/addons" data-discard hidden>Discard</a>
            <button type="submit" class="primary">Save</button>
          </span>
        </div>
      </form>

      <div class="side-panels">
      ${metadataCard(p, manager.metadata, { csrf, base })}
      <form method="post" action="/profiles/${p.id}/cinemeta" class="card cinemeta-panel" id="cinemeta-panel" data-cinemeta-form
          data-other-meta="${cinemeta.otherMeta ? '1' : ''}" aria-label="${p.name}'s Cinemeta">
        ${csrfField(csrf)}
        <input type="hidden" name="base" value="${base}">
        <h2>${p.name} · Cinemeta</h2>
        ${cinemeta.present ? html`
          <div class="switches">${cinemetaSwitches('', cinemeta.settings)}</div>
          <div class="warn" data-meta-warning ${cinemeta.settings.removeMeta && !cinemeta.otherMeta ? '' : 'hidden'}>${icon.alert}<span>Details pages are off and no other add-on of ${p.name} gives them for IMDb-id titles, so those will open without descriptions or episode lists. Fine if ${p.name} only uses another add-on's ids (e.g. TMDB ids).</span></div>
          ${cinemeta.wrapped ? wrapperWarning({
            name: cinemeta.wrappedName,
            profile: p.name,
            hidden: cinemeta.settings.hidePopular && cinemeta.settings.hideNew && cinemeta.settings.hideFeatured,
            action: html`<button type="submit" name="handoff" value="${cinemeta.wrappedRef}" class="link">Let ${cinemeta.wrappedName} show them instead</button>`,
          }) : ''}
          <p class="hint" data-cm-calendar ${Object.values(cinemeta.settings).some(Boolean) ? '' : 'hidden'}>Its Calendar and new-episode catalogs always stay on.</p>
          <div class="row spread">
            <button type="submit" formaction="/profiles/${p.id}/cinemeta/reset" data-confirm-click="Put Cinemeta back exactly as Stremio ships it?">Reset to Stremio's default</button>
            <button type="submit" class="primary">Save</button>
          </div>`
        : html`<p class="hint">${p.name} doesn't have Cinemeta${cinemeta.wrapped ? ' (only a copy wrapped by another add-on, which these settings can\'t change)' : ''}.</p>
          <div class="warn">${icon.alert}<span class="stack-sm"><span>${NO_CINEMETA_EFFECT}${cinemeta.wrapped ? ` ${cinemeta.wrappedName} doesn't count: Stremio looks for Cinemeta's own add-on.` : ''}</span>
            <button type="submit" formaction="/profiles/${p.id}/cinemeta/add" class="link">Add Cinemeta</button></span></div>`}
      </form>
      </div>
    </div>`,
  });
}

// ── Backups tab ──────────────────────────────────────────────────────────────

/** Two steps: app.js uploads the file for a summary, then this form confirms it. */
function importCard(csrf) {
  return html`<section class="card" id="import">
    <h2>Import from StremShare</h2>
    <p class="lede">In StremShare, open Tools › Backup &amp; restore and download a backup, then choose
      it here. It's kept as a backup and, if you like, added as a new profile. Nothing changes in
      Stremio until you switch to that profile or restore the backup.</p>
    <label>Backup file <input type="file" accept=".json,application/json" data-import-file data-csrf="${csrf}"></label>
    <p class="hint" data-import-status role="status"></p>
    <form method="post" action="/import/confirm" class="stack" data-import-confirm hidden>
      ${csrfField(csrf)}
      <input type="hidden" name="id">
      <p data-import-summary></p>
      <fieldset>
        <legend>Save it as</legend>
        <label class="radio"><input type="radio" name="as" value="profile" checked> A new profile (plus a backup)</label>
        <label class="radio"><input type="radio" name="as" value="backup"> Only a backup</label>
      </fieldset>
      <label>Profile name <input name="name" maxlength="40"></label>
      <label class="radio" data-import-other hidden><input type="checkbox" name="acceptOtherAccount" value="1">
        <span data-import-other-text></span></label>
      <button type="submit" class="primary">Import</button>
    </form>
    <noscript><p class="hint">Importing needs JavaScript turned on.</p></noscript>
  </section>`;
}

/** Download everything / bring it back. The import runs through app.js (it uploads the file as JSON). */
function everythingCard(csrf) {
  return html`<section class="card" id="everything">
    <h2>Everything in one file</h2>
    <p class="lede">Every profile and backup of your account, to keep somewhere safe or to move to another
      OpenProfiles server. Add a passphrase to lock the file; without it, anyone with the file can read your
      add-on links and watch history.</p>
    <form method="post" action="/export" class="row align-end" data-no-busy>
      ${csrfField(csrf)}
      <label class="grow">Passphrase (optional) <input type="password" name="passphrase" autocomplete="new-password" minlength="8"></label>
      <button type="submit">Download everything</button>
    </form>
    <details class="fold">
      <summary>Bring back from a file</summary>
      <p class="hint">Adds the file's profiles (renamed if a name is taken) and keeps its backups. Nothing in Stremio changes.</p>
      <div class="stack" data-everything data-csrf="${csrf}">
        <label>Export file <input type="file" accept=".json,application/json" data-everything-file></label>
        <label>Passphrase (if the file has one) <input type="password" data-everything-pass autocomplete="off"></label>
        <label class="radio"><input type="checkbox" data-everything-other> It's from a different Stremio account, and I want it here anyway</label>
        <button type="button" class="primary" data-everything-go>Bring back</button>
        <p class="hint" role="status" data-everything-status></p>
      </div>
    </details>
  </section>`;
}

export function backupsPage({ site, csrf, account, flash, backups, bin = [], undo }) {
  const latest = backups[0];
  return layout({
    site,
    title: 'Backups',
    account,
    csrf,
    tab: 'backups',
    body: html`${flashBlock(flash)}
    ${undoBanner(undo, csrf)}
    <section class="card covered">
      <div class="covered-head">
        <span class="covered-icon">${icon.shield}</span>
        <div>
          <h1 class="h2">You're covered</h1>
          <p class="hint">Backed up automatically every day, and before every switch, restore and edit.
            ${latest ? `Last backup: ${ago(latest.created_at)}` : ''}</p>
        </div>
      </div>
      <form method="post" action="/backups" class="row">
        ${csrfField(csrf)}
        <input name="label" placeholder="Label (optional)" maxlength="80" aria-label="Backup label">
        <button type="submit" class="primary">Back up now</button>
        <a class="button" href="#everything">Download everything</a>
      </form>
      <p class="hint">Downloads contain your add-on links, which can include debrid keys: keep them private.</p>
    </section>

    <section class="card backup-groups">
      ${BACKUP_GROUPS.map((g) => {
        const items = backups.filter((b) => g.kinds.includes(b.kind));
        if (!items.length) return '';
        return html`<div class="backup-group">
          <h2 class="h3">${g.title} <span class="hint">· ${g.keep}</span></h2>
          <ul class="list">
            ${items.map((b) => html`<li>
              <span class="list-main"><strong>${b.label}</strong><span class="hint">${when(b.created_at)} · ${counts(b, { notifs: false })}</span></span>
              <span class="actions">
                <a href="/backups/${b.id}/restore">Restore…<span class="sr-only"> ${b.label}</span></a>
                <a href="/backups/${b.id}/download">Download<span class="sr-only"> ${b.label}</span></a>
                ${b.kind === 'original' ? '' : postButton({ action: `/backups/${b.id}/delete`, csrf, label: html`Delete<span class="sr-only"> ${b.label}</span>`, style: 'link danger', confirm: 'Delete this backup?' })}
              </span>
            </li>`)}
          </ul>
        </div>`;
      })}
    </section>

    <section class="card" id="bin">
      <h2 class="h3">Bin <span class="hint">· deleted profiles, kept ${BIN_DAYS} days</span></h2>
      ${bin.length ? html`<ul class="list">
        ${bin.map((p) => html`<li>
          <span class="list-main"><strong>${p.name}</strong><span class="hint">deleted ${when(p.deleted_at)}, gone for good ${when(p.purgeAt)}</span></span>
          ${postButton({ action: `/bin/${p.id}/restore`, csrf, label: html`Bring back<span class="sr-only"> ${p.name}</span>` })}
        </li>`)}
      </ul>` : html`<p class="hint">Empty.</p>`}
    </section>

    ${everythingCard(csrf)}
    ${importCard(csrf)}`,
  });
}

/**
 * `backupOf`: the profile (not the one in use) an edit's backup was taken of;
 * restoring then only changes its saved copy. `addonsOnly`: the backup can put
 * back just its add-on list (an edit's backup whose profile still exists).
 */
export function restorePreviewPage({ site, csrf, backup, active, locked, account, backupOf = null, addonsOnly = false }) {
  return layout({
    site,
    title: 'Restore backup',
    account,
    csrf,
    tab: 'backups',
    body: html`<section class="card narrow">
      <h1>Restore this backup?</h1>
      <dl class="compare">
        <dt>Backup</dt><dd>${backup.label}<br><span class="hint">${when(backup.created_at)} · ${counts(backup)}</span></dd>
        ${backupOf
          ? html`<dt>Replaces</dt><dd>${backupOf.name}'s saved copy<br><span class="hint">last saved ${when(backupOf.snapshot_taken_at)} · ${counts(backupOf)}</span></dd>`
          : html`<dt>Replaces</dt><dd>${active ? html`${active.name}<br><span class="hint">last saved ${when(active.snapshot_taken_at)} · ${counts(active)}</span>` : 'the current account state'}</dd>`}
      </dl>
      ${addonsOnly ? html`<p>This backup was taken before an edit. <strong>Putting back only the add-ons</strong> leaves the library and progress as they are now.</p>` : ''}
      <p>${backupOf
        ? html`Restoring all of it replaces <strong>${backupOf.name}</strong>'s saved library, add-ons and notifications. Stremio doesn't change, because ${backupOf.name} isn't in use.`
        : html`Restoring all of it replaces the Stremio account's library, add-ons and notifications, and <strong>${active?.name ?? 'the active profile'}</strong> is saved that way.`}
        A backup is taken first, so you can undo this.</p>
      ${locked ? html`<div class="flash flash-error">${icon.alert}<p>Resolve the unfinished switch first.</p></div>` : ''}
      <div class="row">
        ${locked ? '' : addonsOnly ? postButton({ action: `/backups/${backup.id}/restore-addons`, csrf, label: 'Put back only the add-ons', style: 'primary' }) : ''}
        ${locked ? '' : postButton({ action: `/backups/${backup.id}/restore`, csrf, label: addonsOnly ? 'Restore all of it' : 'Restore', style: addonsOnly ? '' : 'primary' })}
        <a class="button" href="/backups">Cancel</a>
      </div>
    </section>`,
  });
}

// ── Install tab ──────────────────────────────────────────────────────────────

export function installPage({ site, csrf, account, flash, addon }) {
  const status = addon?.installed === true
    ? html`<span class="status status-ok">${icon.check} Installed on this account</span>`
    : addon?.installed === false ? html`<span class="status">Not installed yet</span>` : '';
  return layout({
    site,
    title: 'Install in Stremio',
    account,
    csrf,
    tab: 'install',
    body: html`${flashBlock(flash)}
    <section class="card" id="install">
      <div class="card-head">
        <h1 class="h2">Switch from inside Stremio</h1>
        ${status}
      </div>
      <p class="lede">Adds a <strong>Switch profile</strong> row to Stremio's Home. Every profile keeps it.</p>
      ${addon ? html`<div class="row">
        <a class="button primary" href="${addon.installUrl}">Install in Stremio</a>
        <button type="button" data-copy="${addon.manifestUrl}" data-copied="Copied">Copy add-on link</button>
      </div>` : ''}
      <ol class="steps">
        <li><span class="step-n">1</span><span>Install it once, on any device. It appears on every device signed in to this Stremio account.</span></li>
        <li><span class="step-n">2</span><span>On Home, open a profile in the <strong>Switch profile</strong> row. That switches.</span></li>
        <li><span class="step-n">3</span><span>Tap its stream to refresh Stremio, on phones, TVs and desktop alike.</span></li>
      </ol>
    </section>
    ${addon ? html`<section class="card">
      <h2>The link is a password</h2>
      <p class="hint">Anyone with the add-on link can switch this account's profile. If it leaks, get a
        new link: the old one stops working, and if the add-on is installed, Stremio's copy is updated
        for you.</p>
      <div class="row align-end">
        <label class="grow"><span>Add-on link <span class="copied-note" data-copied-note hidden>Copied</span></span>
          <input readonly value="${addon.manifestUrl}" class="mono copy-field" data-copy-field title="Click to copy"></label>
        ${postButton({ action: '/addon/rotate', csrf, label: 'Get a new link', style: 'danger', confirm: 'Make a new add-on link? The current one stops working.' })}
      </div>
    </section>` : ''}`,
  });
}

// ── Account tab ──────────────────────────────────────────────────────────────

const deviceName = (ua = '') => {
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows'
    : /Mac OS X/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'Unknown device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari' : 'browser';
  return `${os} · ${browser}`;
};

const ACTIVITY_SHOWN = 10;
const activityItem = (a) => html`<li><span class="hint">${when(a.at)}</span><span>${a.detail}</span></li>`;

export function accountPage({ site, csrf, account, flash, sessions = [], activity = [] }) {
  return layout({
    site,
    title: 'Account',
    account,
    csrf,
    tab: 'account',
    body: html`${flashBlock(flash)}
    <section class="card">
      <h1 class="h2">Signed in with Stremio</h1>
      <p>${account.email}</p>
      <p class="hint">Your Stremio password isn't stored. If Stremio signs ${site?.name ?? 'OpenProfiles'} out, <a href="/signin?again=1">sign in again</a>; your profiles stay.</p>
    </section>

    <section class="card" id="sessions">
      <div class="card-head">
        <h2 class="h3">Where you're signed in</h2>
        ${sessions.length > 1 ? postButton({ action: '/account/sessions/others/signout', csrf, label: 'Sign out everywhere else', style: 'link' }) : ''}
      </div>
      <ul class="list">
        ${sessions.map((s) => html`<li>
          <span><strong>${deviceName(s.user_agent)}</strong> <span class="hint">· last seen ${ago(s.last_seen_at)}</span></span>
          ${s.current ? html`<span class="status status-ok">This device</span>` : postButton({ action: `/account/sessions/${s.id}/signout`, csrf, label: html`Sign out<span class="sr-only"> ${deviceName(s.user_agent)}</span>`, style: 'link' })}
        </li>`)}
      </ul>
    </section>

    <section class="card" id="activity">
      <h2 class="h3">Activity</h2>
      ${activity.length === 0 ? html`<p class="hint">Nothing yet.</p>` : html`<ul class="activity">${activity.slice(0, ACTIVITY_SHOWN).map(activityItem)}</ul>
        ${activity.length > ACTIVITY_SHOWN ? html`<details class="fold">
          <summary>Show older (${activity.length - ACTIVITY_SHOWN})</summary>
          <ul class="activity">${activity.slice(ACTIVITY_SHOWN).map(activityItem)}</ul>
        </details>` : ''}`}
    </section>

    <section class="card danger-card" id="delete">
      <h2 class="h3">Delete my ${site?.name ?? 'OpenProfiles'} account</h2>
      <p class="hint">Removes your profiles and backups from this server. Your Stremio account stays exactly as it is right now.
        <a href="/backups#everything">Download everything</a> first if you might want them back.</p>
      <form method="post" action="/account/delete" class="row align-end">
        ${csrfField(csrf)}
        <label class="grow">Type DELETE to confirm <input name="confirm" autocomplete="off"></label>
        <button type="submit" class="danger">Delete account</button>
      </form>
    </section>`,
  });
}

// ── Server tab (whoever runs the server) ─────────────────────────────────────
// From the "Server tab" board of the Phase 2 design: counts first, then the settings.

const ADMIN_SECTIONS = [
  ['access', 'Who can sign in'],
  ['look', 'Look'],
  ['signin', 'Sign-in page'],
  ['announcement', 'Announcement'],
  ['stremio', 'In Stremio'],
  ['about', 'About this server'],
  ['log', 'Server log'],
];

const ACCESS_CHOICES = [
  ['owner', 'Only me', 'Nobody new can sign in.'],
  ['list', 'People on a list', 'Stremio emails or user ids you add.'],
  ['open', 'Anyone', 'Up to the limit you set.'],
];

const LOG_LEVELS = [
  ['error', 'Errors only'],
  ['warn', 'Errors and warnings'],
  ['info', 'Normal'],
  ['debug', 'Everything (for debugging)'],
];

const ACCENT_NAMES = ['Violet', 'Blue', 'Teal', 'Green', 'Amber', 'Orange', 'Red', 'Pink'];

function bytes(n) {
  if (n == null) return '?';
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${i === 0 ? v : v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

function duration(ms) {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return plural(Math.max(minutes, 0), 'minute');
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return plural(hours, 'hour');
  return plural(Math.floor(hours / 24), 'day');
}

const pill = (kind, text) => html`<span class="pill-status pill-${kind}">${text}</span>`;

function sparkline(perDay) {
  const max = Math.max(1, ...perDay);
  const W = 196;
  const H = 40;
  const step = W / perDay.length;
  return html`<svg class="spark" role="img" aria-label="Switches per day, last 7 days: ${perDay.join(', ')}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    ${perDay.map((n, i) => {
      const h = Math.round((n / max) * (H - 4)) + 2;
      return html`<rect x="${(i * step + 2).toFixed(1)}" y="${H - h}" width="${(step - 6).toFixed(1)}" height="${h}" rx="3" class="${i === perDay.length - 1 ? 'spark-now' : ''}"/>`;
    })}
  </svg>`;
}

function overview(stats) {
  const { accounts: a, switches: s, daily: d, server: srv } = stats;
  const full = a.limit != null && a.total >= a.limit;
  const ranOn = d.summary?.at ? ago(d.summary.at) : null;
  return html`<section class="admin-stats" aria-label="Overview">
    <div class="card stat">
      <span class="eyebrow">Accounts</span>
      <span class="stat-big"><strong>${a.total}</strong>${a.limit != null ? html`<span class="hint">of ${a.limit}</span>` : ''}</span>
      ${a.limit != null ? html`<span class="meter" role="img" aria-label="${a.total} of ${a.limit} places used"><span style="width:${Math.min(100, Math.round((a.total / a.limit) * 100))}%"></span></span>` : ''}
      <ul class="stat-lines">
        <li>${a.newThisWeek} new this week</li>
        <li>${a.usedThisWeek} used in the last 7 days</li>
        <li>${a.installed} with the add-on installed</li>
        ${a.removeAfterDays ? html`<li>Removed after ${a.removeAfterDays} days unused</li>` : ''}
      </ul>
      ${full ? pill('bad', "Full: nobody new can sign in") : a.unused ? pill('warn', `${a.unused} unused for ${a.unusedDays} days`) : ''}
    </div>

    <div class="card stat">
      <span class="eyebrow">Switches</span>
      <span class="stat-big"><strong>${s.week}</strong><span class="hint">this week</span></span>
      ${sparkline(s.perDay)}
      <ul class="stat-lines">
        <li>${s.today} in the last 24 hours</li>
        <li>${plural(s.restoresThisWeek, 'restore')} this week</li>
        ${s.rolledBackThisWeek ? html`<li>${s.rolledBackThisWeek} went back after a problem</li>` : ''}
      </ul>
      ${s.unfinished ? pill('warn', `${s.unfinished} unfinished`) : pill('ok', 'All finished')}
    </div>

    <div class="card stat">
      <span class="eyebrow">Daily jobs</span>
      <span class="stat-big stat-text"><strong>${ranOn ? `Ran ${ranOn}` : 'Not run yet'}</strong></span>
      <ul class="stat-lines">
        ${d.summary ? html`<li>${d.summary.backedUp} backed up · ${d.summary.skipped} unchanged</li>
          <li>${d.summary.failed} failed${d.summary.purged ? ` · ${plural(d.summary.purged, 'profile')} emptied from bins` : ''}</li>
          ${d.summary.removed ? html`<li>${plural(d.summary.removed, 'unused account')} removed</li>` : ''}` : html`<li>They run once a day, starting a few minutes after the server does.</li>`}
        ${d.snapshots ? html`<li>Database copies: ${d.snapshots.daily} daily, ${d.snapshots.weekly} weekly</li>` : ''}
      </ul>
      ${d.late ? pill('warn', 'Late') : d.summary?.failed ? pill('warn', `${d.summary.failed} failed`) : d.summary ? pill('ok', 'On schedule') : ''}
    </div>

    <div class="card stat">
      <span class="eyebrow">This server</span>
      <span class="stat-big stat-text"><strong>Up ${duration(srv.uptimeMs)}</strong><span class="hint">v${srv.version}</span></span>
      <dl class="stat-facts">
        <dt>Memory</dt><dd>${bytes(srv.memory)}</dd>
        <dt>Database</dt><dd>${bytes(srv.database)}</dd>
        ${srv.diskFree != null ? html`<dt>Disk free</dt><dd>${bytes(srv.diskFree)}</dd>` : ''}
        <dt>Profiles</dt><dd>${srv.profiles} · ${plural(srv.backups, 'backup')}</dd>
      </dl>
    </div>
  </section>

  <section class="card" aria-label="Errors and warnings">
    <div class="card-head">
      <h2 class="h3">Errors and warnings</h2>
      <span class="hint">Since the server started, ${duration(srv.uptimeMs)} ago. Details are in the server log.</span>
    </div>
    ${stats.problems.length ? html`<ul class="problems">
      ${stats.problems.map((p) => html`<li>
        ${pill(p.level === 'error' ? 'bad' : 'warn', p.level === 'error' ? 'Error' : 'Warning')}
        <span class="problem-msg">${p.message}</span>
        <span class="problem-count">×${p.count}</span>
        <span class="hint problem-when">${ago(p.last)}</span>
      </li>`)}
    </ul>` : html`<p class="hint">None.</p>`}
  </section>`;
}

/**
 * Where a setting's value comes from. Overriding the environment offers a way
 * back to it; the button submits the section's form to the reset route.
 */
function origin(d, key) {
  if (d.source === 'env') return html`<span class="origin">From .env</span>`;
  if (d.source === 'saved' && d.envSet) {
    const short = d.envRaw && d.envRaw.length <= 24 ? ` (${d.envRaw})` : '';
    return html`<span class="origin origin-saved">Overrides .env${short}</span>
      <button type="submit" class="link small" formaction="/admin/reset/${key}" formnovalidate>Use .env</button>`;
  }
  return '';
}

/**
 * A labelled control whose label row may carry the origin chip and its "Use .env"
 * button. The button sits outside the <label>, so clicking the label never presses it.
 */
const field = (key, text, d, control, { narrow = false } = {}) => html`<div class="field ${narrow ? 'narrow-field' : ''}">
  <span class="label-row"><label for="set-${key}">${text}</label>${origin(d, key)}</span>
  ${control}
</div>`;

function settingsForm(id, title, csrf, body, { hint = null } = {}) {
  return html`<form method="post" action="/admin/settings/${id}" class="card settings-card" id="${id}" aria-labelledby="${id}-title">
    ${csrfField(csrf)}
    <h2 class="h3" id="${id}-title">${title}</h2>
    ${body}
    ${hint ? html`<p class="hint">${hint}</p>` : ''}
    <div class="row end"><button type="submit" class="primary">Save</button></div>
  </form>`;
}

export function adminPage({ site, csrf, account, flash, stats, settings: d, fixed }) {
  const v = (key) => d[key].value;
  const accent = v('accent') ?? ACCENT_COLOURS[0];
  const logo = `/logo.png?v=${site?.logoVersion ?? ''}`;
  return layout({
    site,
    title: 'Server',
    account,
    csrf,
    tab: 'server',
    body: html`${flashBlock(flash)}
    <div class="section-head">
      <h1>Server</h1>
      <p class="hint">Only you see this tab. Every number is a count; none of it names an account.</p>
    </div>

    ${overview(stats)}

    <div class="admin-settings">
      <nav class="settings-nav card" aria-label="Settings sections">
        <span class="eyebrow">Settings</span>
        ${ADMIN_SECTIONS.map(([id, label]) => html`<a href="#${id}">${label}</a>`)}
      </nav>

      <div class="settings-body">
        ${settingsForm('access', 'Who can sign in', csrf, html`
          <fieldset class="choices access-choices" data-access>
            <legend class="sr-only">Who can sign in</legend>
            ${ACCESS_CHOICES.map(([value, title, body]) => html`<label class="choice">
              <input type="radio" name="access" value="${value}" ${v('access') === value ? 'checked' : ''}>
              <span class="choice-text"><strong>${title}</strong><span class="hint">${body}</span></span>
            </label>`)}
          </fieldset>
          ${d.access.source !== 'default' ? html`<p class="label-row">${origin(d.access, 'access')}</p>` : ''}
          <div data-access-for="list">${field('allowedAccounts', 'Stremio emails or user ids, one per line', d.allowedAccounts,
            html`<textarea id="set-allowedAccounts" name="allowedAccounts" rows="4" autocomplete="off" spellcheck="false">${v('allowedAccounts').join('\n')}</textarea>`)}</div>
          <div data-access-for="open" class="stack">${field('maxAccounts', 'Most accounts', d.maxAccounts,
            html`<input id="set-maxAccounts" type="number" name="maxAccounts" min="1" max="100000" step="1" value="${v('maxAccounts') ?? ''}" placeholder="No limit">`, { narrow: true })}
            ${field('removeUnusedDays', 'Remove accounts unused for (days)', d.removeUnusedDays,
            html`<input id="set-removeUnusedDays" type="number" name="removeUnusedDays" min="0" max="3650" step="1" value="${v('removeUnusedDays')}" aria-describedby="unused-hint">`, { narrow: true })}
            <p class="hint" id="unused-hint">Unused: no sign-in, no visit here and nothing from Stremio. 0 keeps them. Yours is never removed.</p></div>
        `, { hint: 'You can always sign in, whatever the rule. Accounts already here keep working when the limit drops.' })}

        ${settingsForm('look', 'Look', csrf, html`
          <div class="look-grid">
            <div class="stack">
              <label>Name <input name="serverName" value="${v('serverName')}" maxlength="40" data-preview-name></label>
              <fieldset class="accent-field">
                <legend>Accent colour</legend>
                <div class="row">
                  ${ACCENT_COLOURS.map((c, i) => html`<button type="button" class="accent-swatch" style="--c:${c}" data-accent="${c}" aria-label="${ACCENT_NAMES[i]}" aria-pressed="${c === accent ? 'true' : 'false'}" hidden></button>`)}
                  <label class="accent-custom"><span class="sr-only">Accent colour</span><input type="color" name="accent" value="${accent}" data-accent-input></label>
                </div>
              </fieldset>
              <fieldset class="seg-field">
                <legend>Appearance</legend>
                <div class="seg">
                  ${[['auto', 'Automatic'], ['light', 'Light'], ['dark', 'Dark']].map(([value, label]) => html`<label>
                    <input type="radio" name="appearance" value="${value}" ${v('appearance') === value ? 'checked' : ''}><span>${label}</span></label>`)}
                </div>
              </fieldset>
            </div>
            <div class="stack">
              <div class="logo-field">
                <img class="logo-preview" src="${logo}" alt="Current logo" width="72" height="72" data-logo-preview>
                <div class="stack-sm">
                  <label class="button" data-logo-upload hidden>Upload a picture
                    <input type="file" accept="image/png,image/jpeg,image/webp" class="sr-only" data-logo-file data-csrf="${csrf}"></label>
                  ${site?.customLogo ? html`<button type="submit" class="link small" formaction="/admin/logo/remove" formnovalidate>Use the drawn logo</button>` : ''}
                  <span class="hint" role="status" data-logo-status>PNG, JPG or WebP, square. Also the add-on's logo in Stremio.</span>
                  <noscript><span class="hint">Uploading needs JavaScript turned on.</span></noscript>
                </div>
              </div>
              <div class="brand-preview" style="--p:${accent};--pb:${buttonColours(accent).background};--pt:${buttonColours(accent).text}" data-brand-preview aria-hidden="true">
                <div class="brand-preview-top"><span class="brand-preview-mark"></span><span data-preview-name-out>${v('serverName')}</span></div>
                <div class="brand-preview-body"><span class="brand-preview-button">Switch</span><span class="hint">Preview</span></div>
              </div>
            </div>
          </div>
        `)}

        ${settingsForm('signin', 'Sign-in page', csrf, html`
          <label>Headline <input name="signinHeadline" value="${v('signinHeadline')}" maxlength="80"></label>
          <label>Introduction <textarea name="signinIntro" rows="3" maxlength="300">${v('signinIntro')}</textarea></label>
          <label class="switch-row">
            <span><strong>Link to OpenProfiles on GitHub</strong><span class="hint">The footer link and the "host your own" suggestions</span></span>
            <input type="checkbox" role="switch" name="selfHostLinks" value="1" ${v('selfHostLinks') ? 'checked' : ''}>
          </label>
        `, { hint: 'Emptying a field puts the original text back.' })}

        ${settingsForm('announcement', 'Announcement', csrf, html`
          <label>Shown at the top of every page, sign-in included. Leave it empty for none.
            <textarea name="announcement" rows="2" maxlength="280">${v('announcement') ?? ''}</textarea></label>
        `)}

        ${settingsForm('stremio', 'In Stremio', csrf, html`
          <div class="two-col">
            <label>Add-on name <input name="addonName" value="${v('addonName')}" maxlength="40"></label>
            <label>Row name <input name="catalogName" value="${v('catalogName')}" maxlength="40" data-row-name></label>
          </div>
          <label>Description, on the add-on's install page <textarea name="addonDescription" rows="2" maxlength="300">${v('addonDescription')}</textarea></label>
          <div class="row-preview" aria-hidden="true">
            <span><span data-row-name-out>${v('catalogName')}</span> - OpenProfiles</span>
            <span class="row-preview-tiles"><span></span><span></span><span></span></span>
          </div>
        `, { hint: 'Installed copies pick these up at their next switch.' })}

        ${settingsForm('about', 'About this server', csrf, html`
          <div class="two-col">
            ${field('operator', 'Run by', d.operator, html`<input id="set-operator" name="operator" value="${v('operator') ?? ''}" maxlength="80">`)}
            <label>Contact (a web address or email) <input name="contact" value="${v('contact') ?? ''}" maxlength="200" placeholder="https://… or you@example.com" autocomplete="off"></label>
          </div>
          ${field('privacyNote', 'Privacy note', d.privacyNote, html`<textarea id="set-privacyNote" name="privacyNote" rows="2" maxlength="500">${v('privacyNote') ?? ''}</textarea>`)}
        `, { hint: '"Run by" and the privacy note show when others can sign in. The contact is in every page\'s footer.' })}

        ${settingsForm('log', 'Server log', csrf, html`
          ${field('logLevel', 'What it writes', d.logLevel,
            html`<select id="set-logLevel" name="logLevel">${LOG_LEVELS.map(([value, label]) => html`<option value="${value}" ${v('logLevel') === value ? 'selected' : ''}>${label}</option>`)}</select>`, { narrow: true })}
        `)}

        <section class="card fixed-card" aria-labelledby="fixed-title">
          <h2 class="h3" id="fixed-title">Set in .env only</h2>
          <dl class="stat-facts">
            ${fixed.map(([label, value]) => html`<dt>${label}</dt><dd>${value}</dd>`)}
          </dl>
          <p class="hint">These decide where the server lives and what it trusts, so they can't be changed from a browser.</p>
        </section>
      </div>
    </div>`,
  });
}

/** What the server keeps, in plain words. Every line here must stay true to the code. */
export function privacyPage({ site = DEFAULT_SITE } = {}) {
  return layout({
    site,
    title: 'What this server keeps',
    body: html`<section class="card narrow prose">
      <h1>What this server keeps</h1>
      <p>${site.name} keeps what it needs to switch your profiles, and nothing else.${site.shared && site.operator ? ` This server is run by ${site.operator}.` : ''}${site.contact ? html` <a href="${contactHref(site.contact)}" rel="noopener">Contact</a>.` : ''}</p>

      <h2 class="h3">Kept, encrypted</h2>
      <ul>
        <li>Your Stremio sign-in key, so the server can switch profiles for you. Not your password.</li>
        <li>Each profile's library and watch progress, add-on list and new-episode notifications. Add-on links can contain debrid keys.</li>
        <li>Backups of those: daily, and before every switch, restore and edit. Old ones are removed on a schedule.</li>
        <li>Profile photos you upload, redrawn as a small square picture (nothing else from the file is kept).</li>
      </ul>

      <h2 class="h3">Kept as is</h2>
      <ul>
        <li>Your Stremio email and account id, and your profiles' names, colours and which picture each shows.</li>
        <li>Where you're signed in here: the description your browser sends (browser and device type), and when it was last used.</li>
        <li>A list of what you did here (switches, edits, backups), the last 200 entries.</li>
      </ul>

      <h2 class="h3">Not kept</h2>
      <ul>
        <li>Your Stremio password. It goes to Stremio once, to get the sign-in key.</li>
        <li>No analytics, ads or tracking. These pages load nothing from other sites.</li>
        <li>The server log has no emails, IP addresses, add-on links or watch history: only events like "account 3 switched profiles", and errors.</li>
      </ul>

      ${site.privacyNote ? html`<h2 class="h3">This server</h2>
      <p>${site.privacyNote}</p>

      ` : ''}<h2 class="h3">Who can read it</h2>
      <p>It's encrypted with this server's key, and whoever runs the server holds that key. Trust them as you would any service that has your add-on links, or run your own.</p>

      <h2 class="h3">Deleting it</h2>
      <p>Account › Delete my ${site.name} account removes everything from the live database at once.${site.removeUnusedDays ? ` An account nobody uses for ${site.removeUnusedDays} days (no sign-in, no visit here, and no use from Stremio) is removed the same way, to free its place.` : ''} The server's nightly copies of its database still hold it until they expire, within about 5 weeks. Your Stremio account stays as it is.</p>

      ${site.selfHostLinks ? html`<h2 class="h3">Run your own</h2>
      <p>OpenProfiles is free and open source. A server is one small Docker container: tens of MB of memory and a few MB of disk per account, so a free cloud tier or a Raspberry Pi is plenty. It needs an https address, because Stremio only installs add-ons over https.
        <a href="${REPO_URL}" rel="noopener">Set it up from GitHub</a>.</p>` : ''}
      <p><a href="/">Back to ${site.name}</a></p>
    </section>`,
  });
}

export function errorPage({ site = DEFAULT_SITE, status, message }) {
  return layout({
    site,
    title: status === 404 ? 'Not found' : 'Error',
    body: html`<section class="card narrow"><h1>${status === 404 ? 'Not found' : 'Something went wrong'}</h1>
      <p>${message}</p><p><a href="/configure">Back to ${site.name}</a></p></section>`,
  });
}
