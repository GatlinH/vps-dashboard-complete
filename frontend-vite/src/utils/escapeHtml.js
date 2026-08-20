function escapeHtml(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[character],
  );
}

export function escapeHtmlText(value) {
  return escapeHtml(value);
}

export function escapeHtmlAttribute(value) {
  return escapeHtml(value);
}
