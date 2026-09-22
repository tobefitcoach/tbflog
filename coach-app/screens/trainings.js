// ==========================================================================
// WORKOUT LIBRARY — screen
// Converted from the repo-root trainings.js + the .dashboard block of
// trainings.html. Lists the coach's reusable single-day workouts, with
// label filtering, workout-type filtering, search, duplicate and
// per-workout label management.
//
// This screen registers TWO document-level click listeners (one closes the
// kebab dropdowns, one closes the label-filter dropdown). Both are tracked
// and removed in unmount() - on the multi-page site the whole document went
// away on every navigation, so leaving them attached cost nothing; here
// they would accumulate one pair per visit for the life of the app.
// ==========================================================================
import { supabase } from '../../coachClient.js'
import * as nav from '../nav.js'
import { go } from '../router.js'
import { coachId } from '../session.js'

const WORKOUT_TYPE_LABELS = { gym: 'Gym', field: 'Field', run: 'Run' }

const TEMPLATE = `
  <div class="dashboard-header">
    <h2>Workout Library</h2>
    <div class="header-actions-row">
      <div class="label-filter" id="labelFilter" style="margin-bottom:0">
        <button type="button" class="btn-profile-action" id="labelFilterBtn"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="btn-inline-icon"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"></path><line x1="7" y1="7" x2="7.01" y2="7"></line></svg>Filter by Label</button>
        <div class="label-filter-dropdown" id="labelFilterDropdown">
          <div class="entries-modal-body" id="labelFilterList"></div>
          <div class="label-filter-new">
            <input type="text" id="newLabelInput" placeholder="New label name..." maxlength="40" />
            <button type="button" id="addLabelBtn">+ Add</button>
          </div>
        </div>
      </div>
      <button class="btn-add" id="newTrainingBtn">+ New Workout</button>
    </div>
  </div>
  <p class="screen-subtitle" style="margin-bottom:16px">A workout is a flat list of exercises — build once, then drop it onto any athlete's calendar.</p>
  <input type="text" id="trainingSearchInput" class="exercise-search-input" placeholder="Search workouts..." style="margin-bottom:10px" />
  <div class="filter-chips-row">
    <div class="chip-row" id="trainingTypeFilterChips"></div>
  </div>
  <div class="athlete-grid" id="trainingGrid"></div>

  <div class="modal-overlay" id="newTrainingModal">
    <div class="modal">
      <h2>New Workout</h2>
      <div class="form-group">
        <label>Name</label>
        <input type="text" id="newTrainingName" placeholder="e.g. Leg Day" />
      </div>
      <div class="form-actions">
        <button class="btn-cancel" id="cancelNewTrainingBtn" data-modal-dismiss>Cancel</button>
        <button class="btn-save" id="saveNewTrainingBtn">Create &amp; Edit</button>
      </div>
    </div>
  </div>

  <div class="modal-overlay" id="duplicateTrainingModal">
    <div class="modal">
      <h2>Duplicate Workout</h2>
      <div class="form-group">
        <label>Name</label>
        <input type="text" id="duplicateTrainingName" placeholder="e.g. Leg Day (Copy)" />
      </div>
      <div class="form-actions">
        <button class="btn-cancel" id="cancelDuplicateTrainingBtn" data-modal-dismiss>Cancel</button>
        <button class="btn-save" id="saveDuplicateTrainingBtn">Duplicate &amp; Edit</button>
      </div>
    </div>
  </div>

  <div class="modal-overlay" id="manageLabelsModal">
    <div class="modal">
      <h2>Manage Labels</h2>
      <p class="modal-subtitle" id="manageLabelsTrainingName"></p>
      <div class="entries-modal-body" id="manageLabelsList"></div>
      <div class="label-filter-new">
        <input type="text" id="manageLabelsNewInput" placeholder="New label name..." maxlength="40" />
        <button type="button" id="manageLabelsAddBtn">+ Add</button>
      </div>
      <div class="form-actions">
        <button class="btn-cancel" id="closeManageLabelsBtn" data-modal-dismiss>Close</button>
      </div>
    </div>
  </div>
`

const SKELETON = `
  <div class="dashboard-header"><h2>Workout Library</h2></div>
  <div class="athlete-grid">
    ${'<div class="skeleton-bar" style="height:150px"></div>'.repeat(4)}
  </div>
`

let root = null
let allTrainings = []
let allLabels = []
let labelLinksByTraining = {} // training_id -> Set of label_id
let selectedLabelFilterIds = new Set()
let selectedTypeFilters = new Set()
let trainingSearchText = ''
let manageLabelsTrainingId = null
let duplicateSourceTrainingId = null
let onDocClickKebab = null
let onDocClickFilter = null

