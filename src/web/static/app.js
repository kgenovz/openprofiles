// Confirm prompts for destructive forms (or one button of a form), and a busy
// state so a slow switch isn't submitted twice.
document.addEventListener('submit', (event) => {
  const form = event.target;
  // Hiding the Undo bar happens in the background, without reloading the page.
  if (form.matches('[data-undo-hide]')) {
    event.preventDefault();
    form.closest('.undo')?.remove();
    fetch(form.action, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-requested-with': 'fetch' },
      body: new URLSearchParams(new FormData(form)),
    }).catch(() => {});
    return;
  }
  const question = event.submitter?.dataset.confirmClick || form.getAttribute('data-confirm');
  if (question && !window.confirm(question)) {
    event.preventDefault();
    return;
  }
  for (const button of form.querySelectorAll('button[type="submit"]')) {
    button.disabled = true;
    button.dataset.label = button.textContent;
    button.textContent = 'Working…';
  }
  document.body.classList.add('is-busy');
});

// "Copy" buttons: <button data-copy="text" data-copied="Copied">.
document.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-copy]');
  if (!button) return;
  const label = button.textContent;
  try {
    await navigator.clipboard.writeText(button.dataset.copy);
    button.textContent = button.dataset.copied || 'Copied';
  } catch {
    button.textContent = 'Copy failed: select the link below';
  }
  setTimeout(() => { button.textContent = label; }, 2000);
});

// Picture picker: tabs, Shuffle for generated faces, previews follow the chosen colour.
function showTab(picker, name) {
  picker.dataset.tab = name;
  for (const tab of picker.querySelectorAll('[data-tab-for]')) {
    tab.setAttribute('aria-selected', String(tab.dataset.tabFor === name));
  }
  for (const panel of picker.querySelectorAll('[data-tab-panel]')) {
    panel.hidden = panel.dataset.tabPanel !== name;
  }
  picker.querySelector('[data-shuffle]').hidden = name !== 'gen';
}

function setPreviewParam(img, key, value) {
  const url = new URL(img.getAttribute('src'), location.href);
  url.searchParams.set(key, value);
  img.setAttribute('src', url.pathname + url.search);
}

for (const picker of document.querySelectorAll('.picker')) {
  picker.querySelector('.picker-tabs').hidden = false;
  showTab(picker, picker.dataset.tab);
}

document.addEventListener('click', (event) => {
  const tab = event.target.closest('[data-tab-for]');
  if (tab) showTab(tab.closest('.picker'), tab.dataset.tabFor);

  const shuffle = event.target.closest('[data-shuffle]');
  if (shuffle) {
    for (const input of shuffle.closest('.picker').querySelectorAll('[data-tab-panel="gen"] input')) {
      if (input.checked) continue;
      const [, style] = input.value.split(':');
      input.value = `gen:${style}:${Math.random().toString(36).slice(2, 10)}`;
      setPreviewParam(input.nextElementSibling, 'avatar', input.value);
    }
  }
});

document.addEventListener('change', (event) => {
  const input = event.target;
  if (input.name !== 'colour') return;
  const form = input.closest('[data-picture-form]');
  if (!form) return;
  for (const img of form.querySelectorAll('img[data-avatar]')) setPreviewParam(img, 'colour', input.value);
});

