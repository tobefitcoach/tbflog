// ==========================================================================
// TRAINING LIBRARY
// Lists the coach's reusable single-day trainings (trainings + nested
// training_exercises). Mirrors programs.js's list-page pattern, just for
// the flat "trainings" table instead of the multi-week "programs" table.
// ==========================================================================
import { supabase } from './coachClient.js'

const WORKOUT_TYPE_LABELS = { gym: 'Gym', field: 'Field', run: 'Run' }

const { data: { session } } = await supabase.auth.getSession()
if (!session) {
  window.location.href = 'login.html'
} else {
  loadTrainings()
}

// Coach-created labels (e.g. "Inseason 2026") + which workouts have which -
// same shape as script.js's athlete labels, just linked to trainings
// instead of athletes. See the "Filter by Label" dropdown and each card's
// "Manage Labels" kebab item.
let allTrainings = []
let allLabels = []
let labelLinksByTraining = {} // training_id -> Set of label_id
let selectedLabelFilterIds = new Set()

// ==========================================================================
// ---- LOAD TRAININGS ----
// ==========================================================================
async function loadTrainings() {
  const [
    { data: trainingsData, error: trainingsError },
    { data: labelsData },
    { data: labelLinksData }
  ] = await Promise.all([
    fetchWithRetry((signal) => supabase.from('trainings').select('*, training_exercises(id)').order('updated_at', { ascending: false }).abortSignal(signal)),
    fetchWithRetry((signal) => supabase.from('training_labels').select('*').order('name').abortSignal(signal), 1),
    fetchWithRetry((signal) => supabase.from('training_label_links').select('*').abortSignal(signal), 1)
  ])

  if (trainingsError) {
    console.log('Error loading trainings:', trainingsError)
    customAlert('Something went wrong loading your workouts - check your connection and try again')
    return
  }

  allTrainings = trainingsData
  allLabels = labelsData || []
  labelLinksByTraining = {}
  for (const row of (labelLinksData || [])) {
    (labelLinksByTraining[row.training_id] ||= new Set()).add(row.label_id)
  }

  renderLabelFilterList()
  applyLabelFilter()
}

function applyLabelFilter() {
  const grid = document.getElementById('trainingGrid')
  const filtered = selectedLabelFilterIds.size === 0
    ? allTrainings
    : allTrainings.filter(t => [...selectedLabelFilterIds].some(id => labelLinksByTraining[t.id]?.has(id)))

  grid.innerHTML = ''

  if (allTrainings.length === 0) {
    grid.innerHTML = '<p>No workouts yet — create your first one!</p>'
    return
  }
  if (filtered.length === 0) {
    grid.innerHTML = '<p>No workouts match that label.</p>'
    return
  }

  filtered.forEach(createTrainingCard)
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
    window.location.href = `training-builder.html?id=${training.id}`
  })

  card.querySelector('.kebab-btn').addEventListener('click', function(e) {
    e.stopPropagation()
    document.getElementById(`dropdown-${training.id}`).classList.toggle('active')
  })

  card.querySelector('.kebab-manage-labels').addEventListener('click', function(e) {
    e.stopPropagation()
    openManageLabelsModal(training.id, training.name)
  })

  card.querySelector('.kebab-delete').addEventListener('click', async function(e) {
    e.stopPropagation()
    if (!(await customConfirm(`Delete "${training.name}"? This cannot be undone.`))) return

    const { error } = await supabase
      .from('trainings')
      .delete()
      .eq('id', training.id)

    if (error) {
      console.log('Error deleting training:', error)
      customAlert('Something went wrong')
      return
    }

    loadTrainings()
  })

  document.getElementById('trainingGrid').appendChild(card)
}

// Outside click closes any open kebab dropdown (same pattern used
// everywhere else this app has one)
document.addEventListener('click', function() {
  document.querySelectorAll('#trainingGrid .kebab-dropdown.active').forEach(d => d.classList.remove('active'))
})

