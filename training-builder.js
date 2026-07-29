// ==========================================================================
// TRAINING BUILDER
// Edits one training's flat exercise list. Same picker/edit patterns as
// program-builder.js (pick-existing-or-create-new, type-aware duration vs
// weight fields, extra name/value fields), just without the week/day
// nesting - a training is always one flat session.
// ==========================================================================
import { supabase } from './coachClient.js'

const params = new URLSearchParams(window.location.search)
const trainingId = params.get('id')

// Loaded inside an iframe overlay (see athlete-calendar.js's "+ New
// Training" flow) - hide the page's own header/sidebar since the overlay
// already has its own title bar and Done button
if (params.get('embed') === '1') {
  document.getElementById('pageHeader').style.display = 'none'
  document.getElementById('pageSidebar').style.display = 'none'
}

let allExercises = []
let exercisesCache = [] // last-loaded training_exercises for this training
let currentEditTE = null // the training_exercises row currently open in the edit modal

const { data: { session } } = await supabase.auth.getSession()
if (!session) {
  window.location.href = 'login.html'
} else {
  loadTraining()
  loadExercisesList()
  loadAllExercises()
}

document.getElementById('logoutBtn').addEventListener('click', async function() {
  await supabase.auth.signOut()
  window.location.href = 'login.html'
})

// ==========================================================================
// ---- LOAD TRAINING NAME ----
// ==========================================================================
async function loadTraining() {
  const { data, error } = await supabase
    .from('trainings')
    .select('*')
    .eq('id', trainingId)
    .single()

  if (error) {
    console.log('Error loading training:', error)
    document.getElementById('trainingNameHeading').textContent = 'Training not found'
    return
  }

  document.getElementById('trainingNameHeading').textContent = data.name
}

// ==========================================================================
// ---- EXERCISE LIBRARY PANEL (search + drag source) ----
// ==========================================================================
async function loadAllExercises() {
  const { data, error } = await supabase.from('exercises').select('*').order('name')
  if (error) { console.log('Error loading exercises:', error); return }
  allExercises = data
  renderLibraryPanel()
}

