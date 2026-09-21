// ==========================================================================
// TRAINING BUILDER — screen
// Wraps the unchanged repo-root training-builder.html in a full-bleed
// iframe, reached by tapping a workout in the Workout Library
// (trainings.js's go('training-builder', { id })) or creating/duplicating
// one there. The calendar and program-builder overlays still embed the
// same page inside .modal-large - this screen used to as well, which put
// the builder in a padded, bordered box inside the page's own padding
// (a square in a square in a square). It now fills the space under the
// header directly, with just a slim back bar above it.
//
// training-builder.html/.js is deliberately NOT converted (see the plan) -
// it stays exactly as it is at the repo root. This screen is just the
// route-level wrapper the Workout Library needed that the calendar/program
// overlays didn't: those open it ON TOP of an already-mounted screen, this
// IS the screen, so back calls nav.back() (pop to the Workout Library)
// instead of just hiding a modal class.
// ==========================================================================
import * as nav from '../nav.js'
import { ensureCss } from '../lazy-css.js'

const TEMPLATE = `
  <div class="tb-route" id="trainingBuilderRoute">
    <div class="screen-header tb-route-bar">
      <button class="btn-back" id="trainingBuilderRouteBackBtn" aria-label="Back to Workout Library">←</button>
      <span class="tb-route-bar-label">Workout Library</span>
    </div>
    <iframe id="trainingBuilderRouteFrame" class="tb-route-frame" src="about:blank"></iframe>
  </div>
`

let root = null

// The iframe has to be exactly as tall as what's left under the sticky
// header, so the outer page never scrolls and the builder's own sticky side
// panels (inside the iframe) are what stay in frame. Measured instead of
// hard-coded: the header's height differs by safe-area inset and font
// scaling, and this has to hold on every monitor/window size the coach uses.
function sizeToViewport() {
  if (!root) return
  const header = document.querySelector('.coach-app-header')
  const headerH = header ? header.offsetHeight : 0
  const route = root.querySelector('#trainingBuilderRoute')
  if (route) route.style.setProperty('--tb-route-h', `${window.innerHeight - headerH}px`)
}

export async function mount(container, params, token) {
  root = container
  ensureCss('css/builders.css?v=3')
  root.innerHTML = TEMPLATE

  root.querySelector('#trainingBuilderRouteBackBtn').addEventListener('click', function() {
    nav.back()
  })

  sizeToViewport()
  window.addEventListener('resize', sizeToViewport)

  root.querySelector('#trainingBuilderRouteFrame').src = `../training-builder.html?id=${params.id}&embed=1`
}

export function unmount() {
  window.removeEventListener('resize', sizeToViewport)
  // Drop the iframe back to about:blank rather than just discarding the
  // element - training-builder.js may hold pending timers/listeners of its
  // own inside that document, and leaving it pointed at a real URL keeps
  // that whole document (and its Supabase realtime, if any) alive in
  // memory until GC gets to it.
  const frame = root?.querySelector('#trainingBuilderRouteFrame')
  if (frame) frame.src = 'about:blank'
  root = null
}