// Import from StremShare: upload for a summary, then show the confirm form.
document.addEventListener('change', async (event) => {
  const input = event.target.closest('[data-import-file]');
  if (!input || !input.files.length) return;
  const card = input.closest('#import');
  const status = card.querySelector('[data-import-status]');
  const form = card.querySelector('[data-import-confirm]');
  form.hidden = true;
  const file = input.files[0];
  if (file.size > 60 * 1024 * 1024) {
    status.textContent = 'That file is too big to be a StremShare backup.';
    return;
  }
  status.textContent = 'Checking the file…';
  try {
    const res = await fetch('/import/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': input.dataset.csrf },
      body: await file.text(),
    });
    const data = await res.json();
    if (!res.ok) {
      status.textContent = data.error || 'That file could not be read.';
      return;
    }
    const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
    const when = data.createdAt ? ` from ${new Date(data.createdAt).toLocaleString()}` : '';
    form.querySelector('[data-import-summary]').textContent =
      `"${data.label || 'StremShare backup'}"${when}: ${plural(data.counts.library, 'title')}, ` +
      `${plural(data.counts.addons, 'add-on')}, ${plural(data.counts.notifs, 'notification')}.`;
    form.elements.id.value = data.id;
    form.elements.name.value = data.suggestedName;
    const other = form.querySelector('[data-import-other]');
    other.hidden = data.sameAccount === true;
    form.elements.acceptOtherAccount.checked = false;
    form.querySelector('[data-import-other-text]').textContent = data.sameAccount === false
      ? `This backup is from ${data.sourceEmail || 'a different Stremio account'}. I understand its add-ons and library will be used on this account.`
      : "This file doesn't say which Stremio account it came from. I understand it may be from a different one.";
    status.textContent = '';
    form.hidden = false;
  } catch {
    status.textContent = 'Upload failed. Check the connection and try again.';
  }
});

// Bring back an "everything" export: read the file and post it as JSON.
document.addEventListener('click', async (event) => {
  const go = event.target.closest('[data-everything-go]');
  if (!go) return;
  const box = go.closest('[data-everything]');
  const status = box.querySelector('[data-everything-status]');
  const file = box.querySelector('[data-everything-file]').files[0];
  if (!file) {
    status.textContent = 'Choose the export file first.';
    return;
  }
  go.disabled = true;
  status.textContent = 'Bringing it back…';
  try {
    const res = await fetch('/import/everything', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': box.dataset.csrf },
      body: JSON.stringify({
        file: JSON.parse(await file.text()),
        passphrase: box.querySelector('[data-everything-pass]').value || null,
        acceptOtherAccount: box.querySelector('[data-everything-other]').checked,
      }),
    });
    const data = await res.json();
    if (res.ok) {
      location.reload();
      return;
    }
    status.textContent = data.error || 'That file could not be brought back.';
  } catch {
    status.textContent = "That file isn't an OpenProfiles export.";
  }
  go.disabled = false;
});

// ── add-on lists (wizard and manager) ───────────────────────────────────────

const csrfOf = (el) => el.closest('form')?.querySelector('input[name="_csrf"]')?.value ?? '';
const listChanged = (list) => list.dispatchEvent(new CustomEvent('addons:changed', { bubbles: true }));

// Up and down buttons.
document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-move]');
  if (!button) return;
  const row = button.closest('li');
  const list = row.parentElement;
  if (button.dataset.move === '-1' && row.previousElementSibling) list.insertBefore(row, row.previousElementSibling);
  else if (button.dataset.move === '1' && row.nextElementSibling) list.insertBefore(row.nextElementSibling, row);
  else return;
  button.focus();
  listChanged(list);
});

// Drag by the grip (pointer devices; touch uses the buttons).
let dragged = null;
document.addEventListener('pointerdown', (event) => {
  const grip = event.target.closest('[data-addon-list] .grip');
  if (grip) grip.closest('li').draggable = true;
});
document.addEventListener('dragstart', (event) => {
  const row = event.target.closest?.('[data-addon-list] > li');
  if (!row) return;
  dragged = row;
  row.classList.add('is-dragging');
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', row.dataset.ref);
});
document.addEventListener('dragover', (event) => {
  const list = event.target.closest?.('[data-addon-list]');
  if (!dragged || list !== dragged.parentElement) return;
  event.preventDefault();
  const after = [...list.children].find((li) => li !== dragged && event.clientY < li.getBoundingClientRect().top + li.offsetHeight / 2);
  list.insertBefore(dragged, after ?? null);
});
document.addEventListener('dragend', () => {
  if (!dragged) return;
  dragged.classList.remove('is-dragging');
  dragged.draggable = false;
  listChanged(dragged.parentElement);
  dragged = null;
});

