// ==========================================================================
// report-links.js - progress-report links in chat, for both apps.
//
// Reports live in the private chat-attachments bucket (health data - see
// the storage policies in sql-history.sql). A chat message keeps the
// report's location in pdf_url; this swaps it for a short-lived signed
// link when the chat loads, so "View Report" stays a plain link (no
// pop-up blocking, works in the native app) while a copied or forwarded
// link stops working within the hour.
// ==========================================================================

const BUCKET = 'chat-attachments'
const LINK_SECONDS = 60 * 60

// pdf_url is a full public-style URL (.../object/public/chat-attachments/
// <coach id>/<file>.pdf); the storage path is everything after the bucket
export function reportPath(pdfUrl) {
  if (!pdfUrl) return null
  const marker = `/${BUCKET}/`
  const i = pdfUrl.indexOf(marker)
  if (i === -1) return null
  return decodeURIComponent(pdfUrl.slice(i + marker.length).split('?')[0])
}

// Sets m.report_url on every message that has a report, in one request.
// Left unset if signing fails - the chat shows the report as unavailable
// rather than a link that won't open.
export async function signReportLinks(supabase, messages) {
  const paths = [...new Set(messages.map(m => reportPath(m.pdf_url)).filter(Boolean))]
  if (paths.length === 0) return
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrls(paths, LINK_SECONDS)
  if (error) { console.log('Error signing report links:', error); return }
  const byPath = new Map((data || []).filter(d => d.signedUrl).map(d => [d.path, d.signedUrl]))
  for (const m of messages) {
    const path = reportPath(m.pdf_url)
    if (path && byPath.has(path)) m.report_url = byPath.get(path)
  }
}