export async function mount(container, params, token) {
  root = container
  container.innerHTML = SKELETON
  const ok = await loadTrainings(token)
  if (!ok) return

  container.innerHTML = TEMPLATE
  bindEvents()
  renderLabelFilterList()
  renderTypeFilterChips()
  applyFilters()
}

export function unmount() {
  if (onDocClickKebab) document.removeEventListener('click', onDocClickKebab)
  if (onDocClickFilter) document.removeEventListener('click', onDocClickFilter)
  onDocClickKebab = null
  onDocClickFilter = null
  root = null
  allTrainings = []
  allLabels = []
  labelLinksByTraining = {}
  selectedLabelFilterIds = new Set()
  selectedTypeFilters = new Set()
  trainingSearchText = ''
  manageLabelsTrainingId = null
  duplicateSourceTrainingId = null
}

// Returns false if the screen should stop (error, or navigated away mid-load).
async function loadTrainings(token) {
  const [
    { data: trainingsData, error: trainingsError },
    { data: labelsData },
    { data: labelLinksData }
  ] = await Promise.all([
    window.fetchWithRetry((signal) => supabase.from('trainings').select('*, training_exercises(id)').order('updated_at', { ascending: false }).abortSignal(signal)),
    window.fetchWithRetry((signal) => supabase.from('training_labels').select('*').order('name').abortSignal(signal), 1),
    window.fetchWithRetry((signal) => supabase.from('training_label_links').select('*').abortSignal(signal), 1)
  ])
  if (token !== undefined && !nav.isCurrent(token)) return false

  if (trainingsError) {
    console.log('Error loading trainings:', trainingsError)
    if (root) root.innerHTML = `
      <div class="screen-message">
        <h2>Couldn't load your workouts</h2>
        <p>Check your connection and try again.</p>
      </div>`
    return false
  }

  allTrainings = trainingsData || []
  allLabels = labelsData || []
  labelLinksByTraining = {}
  for (const row of (labelLinksData || [])) {
    (labelLinksByTraining[row.training_id] ||= new Set()).add(row.label_id)
  }
  return true
}

// Re-reads from the server and repaints, for the flows that change label
// rows underneath the grid. Deliberately keeps the current filter/search.
async function reloadAndRepaint() {
  if (!(await loadTrainings())) return
  if (!root) return
  renderLabelFilterList()
  applyFilters()
}

function bindEvents() {
  onDocClickKebab = function() {
    root?.querySelectorAll('#trainingGrid .kebab-dropdown.active').forEach(d => d.classList.remove('active'))
  }
  document.addEventListener('click', onDocClickKebab)

  onDocClickFilter = function(e) {
    if (!e.target.closest('#labelFilter')) root?.querySelector('#labelFilterDropdown')?.classList.remove('active')
  }
  document.addEventListener('click', onDocClickFilter)

  root.querySelector('#trainingSearchInput').addEventListener('input', function() {
    trainingSearchText = this.value
    applyFilters()
  })

  root.querySelector('#trainingTypeFilterChips').addEventListener('click', function(e) {
    const btn = e.target.closest('.chip-btn')
    if (!btn) return
    const type = btn.dataset.type
    if (selectedTypeFilters.has(type)) selectedTypeFilters.delete(type)
    else selectedTypeFilters.add(type)
    btn.classList.toggle('selected')
    applyFilters()
  })

  root.querySelector('#labelFilterBtn').addEventListener('click', function(e) {
    e.stopPropagation()
    root.querySelector('#labelFilterDropdown').classList.toggle('active')
  })

  root.querySelector('#addLabelBtn').addEventListener('click', function() {
    const input = root.querySelector('#newLabelInput')
    addLabel(input.value)
    input.value = ''
  })

  root.querySelector('#newLabelInput').addEventListener('keydown', function(e) {
    if (e.key !== 'Enter') return
    addLabel(this.value)
    this.value = ''
  })

  root.querySelector('#manageLabelsAddBtn').addEventListener('click', function() {
    const input = root.querySelector('#manageLabelsNewInput')
    addLabel(input.value, manageLabelsTrainingId)
    input.value = ''
  })

  root.querySelector('#manageLabelsNewInput').addEventListener('keydown', function(e) {
    if (e.key !== 'Enter') return
    addLabel(this.value, manageLabelsTrainingId)
    this.value = ''
  })

  root.querySelector('#closeManageLabelsBtn').addEventListener('click', function() {
    root.querySelector('#manageLabelsModal').classList.remove('active')
  })

  root.querySelector('#newTrainingBtn').addEventListener('click', function() {
    root.querySelector('#newTrainingName').value = ''
    root.querySelector('#newTrainingModal').classList.add('active')
  })

  root.querySelector('#cancelNewTrainingBtn').addEventListener('click', function() {
    root.querySelector('#newTrainingModal').classList.remove('active')
  })

  root.querySelector('#saveNewTrainingBtn').addEventListener('click', onCreateTraining)

  root.querySelector('#cancelDuplicateTrainingBtn').addEventListener('click', function() {
    root.querySelector('#duplicateTrainingModal').classList.remove('active')
  })

  root.querySelector('#saveDuplicateTrainingBtn').addEventListener('click', onDuplicateTraining)
}