// Add by link: the server fetches the manifest (through its guard) and sends back the row.
async function addByLink(box) {
  const input = box.querySelector('[data-add-url]');
  const status = box.querySelector('[data-add-status]');
  const list = box.closest('form').querySelector('[data-addon-list]');
  const url = input.value.trim();
  if (!url) {
    status.textContent = 'Paste an add-on link first.';
    return;
  }
  status.textContent = 'Checking the add-on…';
  try {
    const res = await fetch('/addons/lookup', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrfOf(box) },
      body: JSON.stringify({ url, for: box.dataset.kind }),
    });
    const data = await res.json();
    if (!res.ok) {
      status.textContent = data.error || "That add-on couldn't be added.";
      return;
    }
    const existing = list.querySelector(`li[data-ref="${data.ref}"]`);
    if (existing) {
      const tick = existing.querySelector('input[type="checkbox"][name="addon"]');
      if (tick) tick.checked = true;
      status.textContent = `${data.name} is already in the list.`;
    } else {
      list.insertAdjacentHTML('beforeend', data.html);
      status.textContent = `Added ${data.name} at the end.`;
    }
    input.value = '';
    listChanged(list);
  } catch {
    status.textContent = 'Checking failed. Check the connection and try again.';
  }
}

for (const box of document.querySelectorAll('[data-add-link]')) {
  const go = box.querySelector('[data-add-go]');
  go.hidden = false;
  go.addEventListener('click', () => addByLink(box));
  box.querySelector('[data-add-url]').addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    addByLink(box);
  });
}

// ── the add-on manager ──────────────────────────────────────────────────────

const managerForm = document.querySelector('[data-addon-form]');
if (managerForm) {
  const list = managerForm.querySelector('[data-addon-list]');
  const initialOrder = [...list.children].map((li) => li.dataset.ref).join();

  // From your other profiles: copy the row from its template.
  const pool = managerForm.querySelector('[data-add-pool]');
  if (pool) {
    const select = pool.querySelector('[data-pool-select]');
    const go = pool.querySelector('[data-pool-go]');
    go.hidden = false;
    go.addEventListener('click', () => {
      const template = managerForm.querySelector(`template[data-pool-item="${select.value}"]`);
      if (!template) return;
      list.append(template.content.cloneNode(true));
      select.selectedOptions[0].remove();
      select.value = '';
      if (select.options.length === 1) pool.hidden = true;
      listChanged(list);
    });
  }

  // "2 unsaved changes: YouTube removed, order changed".
  const changes = managerForm.querySelector('[data-changes]');
  const discard = managerForm.querySelector('[data-discard]');
  const summarise = () => {
    const rows = [...list.children];
    const parts = [];
    for (const li of rows) {
      const removed = li.querySelector('input[name="remove"]')?.checked;
      li.classList.toggle('is-removed', Boolean(removed));
      if (removed) parts.push(`${li.dataset.name} removed`);
      else if (li.classList.contains('is-new')) parts.push(`${li.dataset.name} added`);
    }
    const kept = rows.filter((li) => !li.classList.contains('is-new')).map((li) => li.dataset.ref).join();
    if (kept !== initialOrder) parts.push('order changed');
    const renamed = [...list.querySelectorAll('input[data-original]')].filter((i) => i.value.trim() !== i.dataset.original).length;
    if (renamed) parts.push(`${renamed} catalog${renamed === 1 ? '' : 's'} renamed`);
    changes.textContent = parts.length
      ? `${parts.length} unsaved change${parts.length === 1 ? '' : 's'}: ${parts.join(', ')}`
      : 'No changes yet.';
    managerForm.classList.toggle('has-changes', parts.length > 0);
    discard.hidden = parts.length === 0;
  };
  managerForm.addEventListener('addons:changed', summarise);
  managerForm.addEventListener('change', summarise);
  managerForm.addEventListener('input', (event) => {
    if (event.target.matches('input[data-original]')) summarise();
  });
  summarise();

  // Leaving with unsaved changes asks first.
  let saving = false;
  managerForm.addEventListener('submit', () => { saving = true; });
  discard.addEventListener('click', () => { saving = true; });
  window.addEventListener('beforeunload', (event) => {
    if (!saving && managerForm.classList.contains('has-changes')) event.preventDefault();
  });

  // Check they're working.
  const health = managerForm.querySelector('[data-health-check]');
  health.hidden = false;
  health.addEventListener('click', async () => {
    const label = health.textContent;
    health.disabled = true;
    health.textContent = 'Checking…';
    try {
      const res = await fetch(health.dataset.healthCheck, { method: 'POST', headers: { 'x-csrf-token': csrfOf(health) } });
      const results = await res.json();
      const words = { ok: 'Working', unreachable: "Can't reach", device: 'On your device' };
      for (const li of list.children) {
        const pill = li.querySelector('[data-health]');
        const result = results[li.dataset.ref];
        if (!pill || !result) continue;
        pill.textContent = words[result];
        pill.dataset.state = result;
        pill.hidden = false;
      }
    } catch { /* leave the pills hidden */ }
    health.disabled = false;
    health.textContent = label;
  });
}

