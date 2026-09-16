// ==========================================================================
// FORMS LIBRARY — screen
// Converted from the repo-root forms.js + the .dashboard block of
// forms.html. The query, the card markup and the delete/create flows are
// unchanged; what changed is the shape around them:
//
//   - the session check at the top is gone (the bootstrap does it once)
//   - top-level document.getElementById calls move inside mount(), because
//     this module is now imported before its markup exists
//   - the document-level click listener that closes kebab dropdowns is
//     registered in mount() and REMOVED in unmount() - left attached, it
//     would accumulate one copy per visit for the life of the app
//   - window.location.href = 'form-builder.html?id=X' becomes a route call
//   - every await is followed by an isCurrent(token) check before the DOM
//     is touched again
//
// See screens/_placeholder.js for the full contract.
// ==========================================================================
import { supabase } from '../../coachClient.js'
import * as nav from '../nav.js'
import { go } from '../router.js'
import { coachId } from '../session.js'

const TEMPLATE = `
  <div class="dashboard-header">
    <h2>Forms</h2>
    <button class="btn-add" id="newFormBtn">+ New Form</button>
  </div>
  <p class="screen-subtitle">Build a questionnaire once, then assign it to any athlete's calendar day — same "+" popup you already use for a workout.</p>
  <div class="athlete-grid" id="formGrid"></div>

  <!-- New Form Modal: just a name - questions get built on the Form
       Builder screen this routes to afterwards. Lives inside the screen
       rather than the shell, so it is torn down with the screen. -->
  <div class="modal-overlay" id="newFormModal">
    <div class="modal">
      <h2>New Form</h2>
      <div class="form-group">
        <label>Name</label>
        <input type="text" id="newFormName" placeholder="e.g. Daily Readiness Check" />
      </div>
      <div class="form-actions">
        <button class="btn-cancel" id="cancelNewFormBtn" data-modal-dismiss>Cancel</button>
        <button class="btn-save" id="saveNewFormBtn">Create &amp; Edit</button>
      </div>
    </div>
  </div>
`

const SKELETON = `
  <div class="dashboard-header">
    <h2>Forms</h2>
  </div>
  <div class="athlete-grid">
    ${'<div class="skeleton-bar" style="height:132px"></div>'.repeat(4)}
  </div>
`

let root = null
let allForms = []
let onDocClick = null

export async function mount(container, params, token) {
  root = container
  container.innerHTML = SKELETON

  const { data, error } = await window.fetchWithRetry((signal) => supabase
    .from('forms')
    .select('*, form_questions(id)')
    .order('name')
    .abortSignal(signal)
  )
  if (!nav.isCurrent(token)) return

  if (error) {
    console.log('Error loading forms:', error)
    container.innerHTML = `
      <div class="screen-message">
        <h2>Couldn't load your forms</h2>
        <p>Check your connection and try again.</p>
      </div>`
    return
  }

  allForms = data || []
  container.innerHTML = TEMPLATE
  bindEvents()
  renderFormGrid()
}

export function unmount() {
  // The multi-page site could leave this attached because the whole
  // document went away on every navigation. Here it must be removed by
  // hand, or every visit to this screen adds another live listener.
  if (onDocClick) document.removeEventListener('click', onDocClick)
  onDocClick = null
  root = null
  allForms = []
}

function bindEvents() {
  onDocClick = function() {
    root?.querySelectorAll('#formGrid .kebab-dropdown.active').forEach(d => d.classList.remove('active'))
  }
  document.addEventListener('click', onDocClick)

  root.querySelector('#newFormBtn').addEventListener('click', function() {
    root.querySelector('#newFormName').value = ''
    root.querySelector('#newFormModal').classList.add('active')
  })

  root.querySelector('#cancelNewFormBtn').addEventListener('click', function() {
    root.querySelector('#newFormModal').classList.remove('active')
  })

  root.querySelector('#saveNewFormBtn').addEventListener('click', async function() {
    const name = root.querySelector('#newFormName').value.trim()
    if (!name) { customAlert('Please enter a name'); return }

    const { data, error } = await supabase
      .from('forms')
      .insert([{ coach_id: coachId(), name }])
      .select()

    if (error) {
      console.log('Error creating form:', error)
      customAlert('Something went wrong')
      return
    }

    go('form-builder', { id: data[0].id })
  })
}

function renderFormGrid() {
  const grid = root.querySelector('#formGrid')
  grid.innerHTML = ''

  if (allForms.length === 0) {
    grid.innerHTML = '<p>No forms yet — create your first one!</p>'
    return
  }

  allForms.forEach(form => grid.appendChild(createFormCard(form)))
}

function createFormCard(form) {
  const questionCount = form.form_questions.length

  const card = document.createElement('div')
  card.classList.add('athlete-card')
  card.innerHTML = `
    <div class="card-top">
      <div class="athlete-initials"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"></path><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path></svg></div>
      <div class="kebab-menu">
        <button class="kebab-btn" data-id="${form.id}">⋮</button>
        <div class="kebab-dropdown" id="dropdown-${form.id}">
          <button class="kebab-delete" data-id="${form.id}">Delete form</button>
        </div>
      </div>
    </div>
    <h3>${form.name}</h3>
    <p>${questionCount} question${questionCount === 1 ? '' : 's'}</p>
    ${form.gate_workout ? '<span class="workout-type-badge workout-type-badge-run">Gates that day\'s workout</span>' : ''}
  `

  card.addEventListener('click', function(e) {
    if (e.target.closest('.kebab-menu')) return
    go('form-builder', { id: form.id })
  })

  card.querySelector('.kebab-btn').addEventListener('click', function(e) {
    e.stopPropagation()
    card.querySelector(`#dropdown-${form.id}`).classList.toggle('active')
  })

  card.querySelector('.kebab-delete').addEventListener('click', async function(e) {
    e.stopPropagation()
    if (!(await customConfirm(`Delete "${form.name}"? This cannot be undone.`))) return

    const { error } = await supabase.from('forms').delete().eq('id', form.id)
    if (error) {
      console.log('Error deleting form:', error)
      customAlert('Something went wrong')
      return
    }

    // Drop it locally and repaint rather than re-querying - the row is
    // gone, and a round trip here would show a stale grid for as long as
    // it takes to come back.
    allForms = allForms.filter(f => f.id !== form.id)
    renderFormGrid()
  })

  return card
}
