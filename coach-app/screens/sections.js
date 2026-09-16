// ==========================================================================
// SECTION LIBRARY — screen
// Converted from the repo-root sections.js + the .dashboard block of
// sections.html. A section is a reusable group of exercises that gets
// pasted into workouts and program days (see the "+ Add Section" flows in
// the training/program builders).
//
// Same conversion as screens/forms.js, which this deliberately mirrors
// line-for-line where the originals did: the two list pages were written
// as near-copies of each other, and keeping them recognisably parallel is
// worth more than de-duplicating ~30 lines into a shared helper that would
// then have to carry both sets of table names, icons and copy.
// ==========================================================================
import { supabase } from '../../coachClient.js'
import * as nav from '../nav.js'
import { go } from '../router.js'
import { coachId } from '../session.js'

const TEMPLATE = `
  <div class="dashboard-header">
    <h2>Section Library</h2>
    <button class="btn-add" id="newSectionBtn">+ New Section</button>
  </div>
  <p class="screen-subtitle">A section is a reusable group of exercises (e.g. "Warm-up A") — build once, then drop it into any workout or program day.</p>
  <div class="athlete-grid" id="sectionGrid"></div>

  <div class="modal-overlay" id="newSectionModal">
    <div class="modal">
      <h2>New Section</h2>
      <div class="form-group">
        <label>Name</label>
        <input type="text" id="newSectionName" placeholder="e.g. Warm-up A" />
      </div>
      <div class="form-actions">
        <button class="btn-cancel" id="cancelNewSectionBtn" data-modal-dismiss>Cancel</button>
        <button class="btn-save" id="saveNewSectionBtn">Create &amp; Edit</button>
      </div>
    </div>
  </div>
`

const SKELETON = `
  <div class="dashboard-header"><h2>Section Library</h2></div>
  <div class="athlete-grid">
    ${'<div class="skeleton-bar" style="height:132px"></div>'.repeat(4)}
  </div>
`

let root = null
let allSections = []
let onDocClick = null

export async function mount(container, params, token) {
  root = container
  container.innerHTML = SKELETON

  const { data, error } = await window.fetchWithRetry((signal) => supabase
    .from('sections')
    .select('*, section_exercises(id)')
    .order('name')
    .abortSignal(signal)
  )
  if (!nav.isCurrent(token)) return

  if (error) {
    console.log('Error loading sections:', error)
    container.innerHTML = `
      <div class="screen-message">
        <h2>Couldn't load your sections</h2>
        <p>Check your connection and try again.</p>
      </div>`
    return
  }

  allSections = data || []
  container.innerHTML = TEMPLATE
  bindEvents()
  renderSectionGrid()
}

export function unmount() {
  if (onDocClick) document.removeEventListener('click', onDocClick)
  onDocClick = null
  root = null
  allSections = []
}

function bindEvents() {
  onDocClick = function() {
    root?.querySelectorAll('#sectionGrid .kebab-dropdown.active').forEach(d => d.classList.remove('active'))
  }
  document.addEventListener('click', onDocClick)

  root.querySelector('#newSectionBtn').addEventListener('click', function() {
    root.querySelector('#newSectionName').value = ''
    root.querySelector('#newSectionModal').classList.add('active')
  })

  root.querySelector('#cancelNewSectionBtn').addEventListener('click', function() {
    root.querySelector('#newSectionModal').classList.remove('active')
  })

  root.querySelector('#saveNewSectionBtn').addEventListener('click', async function() {
    const name = root.querySelector('#newSectionName').value.trim()
    if (!name) { customAlert('Please enter a name'); return }

    const { data, error } = await supabase
      .from('sections')
      .insert([{ coach_id: coachId(), name }])
      .select()

    if (error) {
      console.log('Error creating section:', error)
      customAlert('Something went wrong')
      return
    }

    go('section-builder', { id: data[0].id })
  })
}

function renderSectionGrid() {
  const grid = root.querySelector('#sectionGrid')
  grid.innerHTML = ''

  if (allSections.length === 0) {
    grid.innerHTML = '<p>No sections yet — create your first one!</p>'
    return
  }

  allSections.forEach(section => grid.appendChild(createSectionCard(section)))
}

function createSectionCard(section) {
  const exerciseCount = section.section_exercises.length

  const card = document.createElement('div')
  card.classList.add('athlete-card')
  card.innerHTML = `
    <div class="card-top">
      <div class="athlete-initials"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"></polygon><polyline points="2 17 12 22 22 17"></polyline><polyline points="2 12 12 17 22 12"></polyline></svg></div>
      <div class="kebab-menu">
        <button class="kebab-btn" data-id="${section.id}">⋮</button>
        <div class="kebab-dropdown" id="dropdown-${section.id}">
          <button class="kebab-delete" data-id="${section.id}">Delete section</button>
        </div>
      </div>
    </div>
    <h3>${section.name}</h3>
    <p>${exerciseCount} exercise${exerciseCount === 1 ? '' : 's'}</p>
  `

  card.addEventListener('click', function(e) {
    // The original checked two specific classes here; .closest is the same
    // intent but also survives a click landing on the SVG inside a button.
    if (e.target.closest('.kebab-menu')) return
    go('section-builder', { id: section.id })
  })

  card.querySelector('.kebab-btn').addEventListener('click', function(e) {
    e.stopPropagation()
    card.querySelector(`#dropdown-${section.id}`).classList.toggle('active')
  })

  card.querySelector('.kebab-delete').addEventListener('click', async function(e) {
    e.stopPropagation()
    if (!(await customConfirm(`Delete "${section.name}"? This cannot be undone.`))) return

    const { error } = await supabase.from('sections').delete().eq('id', section.id)
    if (error) {
      console.log('Error deleting section:', error)
      customAlert('Something went wrong')
      return
    }

    allSections = allSections.filter(s => s.id !== section.id)
    renderSectionGrid()
  })

  return card
}