// YouTube's thumbnail images are available at a predictable URL from just
// the video id, no API key needed - other hosts (Vimeo etc.) would need a
// real API call, so those just fall back to a placeholder icon
function getYouTubeThumbnail(url) {
  if (!url) return null
  const match = url.match(/(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/)
  return match ? `https://img.youtube.com/vi/${match[1]}/mqdefault.jpg` : null
}

function renderLibraryPanel() {
  const filter = document.getElementById('exerciseSearchInput').value.trim().toLowerCase()
  const filtered = filter ? allExercises.filter(ex => ex.name.toLowerCase().includes(filter)) : allExercises

  const list = document.getElementById('exerciseLibraryList')

  if (filtered.length === 0) {
    list.innerHTML = '<p class="no-metrics">No exercises found</p>'
    return
  }

  list.innerHTML = filtered.map(ex => {
    const thumb = getYouTubeThumbnail(ex.video_url)
    return `
      <div class="exercise-lib-card" draggable="true" data-id="${ex.id}">
        <div class="exercise-lib-thumb">
          ${thumb ? `<img src="${thumb}" alt="" loading="lazy">` : '<span class="exercise-lib-thumb-placeholder">🏋</span>'}
        </div>
        <span class="exercise-lib-name">${ex.name}</span>
      </div>
    `
  }).join('')
}

document.getElementById('exerciseSearchInput').addEventListener('input', renderLibraryPanel)

// ---- Drag from the library panel, drop onto the training's exercise list ----
document.getElementById('exerciseLibraryList').addEventListener('dragstart', function(e) {
  const card = e.target.closest('.exercise-lib-card')
  if (!card) return
  e.dataTransfer.setData('text/plain', card.dataset.id)
})

const trainingDropZone = document.getElementById('trainingExercisesList')

trainingDropZone.addEventListener('dragover', function(e) {
  e.preventDefault()
  trainingDropZone.classList.add('drag-over')
})

trainingDropZone.addEventListener('dragleave', function() {
  trainingDropZone.classList.remove('drag-over')
})

trainingDropZone.addEventListener('drop', async function(e) {
  e.preventDefault()
  trainingDropZone.classList.remove('drag-over')
  const exerciseId = e.dataTransfer.getData('text/plain')
  if (exerciseId) await addExerciseToTraining(exerciseId)
})

// Dropped in with no prescribed values yet - click the row's ✏ afterward to
// fill in sets/reps/weight/etc, keeps the drag itself a one-step action
async function addExerciseToTraining(exerciseId) {
  const nextOrder = exercisesCache.length ? Math.max(...exercisesCache.map(te => te.order_index)) + 1 : 0

  const { error } = await supabase.from('training_exercises').insert([{
    training_id: trainingId,
    exercise_id: exerciseId,
    order_index: nextOrder
  }])

  if (error) { console.log(error); alert('Something went wrong'); return }
  loadExercisesList()
}

// Timed exercises store their duration in the same prescribed_reps text
// column reps normally uses ("45 sec", "2 min")
function formatDuration(value, unit) {
  if (!value) return null
  return `${value} ${unit}`
}

function parseDuration(text) {
  if (!text) return { value: '', unit: 'sec' }
  const match = String(text).match(/^(\d+(?:\.\d+)?)\s*(sec|min)/i)
  if (match) return { value: match[1], unit: match[2].toLowerCase() }
  return { value: text, unit: 'sec' }
}

// ==========================================================================
// ---- EXTRA FIELDS ----
// ==========================================================================
function addExtraFieldRow(containerId, name, value) {
  const container = document.getElementById(containerId)
  const row = document.createElement('div')
  row.className = 'extra-field-row'
  row.innerHTML = `
    <input type="text" class="extra-field-name" placeholder="Field name (e.g. RPE)" value="${name || ''}">
    <input type="text" class="extra-field-value" placeholder="Value (e.g. 8)" value="${value || ''}">
    <button type="button" class="extra-field-remove">✕</button>
  `
  row.querySelector('.extra-field-remove').addEventListener('click', function() { row.remove() })
  container.appendChild(row)
}

function collectExtraFields(containerId) {
  const rows = document.querySelectorAll('#' + containerId + ' .extra-field-row')
  const result = {}
  rows.forEach(row => {
    const name = row.querySelector('.extra-field-name').value.trim()
    const value = row.querySelector('.extra-field-value').value.trim()
    if (name && value) result[name] = value
  })
  return Object.keys(result).length ? result : null
}

document.getElementById('tEditAddFieldBtn').addEventListener('click', function() {
  addExtraFieldRow('tEditExtraFields')
})

// ==========================================================================
// ---- LOAD + RENDER EXERCISE LIST ----
// ==========================================================================
async function loadExercisesList() {
  const { data, error } = await supabase
    .from('training_exercises')
    .select('*, exercises(id, name, category, type)')
    .eq('training_id', trainingId)

  if (error) { console.log('Error loading training exercises:', error); return }

  data.sort((a, b) => a.order_index - b.order_index)
  exercisesCache = data
  renderExercisesList()
}

function renderExercisesList() {
  const container = document.getElementById('trainingExercisesList')

  if (exercisesCache.length === 0) {
    container.innerHTML = '<p class="no-metrics">No exercises yet — drag one in from the library on the left</p>'
    return
  }

  container.innerHTML = exercisesCache.map(renderExerciseRow).join('')
}

function renderExerciseRow(te) {
  const isTimed = te.exercises && te.exercises.type === 'timed'
  const parts = []
  if (te.prescribed_sets) parts.push(`${te.prescribed_sets} sets`)
  if (te.prescribed_reps) parts.push(isTimed ? te.prescribed_reps : `${te.prescribed_reps} reps`)
  if (te.prescribed_weight) parts.push(`${te.prescribed_weight}kg`)
  if (te.extra_fields) {
    for (const [k, v] of Object.entries(te.extra_fields)) parts.push(`${k}: ${v}`)
  }
  const summary = parts.join(' × ')

  return `
    <li class="detail-row">
      <span>${te.exercises ? te.exercises.name : 'Unknown exercise'}${summary ? ' — ' + summary : ''}${te.notes ? ' (' + te.notes + ')' : ''}</span>
      <span style="display:flex; gap:8px">
        <button class="btn-edit-entry" data-action="edit" data-id="${te.id}">✏</button>
        <button class="btn-delete-measurement" data-action="delete" data-id="${te.id}">🗑</button>
      </span>
    </li>
  `
}

document.getElementById('trainingExercisesList').addEventListener('click', function(e) {
  const btn = e.target.closest('[data-action]')
  if (!btn) return
  if (btn.dataset.action === 'edit') openEditModal(btn.dataset.id)
  else if (btn.dataset.action === 'delete') deleteExerciseRow(btn.dataset.id)
})

// ==========================================================================
// ---- CREATE NEW EXERCISE ----
// Opened from the Exercise Library panel. Saving adds it to both the
// searchable library and straight onto the training (it was made
// specifically to use here, no need for a separate drag step).
// ==========================================================================
const BUILT_IN_TYPES = { weights: 'Weightlifting (sets, reps, weight)', timed: 'Timed (sets, duration)' }

function populateCreateCategorySelect() {
  const select = document.getElementById('tCreateExerciseCategory')
  const categories = [...new Set(allExercises.map(ex => ex.category).filter(c => c && c.trim()))].sort()
  select.innerHTML = categories.map(c => `<option value="${c}">${c}</option>`).join('') +
    '<option value="__new__">+ Add New Category</option>'
  select.value = '__new__'
  toggleCreateNewCategoryField()
}

function toggleCreateNewCategoryField() {
  const isNew = document.getElementById('tCreateExerciseCategory').value === '__new__'
  document.getElementById('tCreateExerciseNewCategoryGroup').style.display = isNew ? 'block' : 'none'
}

document.getElementById('tCreateExerciseCategory').addEventListener('change', toggleCreateNewCategoryField)

function populateCreateTypeSelect() {
  const select = document.getElementById('tCreateExerciseType')
  const customTypes = [...new Set(allExercises.map(ex => ex.type).filter(t => t && !(t in BUILT_IN_TYPES)))].sort()
  select.innerHTML =
    Object.entries(BUILT_IN_TYPES).map(([value, label]) => `<option value="${value}">${label}</option>`).join('') +
    customTypes.map(t => `<option value="${t}">${t}</option>`).join('') +
    '<option value="__new__">+ Add New Type</option>'
  select.value = 'weights'
  toggleCreateNewTypeField()
}

function toggleCreateNewTypeField() {
  const isNew = document.getElementById('tCreateExerciseType').value === '__new__'
  document.getElementById('tCreateExerciseNewTypeGroup').style.display = isNew ? 'block' : 'none'
}

document.getElementById('tCreateExerciseType').addEventListener('change', toggleCreateNewTypeField)

document.getElementById('openCreateExerciseBtn').addEventListener('click', function() {
  document.getElementById('tCreateExerciseName').value = ''
  document.getElementById('tCreateExerciseNewCategory').value = ''
  populateCreateCategorySelect()
  document.getElementById('tCreateExerciseNewType').value = ''
  populateCreateTypeSelect()
  document.getElementById('tCreateExerciseVideoUrl').value = ''
  document.getElementById('tCreateExerciseInstructions').value = ''
  document.getElementById('tCreateExerciseModal').classList.add('active')
})

document.getElementById('cancelTCreateExerciseBtn').addEventListener('click', function() {
  document.getElementById('tCreateExerciseModal').classList.remove('active')
})

document.getElementById('saveTCreateExerciseBtn').addEventListener('click', async function() {
  const name = document.getElementById('tCreateExerciseName').value.trim()
  const categorySelect = document.getElementById('tCreateExerciseCategory').value
  const category = categorySelect === '__new__'
    ? document.getElementById('tCreateExerciseNewCategory').value.trim()
    : categorySelect
  const typeSelect = document.getElementById('tCreateExerciseType').value
  const type = typeSelect === '__new__'
    ? document.getElementById('tCreateExerciseNewType').value.trim() || 'weights'
    : typeSelect
  const videoUrl = document.getElementById('tCreateExerciseVideoUrl').value.trim()
  const instructions = document.getElementById('tCreateExerciseInstructions').value.trim()

  if (!name) { alert('Please enter a name'); return }

  const { data, error } = await supabase
    .from('exercises')
    .insert([{ coach_id: session.user.id, name, category, type, video_url: videoUrl, instructions }])
    .select()

  if (error) { console.log(error); alert('Something went wrong'); return }

  allExercises.push(data[0])
  allExercises.sort((a, b) => a.name.localeCompare(b.name))
  renderLibraryPanel()
  document.getElementById('tCreateExerciseModal').classList.remove('active')
  await addExerciseToTraining(data[0].id)
})

// ==========================================================================
// ---- EDIT / DELETE AN EXERCISE ROW ----
// ==========================================================================
function openEditModal(id) {
  currentEditTE = exercisesCache.find(te => te.id === id)
  if (!currentEditTE) return

  const isTimed = currentEditTE.exercises && currentEditTE.exercises.type === 'timed'
  const duration = parseDuration(currentEditTE.prescribed_reps)

  document.getElementById('tEditExerciseTitle').textContent =
    'Edit ' + (currentEditTE.exercises ? currentEditTE.exercises.name : 'Exercise')
  document.getElementById('tEditSets').value = currentEditTE.prescribed_sets || ''
  document.getElementById('tEditReps').value = isTimed ? '' : (currentEditTE.prescribed_reps || '')
  document.getElementById('tEditDurationValue').value = isTimed ? duration.value : ''
  document.getElementById('tEditDurationUnit').value = isTimed ? duration.unit : 'sec'
  document.getElementById('tEditWeight').value = currentEditTE.prescribed_weight || ''
  document.getElementById('tEditNotes').value = currentEditTE.notes || ''
  document.getElementById('tEditRepsGroup').style.display = isTimed ? 'none' : 'block'
  document.getElementById('tEditDurationGroup').style.display = isTimed ? 'block' : 'none'
  document.getElementById('tEditWeightGroup').style.display = isTimed ? 'none' : 'block'

  document.getElementById('tEditExtraFields').innerHTML = ''
  if (currentEditTE.extra_fields) {
    for (const [k, v] of Object.entries(currentEditTE.extra_fields)) addExtraFieldRow('tEditExtraFields', k, v)
  }

  document.getElementById('tEditExerciseModal').classList.add('active')
}

document.getElementById('cancelTEditExerciseBtn').addEventListener('click', function() {
  document.getElementById('tEditExerciseModal').classList.remove('active')
})

document.getElementById('saveTEditExerciseBtn').addEventListener('click', async function() {
  const isTimed = currentEditTE.exercises && currentEditTE.exercises.type === 'timed'

  const sets = document.getElementById('tEditSets').value ? parseInt(document.getElementById('tEditSets').value) : null
  const reps = isTimed
    ? formatDuration(document.getElementById('tEditDurationValue').value, document.getElementById('tEditDurationUnit').value)
    : (document.getElementById('tEditReps').value.trim() || null)
  const weight = isTimed ? null : (document.getElementById('tEditWeight').value ? parseFloat(document.getElementById('tEditWeight').value) : null)
  const notes = document.getElementById('tEditNotes').value.trim() || null
  const extraFields = collectExtraFields('tEditExtraFields')

  const { error } = await supabase
    .from('training_exercises')
    .update({ prescribed_sets: sets, prescribed_reps: reps, prescribed_weight: weight, extra_fields: extraFields, notes })
    .eq('id', currentEditTE.id)

  if (error) { console.log(error); alert('Something went wrong'); return }

  document.getElementById('tEditExerciseModal').classList.remove('active')
  loadExercisesList()
})

async function deleteExerciseRow(id) {
  if (!confirm('Remove this exercise from the training?')) return

  const { error } = await supabase.from('training_exercises').delete().eq('id', id)
  if (error) { console.log(error); alert('Something went wrong'); return }
  loadExercisesList()
}

// ==========================================================================
// ---- RENAME TRAINING ----
// ==========================================================================
document.getElementById('renameTrainingBtn').addEventListener('click', function() {
  document.getElementById('renameTrainingInput').value = document.getElementById('trainingNameHeading').textContent
  document.getElementById('renameTrainingModal').classList.add('active')
})

document.getElementById('cancelRenameTrainingBtn').addEventListener('click', function() {
  document.getElementById('renameTrainingModal').classList.remove('active')
})

document.getElementById('saveRenameTrainingBtn').addEventListener('click', async function() {
  const name = document.getElementById('renameTrainingInput').value.trim()
  if (!name) { alert('Please enter a name'); return }

  const { error } = await supabase.from('trainings').update({ name }).eq('id', trainingId)
  if (error) { console.log(error); alert('Something went wrong'); return }

  document.getElementById('trainingNameHeading').textContent = name
  document.getElementById('renameTrainingModal').classList.remove('active')
})
