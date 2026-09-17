// ==========================================================================
// TRAINING BUILDER — screen
// Wraps the unchanged repo-root training-builder.html in a full-bleed
// iframe overlay, reached by tapping a workout in the Workout Library
// (trainings.js's go('training-builder', { id })) or creating/duplicating
// one there. Same .modal-overlay/.modal-large/.training-builder-frame
// markup athlete-calendar.js and program-builder.js already use to embed
// this page (?id=, &embed=1) - proven to size correctly, so this screen
// reuses it as-is rather than inventing new layout CSS.
//
// training-builder.html/.js is deliberately NOT converted (see the plan) -
// it stays exactly as it is at the repo root. This screen is just the
// route-level wrapper the Workout Library needed that the calendar/program
// overlays didn't: those open it ON TOP of an already-mounted screen, this
// IS the screen, so "Done" calls nav.back() (pop to the Workout Library)
// instead of just hiding a modal class.
// ==========================================================================
import * as nav from '../nav.js'

const TEMPLATE = `
  <div class="modal-overlay active" style="position:static; width:auto; height:auto; background:none; padding:0;">
    <div class="modal modal-large" style="max-width:none; width:100%;">
      <div class="graph-modal-header">
        <button class="btn-back" id="trainingBuilderRouteBackBtn" aria-label="Back">←</button>
        <h2>Workout Builder</h2>
      </div>
      <iframe id="trainingBuilderRouteFrame" class="training-builder-frame" src="about:blank"></iframe>
    </div>
  </div>
`

let root = null

export async function mount(container, params, token) {
  root = container
  root.innerHTML = TEMPLATE

  root.querySelector('#trainingBuilderRouteBackBtn').addEventListener('click', function() {
    nav.back()
  })

  root.querySelector('#trainingBuilderRouteFrame').src = `../training-builder.html?id=${params.id}&embed=1`
}

export function unmount() {
  // Drop the iframe back to about:blank rather than just discarding the
  // element - training-builder.js may hold pending timers/listeners of its
  // own inside that document, and leaving it pointed at a real URL keeps
  // that whole document (and its Supabase realtime, if any) alive in
  // memory until GC gets to it.
  const frame = root?.querySelector('#trainingBuilderRouteFrame')
  if (frame) frame.src = 'about:blank'
  root = null
}