// Fixed 3-value enum (WORKOUT_TYPE_LABELS), unlike the label filter's
// open-ended list - always shows all 3 chips regardless of what's
// currently in the library, same reasoning athletes.js uses for its
// Active/Pending/Offline/Archived status chips.
function renderTypeFilterChips() {
  root.querySelector('#trainingTypeFilterChips').innerHTML = Object.entries(WORKOUT_TYPE_LABELS).map(([type, label]) =>
    `<button type="button" class="chip-btn ${selectedTypeFilters.has(type) ? 'selected' : ''}" data-type="${type}">${label}</button>`
  ).join('')
}

function applyFilters() {
  const grid = root.querySelector('#trainingGrid')
  let filtered = selectedLabelFilterIds.size === 0
    ? allTrainings
    : allTrainings.filter(t => [...selectedLabelFilterIds].some(id => labelLinksByTraining[t.id]?.has(id)))

  if (selectedTypeFilters.size > 0) {
    filtered = filtered.filter(t => selectedTypeFilters.has(t.workout_type || 'gym'))
  }

  const search = trainingSearchText.trim().toLowerCase()
  if (search) filtered = filtered.filter(t => t.name.toLowerCase().includes(search))

  grid.innerHTML = ''

  if (allTrainings.length === 0) {
    grid.innerHTML = '<p>No workouts yet — create your first one!</p>'
    return
  }
  if (filtered.length === 0) {
    grid.innerHTML = '<p>No workouts match your filters.</p>'
    return
  }

  filtered.forEach(t => grid.appendChild(createTrainingCard(t)))
}

function createTrainingCard(training) {
  const exerciseCount = training.training_exercises.length
  const trainingLabelIds = labelLinksByTraining[training.id] || new Set()
  const labelTagsHtml = allLabels.filter(l => trainingLabelIds.has(l.id)).map(l => `<span class="label-tag">${l.name}</span>`).join('')

  const card = document.createElement('div')
  card.classList.add('athlete-card')
  card.innerHTML = `
    <div class="card-top">
      <div class="athlete-initials"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="4" cy="12" r="2"></circle><circle cx="20" cy="12" r="2"></circle><line x1="6" y1="12" x2="18" y2="12"></line><line x1="9" y1="8" x2="9" y2="16"></line><line x1="15" y1="8" x2="15" y2="16"></line></svg></div>
      <div class="kebab-menu">
        <button class="kebab-btn" data-id="${training.id}">⋮</button>
        <div class="kebab-dropdown" id="dropdown-${training.id}">
          <button class="kebab-item kebab-duplicate" data-id="${training.id}">Duplicate</button>
          <button class="kebab-item kebab-manage-labels" data-id="${training.id}">Manage Labels</button>
          <button class="kebab-delete" data-id="${training.id}">Delete workout</button>
        </div>
      </div>
    </div>
    <h3>${training.name}</h3>
    <span class="workout-type-badge workout-type-badge-${training.workout_type || 'gym'}">${WORKOUT_TYPE_LABELS[training.workout_type || 'gym']}</span>
    <p>${exerciseCount} exercise${exerciseCount === 1 ? '' : 's'}</p>
    ${labelTagsHtml}
  `

  card.addEventListener('click', function(e) {
    if (e.target.closest('.kebab-menu')) return
    go('training-builder', { id: training.id })
  })

  card.querySelector('.kebab-btn').addEventListener('click', function(e) {
    e.stopPropagation()
    card.querySelector(`#dropdown-${training.id}`).classList.toggle('active')
  })

  card.querySelector('.kebab-duplicate').addEventListener('click', function(e) {
    e.stopPropagation()
    duplicateSourceTrainingId = training.id
    root.querySelector('#duplicateTrainingName').value = `${training.name} (Copy)`
    root.querySelector('#duplicateTrainingModal').classList.add('active')
  })

  card.querySelector('.kebab-manage-labels').addEventListener('click', function(e) {
    e.stopPropagation()
    manageLabelsTrainingId = training.id
    root.querySelector('#manageLabelsTrainingName').textContent = training.name
    renderManageLabelsList()
    root.querySelector('#manageLabelsModal').classList.add('active')
  })

  card.querySelector('.kebab-delete').addEventListener('click', async function(e) {
    e.stopPropagation()

    // Blocked ahead of the confirm (not just left to the database's own FK
    // constraint) so the coach gets a real count and a next step, instead
    // of a raw "foreign key violation" if they'd already said yes to
    // deleting. See the LIVE-LINKED WORKOUTS block in sql-history.sql -
    // source_training_id is non-null on a day for exactly as long as it's
    // still tracking this Training.
    const { count, error: countError } = await supabase
      .from('program_days')
      .select('id', { count: 'exact', head: true })
      .eq('source_training_id', training.id)
    if (countError) { console.log(countError); customAlert('Something went wrong'); return }
    if (count > 0) {
      customAlert(`"${training.name}" is still live-linked to ${count} day${count === 1 ? '' : 's'} (on a calendar, or in a Program template) - editing it is still reaching those days. Start them (or hand-edit that specific day) to detach it first, then delete this workout.`)
      return
    }

    if (!(await customConfirm(`Delete "${training.name}"? This cannot be undone.`))) return

    const { error } = await supabase.from('trainings').delete().eq('id', training.id)
    if (error) {
      console.log('Error deleting training:', error)
      customAlert('Something went wrong')
      return
    }

    allTrainings = allTrainings.filter(t => t.id !== training.id)
    renderLabelFilterList()
    applyFilters()
  })

  return card
}