// ==========================================================================
// ---- LABELS ----
// "Filter by Label" dropdown (next to + New Workout) filters the grid to
// workouts with ANY of the checked labels; each card's kebab menu has its
// own "Manage Labels" modal for tagging/untagging that one workout. Both
// share the same allLabels/labelLinksByTraining state loaded above.
// ==========================================================================
const labelFilterBtn = document.getElementById('labelFilterBtn')
const labelFilterDropdown = document.getElementById('labelFilterDropdown')
const manageLabelsModal = document.getElementById('manageLabelsModal')
let manageLabelsTrainingId = null

function renderLabelFilterList() {
  const list = document.getElementById('labelFilterList')
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
      applyLabelFilter()
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
      await loadTrainings()
    })
  })
}

// Creates a label, optionally linking it straight to one workout (used by
// the Manage Labels modal, so creating a new label there tags it onto that
// workout immediately instead of a separate second step)
async function addLabel(name, linkToTrainingId) {
  name = name.trim()
  if (!name) return
  const { data, error } = await supabase.from('training_labels').insert([{ name, coach_id: session.user.id }]).select().single()
  if (error) {
    console.log('Error adding label:', error)
    customAlert('Something went wrong adding that label')
    return
  }
  if (linkToTrainingId) {
    await supabase.from('training_label_links').insert([{ training_id: linkToTrainingId, label_id: data.id }])
  }
  await loadTrainings()
  if (linkToTrainingId) renderManageLabelsList()
}

labelFilterBtn.addEventListener('click', function(e) {
  e.stopPropagation()
  labelFilterDropdown.classList.toggle('active')
})

document.getElementById('addLabelBtn').addEventListener('click', function() {
  const input = document.getElementById('newLabelInput')
  addLabel(input.value)
  input.value = ''
})

document.getElementById('newLabelInput').addEventListener('keydown', function(e) {
  if (e.key !== 'Enter') return
  addLabel(this.value)
  this.value = ''
})

// Outside click closes the label filter dropdown (same pattern as the kebab dropdowns)
document.addEventListener('click', function(e) {
  if (!e.target.closest('#labelFilter')) labelFilterDropdown.classList.remove('active')
})

// ---- Manage Labels modal (per-workout tagging) ----
function openManageLabelsModal(trainingId, trainingName) {
  manageLabelsTrainingId = trainingId
  document.getElementById('manageLabelsTrainingName').textContent = trainingName
  renderManageLabelsList()
  manageLabelsModal.classList.add('active')
}

function renderManageLabelsList() {
  const list = document.getElementById('manageLabelsList')
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
  applyLabelFilter()
}

document.getElementById('manageLabelsAddBtn').addEventListener('click', function() {
  const input = document.getElementById('manageLabelsNewInput')
  addLabel(input.value, manageLabelsTrainingId)
  input.value = ''
})

document.getElementById('manageLabelsNewInput').addEventListener('keydown', function(e) {
  if (e.key !== 'Enter') return
  addLabel(this.value, manageLabelsTrainingId)
  this.value = ''
})

document.getElementById('closeManageLabelsBtn').addEventListener('click', function() {
  manageLabelsModal.classList.remove('active')
})

// ==========================================================================
// ---- NEW TRAINING MODAL ----
// ==========================================================================
document.getElementById('newTrainingBtn').addEventListener('click', function() {
  document.getElementById('newTrainingName').value = ''
  document.getElementById('newTrainingModal').classList.add('active')
})

document.getElementById('cancelNewTrainingBtn').addEventListener('click', function() {
  document.getElementById('newTrainingModal').classList.remove('active')
})

document.getElementById('saveNewTrainingBtn').addEventListener('click', async function() {
  const name = document.getElementById('newTrainingName').value.trim()
  if (!name) { customAlert('Please enter a name'); return }

  const { data, error } = await supabase
    .from('trainings')
    .insert([{ coach_id: session.user.id, name }])
    .select()

  if (error) {
    console.log('Error creating training:', error)
    customAlert('Something went wrong')
    return
  }

  window.location.href = `training-builder.html?id=${data[0].id}`
})