// Cinemeta panel: the "no details pages" warning follows the switch.
const cinemetaForm = document.querySelector('[data-cinemeta-form]');
if (cinemetaForm) {
  cinemetaForm.addEventListener('change', () => {
    const meta = cinemetaForm.querySelector('[data-cm="meta"]');
    const warning = cinemetaForm.querySelector('[data-meta-warning]');
    if (meta && warning) warning.hidden = meta.checked || cinemetaForm.dataset.otherMeta === '1';
    // With a wrapped Cinemeta in the list, any row turned on here shows twice.
    const wrapper = cinemetaForm.querySelector('[data-wrapper-warning]');
    if (wrapper) wrapper.hidden = !['popular', 'new', 'featured'].some((k) => cinemetaForm.querySelector(`[data-cm="${k}"]`)?.checked);
    // The Calendar note matters once something is switched off.
    const calendar = cinemetaForm.querySelector('[data-cm-calendar]');
    if (calendar) calendar.hidden = [...cinemetaForm.querySelectorAll('[data-cm]')].every((i) => i.checked);
  });
}

// Metadata card: "Change" only does something when another add-on is picked.
const metadataForm = document.querySelector('[data-metadata-form]');
if (metadataForm) {
  const select = metadataForm.querySelector('select[name="source"]');
  const go = metadataForm.querySelector('[data-metadata-go]');
  // The explanations show only for a pick they're about.
  const sync = () => {
    if (!select || !go) return;
    const changing = select.value !== select.dataset.current;
    go.disabled = !changing;
    metadataForm.querySelector('[data-meta-pick-hint]').hidden = !changing;
    metadataForm.querySelector('[data-own-ids-hint]').hidden = !(changing && select.selectedOptions[0]?.hasAttribute('data-own-ids'));
  };
  metadataForm.addEventListener('change', sync);
  sync();
}

// ── the new-profile wizard ──────────────────────────────────────────────────

