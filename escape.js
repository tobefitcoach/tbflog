// ==========================================================================
// escape.js - the one HTML escape helper for both apps (and the builder
// iframe). Use it for ANY text that goes into innerHTML or a template
// string, especially text an athlete typed (names, notes, chat, workout
// names) - otherwise an athlete could put markup into the coach's screens.
//
// Escapes quotes too, so it's safe inside attributes (data-name="...",
// title="..."). The old per-file copies used the textContent -> innerHTML
// trick, which leaves quotes alone and so was only safe between tags.
// ==========================================================================

export function escapeHtml(str) {
  if (str == null) return ''
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// For src="" / href="" built from stored data (avatar_url, video links):
// only http(s) URLs get through, so a stored "javascript:..." link can't
// run. Returns '' for anything else; the result is already escaped.
export function safeUrl(url) {
  if (!url) return ''
  try {
    const { protocol } = new URL(url, window.location.href)
    return protocol === 'https:' || protocol === 'http:' ? escapeHtml(url) : ''
  } catch {
    return ''
  }
}
