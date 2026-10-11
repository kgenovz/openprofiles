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

// Back/forward cache can restore the page with buttons still disabled.
window.addEventListener('pageshow', () => {
  document.body.classList.remove('is-busy');
  for (const button of document.querySelectorAll('button[data-label]')) {
    button.disabled = false;
    button.textContent = button.dataset.label;
  }
});