const wizard = document.querySelector('[data-wizard]');
if (wizard) {
  const steps = [...wizard.querySelectorAll('[data-step]')];
  const nav = wizard.querySelector('.wizard-steps');
  const back = wizard.querySelector('[data-back]');
  const next = wizard.querySelector('[data-next]');
  const create = wizard.querySelector('[data-create]');
  const count = wizard.querySelector('[data-step-count]');
  const nameInput = wizard.querySelector('[data-wizard-name]');
  const list = wizard.querySelector('[data-addon-list]');
  const starts = JSON.parse(wizard.dataset.starts);
  let current = 1;

  wizard.classList.add('is-js');
  nav.hidden = false;

  const ticked = () => [...list.children].filter((li) => li.querySelector('input[name="addon"]').checked);
  const checkedStart = () => wizard.querySelector('input[name="from"]:checked')?.value ?? 'empty';
  const startData = () => {
    if (checkedStart() !== 'profile') return starts.live;
    return starts.profiles[wizard.querySelector('[data-source]')?.value] ?? starts.live;
  };

  // Cinemeta's step follows whether Cinemeta is ticked; the warning, whether anything else gives details pages.
  const syncCinemeta = () => {
    const rows = ticked();
    const hasCinemeta = rows.some((li) => li.dataset.cinemeta === '1');
    wizard.querySelector('[data-cm-switches]').hidden = !hasCinemeta;
    wizard.querySelector('[data-cm-none]').hidden = hasCinemeta;
    const metaOn = wizard.querySelector('[data-cm="meta"]').checked;
    const others = rows.some((li) => li.dataset.cinemeta !== '1' && li.dataset.servesMeta === '1');
    wizard.querySelector('[data-meta-warning]').hidden = !hasCinemeta || metaOn || others;
    // A ticked add-on that wraps Cinemeta shows its own rows, so rows on here would show twice.
    const wrapper = rows.find((li) => li.dataset.wrapsCinemeta === '1');
    const rowsOn = ['popular', 'new', 'featured'].some((k) => wizard.querySelector(`[data-cm="${k}"]`).checked);
    const warning = wizard.querySelector('[data-wrapper-warning]');
    if (wrapper) warning.querySelector('[data-wrapper-name]').textContent = wrapper.dataset.name;
    warning.hidden = !(hasCinemeta && wrapper && rowsOn);
  };

  // "Let it show them": stock Cinemeta's rows and search off, details too if the wrapper gives them.
  wizard.querySelector('[data-cm-to-wrapper]').addEventListener('click', () => {
    const wrapper = ticked().find((li) => li.dataset.wrapsCinemeta === '1');
    for (const k of ['popular', 'new', 'featured', 'search']) wizard.querySelector(`[data-cm="${k}"]`).checked = false;
    if (wrapper?.dataset.servesMeta === '1') wizard.querySelector('[data-cm="meta"]').checked = false;
    syncCinemeta();
  });

  // A new start re-ticks the add-ons in its order and sets Cinemeta its way.
  const applyStart = () => {
    const start = startData();
    const rows = new Map([...list.children].map((li) => [li.dataset.ref, li]));
    for (const li of rows.values()) {
      const tick = li.querySelector('input[name="addon"]');
      tick.checked = false;
      delete tick.dataset.locked;
      li.querySelector('[data-lock-badge]').hidden = true;
    }
    for (const ref of start.refs) {
      const li = rows.get(ref);
      if (!li) continue;
      list.append(li);
      const tick = li.querySelector('input[name="addon"]');
      tick.checked = true;
      if (li.dataset.protected === '1') {
        tick.dataset.locked = '';
        li.querySelector('[data-lock-badge]').hidden = false;
      }
    }
    for (const li of rows.values()) if (!start.refs.includes(li.dataset.ref)) list.append(li);
    const settings = start.cinemeta ?? {};
    const map = { popular: 'hidePopular', new: 'hideNew', featured: 'hideFeatured', search: 'removeSearch', meta: 'removeMeta' };
    for (const [key, setting] of Object.entries(map)) wizard.querySelector(`[data-cm="${key}"]`).checked = !settings[setting];
    syncCinemeta();
  };

  // Locked add-ons (Cinemeta, Local Files, OpenProfiles) stay ticked.
  list.addEventListener('click', (event) => {
    if (event.target.matches('input[name="addon"][data-locked]')) event.preventDefault();
  });

  const settingsLine = () => {
    if (!ticked().some((li) => li.dataset.cinemeta === '1')) return 'Not included';
    const on = (key) => wizard.querySelector(`[data-cm="${key}"]`).checked;
    const rows = [['Popular', 'popular'], ['New', 'new'], ['Featured', 'featured']].filter(([, k]) => on(k)).map(([n]) => n);
    return `${rows.length ? `${rows.join(', ')} shown` : 'No catalogs shown'}; search ${on('search') ? 'on' : 'off'}; details pages ${on('meta') ? 'on' : 'off'}`;
  };

  const fillReview = () => {
    const set = (key, text) => { wizard.querySelector(`[data-review="${key}"]`).textContent = text; };
    set('name', nameInput.value.trim() || '—');
    const choice = wizard.querySelector('input[name="from"]:checked')?.closest('label');
    let start = choice?.querySelector('strong')?.textContent ?? '—';
    if (checkedStart() === 'profile') start += `: ${wizard.querySelector('[data-source]').selectedOptions[0].textContent}`;
    set('start', start);
    set('addons', ticked().map((li) => li.dataset.name).join(', ') || 'None');
    set('cinemeta', settingsLine());
  };

  const show = (n, { focus = true } = {}) => {
    current = n;
    for (const step of steps) step.hidden = Number(step.dataset.step) !== n;
    nav.querySelectorAll('li').forEach((li, i) => {
      li.classList.toggle('is-done', i + 1 < n);
      li.classList.toggle('is-current', i + 1 === n);
    });
    back.hidden = n === 1;
    next.hidden = n === steps.length;
    create.hidden = n !== steps.length;
    count.textContent = `Step ${n} of ${steps.length}`;
    if (n === steps.length) fillReview();
    syncCinemeta();
    if (focus) steps[n - 1].querySelector('.step-title')?.focus({ preventScroll: true });
  };

  // Step 1 needs a name before going on.
  const canLeave = () => current !== 1 || nameInput.reportValidity();
  next.hidden = false;
  next.addEventListener('click', () => { if (canLeave()) show(current + 1); });
  back.addEventListener('click', () => show(current - 1));
  nav.addEventListener('click', (event) => {
    const go = event.target.closest('[data-go]');
    if (go && (Number(go.dataset.go) < current || canLeave())) show(Number(go.dataset.go));
  });
  // Enter moves on instead of creating the profile early.
  wizard.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || current === steps.length || event.target.matches('textarea, button, [data-add-url]')) return;
    event.preventDefault();
    if (canLeave()) show(current + 1);
  });

  wizard.addEventListener('change', (event) => {
    if (event.target.matches('input[name="from"], [data-source]')) applyStart();
    if (event.target.matches('[data-source]')) wizard.querySelector('input[name="from"][value="profile"]').checked = true;
    syncCinemeta();
  });
  wizard.addEventListener('addons:changed', syncCinemeta);

  // The big picture and the letter tiles follow the name, picture and colour.
  const previews = () => wizard.querySelectorAll('[data-wizard-preview]');
  const updatePreview = () => {
    const picture = wizard.querySelector('input[name="picture"]:checked')?.value ?? 'initial';
    const colour = wizard.querySelector('input[name="colour"]:checked')?.value;
    for (const img of previews()) {
      setPreviewParam(img, 'avatar', picture);
      if (colour) setPreviewParam(img, 'colour', colour);
      setPreviewParam(img, 'name', nameInput.value.trim() || '?');
    }
  };
  let nameTimer;
  nameInput.addEventListener('input', () => {
    for (const echo of wizard.querySelectorAll('[data-name-echo]')) echo.textContent = nameInput.value.trim() || 'it';
    clearTimeout(nameTimer);
    nameTimer = setTimeout(() => {
      updatePreview();
      for (const img of wizard.querySelectorAll('img[data-avatar="initial"]')) setPreviewParam(img, 'name', nameInput.value.trim() || '?');
    }, 300);
  });
  wizard.addEventListener('change', (event) => {
    if (event.target.matches('input[name="picture"], input[name="colour"]')) updatePreview();
  });

  show(1, { focus: false });
}

// Back/forward cache can restore the page with buttons still disabled.
window.addEventListener('pageshow', () => {
  document.body.classList.remove('is-busy');
  for (const button of document.querySelectorAll('button[data-label]')) {
    button.disabled = false;
    button.textContent = button.dataset.label;
  }
});
