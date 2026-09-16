// ==========================================================================
// PLACEHOLDER SCREEN — Phase 1 scaffolding
// Stands in for all 13 real screens until each is converted. It exists so
// Phase 1 can verify the whole machinery end to end for real - dynamic
// import, the mount/unmount lifecycle, history push/replay, nav
// highlighting, the async-race guard - rather than verifying a shell with
// nothing behind it.
//
// It is ALSO the reference implementation of the per-screen contract.
// Every screen in Phase 2 onward looks like this:
//
//   export async function mount(container, params, token) { ... }
//   export function unmount() { ... }
//
//   container  the live #pageContent element. Owned by the screen between
//              mount and unmount; write to it freely.
//   params     route params ({ status: 'active' }, { athleteId: 42 }, ...)
//              plus params.route, the route's own name.
//   token      the nav generation token. After EVERY await, check
//              nav.isCurrent(token) before touching the DOM again - if the
//              coach navigated away during a slow query, the response must
//              not repaint over whatever screen is showing now.
//
// Screens do NOT call nav.enter themselves - dashboard.js's renderScreen
// does that centrally before calling mount. Screens DO call nav.back()
// from their own "← Back" buttons.
//
// Delete this file once the last route in dashboard.js's ROUTES table
// points at a real screen.
// ==========================================================================
import * as nav from '../nav.js'

const COMING_IN = {
  exercises: 'Phase 2', sections: 'Phase 2', trainings: 'Phase 2',
  programs: 'Phase 2', stretches: 'Phase 2', forms: 'Phase 2',
  settings: 'Phase 2',
  athletes: 'Phase 3', communication: 'Phase 3',
  'athlete-detail': 'Phase 4',
  'program-builder': 'Phase 5', 'section-builder': 'Phase 5',
  'form-builder': 'Phase 5',
}

// Module-level, so unmount can clear it. A screen that sets an interval and
// doesn't clear it here is the exact leak the multi-page site had (each
// full page load happened to paper over it); in an SPA the interval would
// survive every subsequent navigation.
let demoTimer = null

export async function mount(container, params, token) {
  const route = params.route || 'unknown'
  const isDrillDown = route === 'athlete-detail' || route.endsWith('-builder')

  container.innerHTML = `
    ${isDrillDown ? `
      <div class="screen-header">
        <button class="btn-back" id="phBackBtn" aria-label="Back">←</button>
        <h2 class="screen-title">${route}</h2>
      </div>` : ''}
    <div class="screen-message">
      <h2>${route}</h2>
      <p>This screen arrives in <strong>${COMING_IN[route] || 'a later phase'}</strong>.</p>
      <p style="margin-top:12px; font-size:13px">
        Shell, routing and back navigation are live — tap around and use the
        back gesture to confirm they behave.
      </p>
      ${params.status ? `<p style="margin-top:12px; font-size:13px">Route param <code>status=${params.status}</code> received.</p>` : ''}
      ${isDrillDown ? '' : `
        <button class="btn-save" id="phDrillBtn" style="margin-top:20px">
          Open a drill-down (tests back)
        </button>`}
    </div>`

  if (isDrillDown) {
    container.querySelector('#phBackBtn').addEventListener('click', function() { nav.back() })
  } else {
    container.querySelector('#phDrillBtn').addEventListener('click', function() {
      window.coachNav.go('athlete-detail', { athleteId: 'demo' })
    })
  }

  // Stands in for the Supabase round trip every real screen makes, so the
  // async-race guard below is genuinely exercised rather than just written.
  await new Promise(r => setTimeout(r, 120))
  if (!nav.isCurrent(token)) return

  demoTimer = setInterval(function() { /* stand-in for a real screen's polling */ }, 30000)
}

export function unmount() {
  clearInterval(demoTimer)
  demoTimer = null
}
