// ==========================================================================
// ON-DEMAND VENDOR SCRIPTS
// Chart.js and jsPDF are the two biggest third-party dependencies in the
// repo, and the multi-page athlete.html loaded BOTH with a plain
// <script defer> in its <head> - so every coach who opened any athlete's
// page paid for both, even just to read the Overview tab, and even though
// jsPDF is only ever used by the "Download progress report" button.
//
// Here they are fetched the first time something actually needs them. Both
// are UMD builds that define a global (window.Chart, window.jspdf), so
// every existing `new Chart(...)` and `window.jspdf.jsPDF` call site works
// unchanged - this only controls WHEN the script arrives, never how it is
// used.
//
// A <script> tag is injected rather than using a dynamic import() because
// these are UMD bundles, not ES modules; import() would not give us the
// global the existing code reads. Each loader caches its own promise, so
// concurrent callers share one network request and a second call after it
// has landed resolves immediately.
// ==========================================================================

const CHART_JS = 'https://cdn.jsdelivr.net/npm/chart.js@4.5.1'
const JSPDF_JS = 'https://cdn.jsdelivr.net/npm/jspdf@2.5.2/dist/jspdf.umd.min.js'

const cache = {}

function loadScript(url) {
  if (cache[url]) return cache[url]
  cache[url] = new Promise(function(resolve, reject) {
    const el = document.createElement('script')
    el.src = url
    el.onload = resolve
    el.onerror = function() {
      // Let a later attempt retry rather than caching the failure forever -
      // this is usually a dropped connection, not a bad URL.
      delete cache[url]
      reject(new Error('Failed to load ' + url))
    }
    document.head.appendChild(el)
  })
  return cache[url]
}

// Resolves once window.Chart exists. Call and await before the first
// `new Chart(...)` on a screen.
export function loadChartJs() {
  if (window.Chart) return Promise.resolve()
  return loadScript(CHART_JS)
}

// Resolves once window.jspdf exists. Only the PDF progress report needs
// this, so a coach who never taps that button never downloads it.
export function loadJsPdf() {
  if (window.jspdf) return Promise.resolve()
  return loadScript(JSPDF_JS)
}