// ==========================================================================
// LABELS
// The "Filter by Label" dropdown filters the grid to workouts with ANY of
// the checked labels; each card's kebab has its own "Manage Labels" modal
// for tagging one workout. Both share the state loaded above.
// ==========================================================================
function renderLabelFilterList() {
  const list = root.querySelector('#labelFilterList')
  if (allLabels.length === 0) {
    list.innerHTML = '<p class="label-filter-empty">No labels yet - add one below.</p>'
    return
  }
  list.innerHTML = allLabels.map(label => {
    const count = allTrainings.filter(t => labelLinksByTraining[t.id]?.has(label.id)).length
    const checked = selectedLabelFilterIds.has(label.id) ? 'checked' : ''
    return `
      <div class="label-filter-row">
        <label>
          <input type="checkbox" data-label-id="${label.id}" ${checked}>
          <span>${label.name} (${count})</span>
        </label>
        <button type="button" class="label-row-delete" data-label-id="${label.id}" title="Delete label">✕</button>
      </div>
    `
  }).join('')

  list.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', function() {
      if (cb.checked) selectedLabelFilterIds.add(cb.dataset.labelId)
      else selectedLabelFilterIds.delete(cb.dataset.labelId)
      applyFilters()
    })
  })

  list.querySelectorAll('.label-row-delete').forEach(btn => {
    btn.addEventListener('click', async function() {
      if (!(await customConfirm('Delete this label? It will be removed from every workout.'))) return
      const { error } = await supabase.from('training_labels').delete().eq('id', btn.dataset.labelId)
      if (error) {
        console.log('Error deleting label:', error)
        customAlert('Something went wrong deleting that label')
        return
      }
      selectedLabelFilterIds.delete(btn.dataset.labelId)
      await reloadAndRepaint()
    })
  })
}

// Creates a label, optionally linking it straight to one workout (used by
// the Manage Labels modal, so creating a label there tags it onto that
// workout immediately instead of as a separate second step).
async function addLabel(name, linkToTrainingId) {
  name = name.trim()
  if (!name) return
  const { data, error } = await supabase.from('training_labels').insert([{ name, coach_id: coachId() }]).select().single()
  if (error) {
    console.log('Error adding label:', error)
    customAlert('Something went wrong adding that label')
    return
  }
  if (linkToTrainingId) {
    await supabase.from('training_label_links').insert([{ training_id: linkToTrainingId, label_id: data.id }])
  }
  await reloadAndRepaint()
  if (linkToTrainingId && root) renderManageLabelsList()
}

