// Confirm prompts for destructive forms, and a busy state so a slow switch
// isn't submitted twice.
document.addEventListener('submit', (event) => {
  const form = event.target;
  const question = form.getAttribute('data-confirm');
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

// Back/forward cache can restore the page with buttons still disabled.
window.addEventListener('pageshow', () => {
  document.body.classList.remove('is-busy');
  for (const button of document.querySelectorAll('button[data-label]')) {
    button.disabled = false;
    button.textContent = button.dataset.label;
  }
});
