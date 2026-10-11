const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export class SafeHtml {
  constructor(text) {
    this.text = text;
  }

  toString() {
    return this.text;
  }
}

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

function render(value) {
  if (value == null || value === false) return '';
  if (value instanceof SafeHtml) return value.text;
  if (Array.isArray(value)) return value.map(render).join('');
  return escapeHtml(value);
}

/** Tagged template that escapes every interpolation unless it is already SafeHtml. */
export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += render(values[i]) + strings[i + 1];
  return new SafeHtml(out);
}