function renderManageLabelsList() {
  const list = root.querySelector('#manageLabelsList')
  const trainingLabelIds = labelLinksByTraining[manageLabelsTrainingId] || new Set()

  if (allLabels.length === 0) {
    list.innerHTML = '<p class="label-filter-empty">No labels yet - add one below.</p>'
    return
  }
  list.innerHTML = allLabels.map(label => `
    <label class="message-recipient-row">
      <input type="checkbox" data-label-id="${label.id}" ${trainingLabelIds.has(label.id) ? 'checked' : ''}>
      <span>${label.name}</span>
    </label>
  `).join('')

  list.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', function() {
      toggleTrainingLabel(manageLabelsTrainingId, cb.dataset.labelId, cb.checked)
    })
  })
}

async function toggleTrainingLabel(trainingId, labelId, checked) {
  const { error } = checked
    ? await supabase.from('training_label_links').insert([{ training_id: trainingId, label_id: labelId }])
    : await supabase.from('training_label_links').delete().eq('training_id', trainingId).eq('label_id', labelId)

  if (error) {
    console.log('Error updating workout label:', error)
    customAlert('Something went wrong')
    return
  }

  (labelLinksByTraining[trainingId] ||= new Set())[checked ? 'add' : 'delete'](labelId)
  renderLabelFilterList()
  applyFilters()
}

// ==========================================================================
// CREATE / DUPLICATE
// ==========================================================================
async function onCreateTraining() {
  const name = root.querySelector('#newTrainingName').value.trim()
  if (!name) { customAlert('Please enter a name'); return }

  const { data, error } = await supabase
    .from('trainings')
    .insert([{ coach_id: coachId(), name }])
    .select()

  if (error) {
    console.log('Error creating training:', error)
    customAlert('Something went wrong')
    return
  }

  go('training-builder', { id: data[0].id })
}

// Clones the source workout's own row plus every one of its exercises,
// with fresh superset/section-instance ids, then jumps straight into the
// builder for the new copy - the same "land in the editor" feel as
// creating a brand new workout.
async function onDuplicateTraining() {
  const btn = root.querySelector('#saveDuplicateTrainingBtn')
  const name = root.querySelector('#duplicateTrainingName').value.trim()
  if (!name) { customAlert('Please enter a name'); return }

  const sourceTraining = allTrainings.find(t => t.id === duplicateSourceTrainingId)
  btn.disabled = true
  btn.textContent = 'Duplicating...'
  const fail = function(msg, err) {
    console.log(msg, err)
    customAlert('Something went wrong')
    btn.disabled = false
    btn.textContent = 'Duplicate & Edit'
  }

  const { data: sourceExercises, error: sourceError } = await supabase
    .from('training_exercises')
    .select('*')
    .eq('training_id', duplicateSourceTrainingId)
  if (sourceError) return fail('Error loading source exercises:', sourceError)

  const { data: newTraining, error: insertTrainingError } = await supabase
    .from('trainings')
    .insert([{ coach_id: coachId(), name, workout_type: sourceTraining.workout_type }])
    .select()
    .single()
  if (insertTrainingError) return fail('Error creating duplicate:', insertTrainingError)

  sourceExercises.sort((a, b) => a.order_index - b.order_index)

  if (sourceExercises.length > 0) {
    const groupIdMap = {}
    const sectionInstanceMap = {}
    for (const te of sourceExercises) {
      if (te.superset_group_id && !groupIdMap[te.superset_group_id]) groupIdMap[te.superset_group_id] = crypto.randomUUID()
      if (te.section_instance_id && !sectionInstanceMap[te.section_instance_id]) sectionInstanceMap[te.section_instance_id] = crypto.randomUUID()
    }

    const { error: insertExercisesError } = await supabase.from('training_exercises').insert(
      sourceExercises.map(te => ({
        training_id: newTraining.id, exercise_id: te.exercise_id, order_index: te.order_index,
        prescribed_sets: te.prescribed_sets, prescribed_reps: te.prescribed_reps,
        prescribed_weight: te.prescribed_weight, rest_seconds: te.rest_seconds,
        extra_fields: te.extra_fields, set_targets: te.set_targets, notes: te.notes,
        section_label: te.section_label,
        section_instance_id: te.section_instance_id ? sectionInstanceMap[te.section_instance_id] : null,
        superset_group_id: te.superset_group_id ? groupIdMap[te.superset_group_id] : null,
        tracks_weight_override: te.tracks_weight_override,
        is_timed_override: te.is_timed_override,
        is_unilateral_override: te.is_unilateral_override,
        tracks_distance_override: te.tracks_distance_override,
        alternative_exercise_id: te.alternative_exercise_id
      }))
    )

    if (insertExercisesError) {
      console.log('Error copying exercises:', insertExercisesError)
      customAlert('Workout was duplicated but something went wrong copying its exercises')
      go('training-builder', { id: newTraining.id })
      return
    }
  }

  go('training-builder', { id: newTraining.id })
}
