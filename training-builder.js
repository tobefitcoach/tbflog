// ==========================================================================
// TRAINING BUILDER
// Edits one training's flat exercise list. Same picker/edit patterns as
// program-builder.js, just without the week/day nesting - a training is
// always one flat session. Each exercise is an always-editable card (video
// thumbnail, one row per set with its own reps/weight target, rest time,
// notes) instead of a popup modal - mirrors the athlete's own live workout
// screen (athlete-app/dashboard.js's renderActiveExercise/renderSetRow).
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

function getYouTubeEmbedUrl(url) {
  if (!url) return null
  const match = url.match(/(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/)
  return match ? `https://www.youtube.com/embed/${match[1]}?autoplay=1` : null
}

// Tapping a card's thumbnail swaps it for a playing embed right in place,
// same as the athlete's own exercise card
function playInlineVideo(containerEl, url) {
  if (!url) return
  const embedUrl = getYouTubeEmbedUrl(url)
  if (!embedUrl) { window.open(url, '_blank'); return }
  containerEl.innerHTML = `<iframe src="${embedUrl}" allow="autoplay; encrypted-media" allowfullscreen></iframe>`
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

// Dropped in with no prescribed values yet - renders immediately as one
// blank, empty set row (see deriveSetTargets) ready to edit right there,
// no separate step needed
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

// ==========================================================================
// ---- EXTRA FIELDS ----
// ==========================================================================
function addExtraFieldRow(containerId, name, value) {
  const container = document.getElementById(containerId)
  if (!container) return
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

// ==========================================================================
// ---- PER-SET TARGETS ----
// A training_exercises row keeps one set_targets array
// ([{reps, weight, rest, type}, ...], index 0 = Set 1) so each set can have
// its own target (a pyramid: 12/10/8 reps at increasing weight) AND its own
// rest afterward (shorter between warmup sets than top sets) and its own
// type (warmup / main / failure), instead of one shared value applied to
// every set. prescribed_sets/prescribed_reps/prescribed_weight/rest_seconds
// are kept in sync with it on every save (length / first set's values)
// purely so every other place in the app that only reads those old columns
// keeps working untouched.
// ==========================================================================
const SET_TYPES = { main: 'Main Set', warmup: 'Warmup Set', failure: 'Set to Failure' }

function deriveSetTargets(row) {
  if (row.set_targets && row.set_targets.length) return row.set_targets
  const count = row.prescribed_sets || 1
  return Array.from({ length: count }, () => ({ reps: row.prescribed_reps || null, weight: row.prescribed_weight || null, rest: row.rest_seconds || null, type: 'main' }))
}

function renderSetTargetRow(setNumber, target, isTimed, onlyRow) {
  return `
    <div class="set-target-row" data-set-number="${setNumber}">
      <span class="set-label">Set ${setNumber}</span>
      <select class="set-type-select">
        ${Object.entries(SET_TYPES).map(([value, label]) => `<option value="${value}" ${(target.type || 'main') === value ? 'selected' : ''}>${label}</option>`).join('')}
      </select>
      <input type="text" class="set-reps-input" value="${target.reps || ''}" placeholder="${isTimed ? 'e.g. 45 sec' : 'reps'}">
      ${isTimed ? '' : `<input type="number" class="set-weight-input" value="${target.weight != null ? target.weight : ''}" placeholder="kg" step="0.5">`}
      <input type="number" class="set-rest-input" value="${target.rest != null ? target.rest : ''}" placeholder="rest sec">
      <button type="button" class="set-remove-btn" data-action="remove-set" ${onlyRow ? 'disabled' : ''}>✕</button>
    </div>
  `
}

function addSetTargetRow(rowsEl, isTimed) {
  const rows = [...rowsEl.querySelectorAll('.set-target-row')]
  if (rows.length === 1) rows[0].querySelector('.set-remove-btn').disabled = false
  rowsEl.insertAdjacentHTML('beforeend', renderSetTargetRow(rows.length + 1, { reps: null, weight: null, rest: null, type: 'main' }, isTimed, false))
}

// Removal can happen from the middle of the list, so every remaining row
// needs relabelling, not just a length check
function removeSetTargetRow(row) {
  const rowsEl = row.parentElement
  row.remove()
  const remaining = [...rowsEl.querySelectorAll('.set-target-row')]
  remaining.forEach((r, i) => {
    r.dataset.setNumber = i + 1
    r.querySelector('.set-label').textContent = `Set ${i + 1}`
  })
  if (remaining.length === 1) remaining[0].querySelector('.set-remove-btn').disabled = true
}

// ==========================================================================
// ---- LOAD + RENDER EXERCISE LIST ----
// ==========================================================================
async function loadExercisesList() {
  const { data, error } = await supabase
    .from('training_exercises')
    .select('*, exercises(id, name, category, type, video_url)')
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

  container.innerHTML = exercisesCache.map(renderExerciseCard).join('')

  // innerHTML wipes any dynamically-built children, so extra field rows
  // (built with document.createElement, not template strings) get
  // re-populated here for every card, same as the old edit modal did
  for (const te of exercisesCache) {
    if (te.extra_fields) {
      for (const [k, v] of Object.entries(te.extra_fields)) addExtraFieldRow(`extraFields-${te.id}`, k, v)
    }
  }
}

function renderExerciseCard(te) {
  const isTimed = te.exercises && te.exercises.type === 'timed'
  const videoUrl = (te.exercises && te.exercises.video_url) || ''
  const thumb = getYouTubeThumbnail(videoUrl)
  const targets = deriveSetTargets(te)
  const rowsHtml = targets.map((t, i) => renderSetTargetRow(i + 1, t, isTimed, targets.length === 1)).join('')

  return `
    <div class="builder-exercise-card" data-id="${te.id}">
      <div class="builder-exercise-card-header">
        <button type="button" class="builder-exercise-thumb" ${videoUrl ? `data-video-url="${videoUrl}"` : 'disabled'}>
          ${thumb ? `<img src="${thumb}" alt="" loading="lazy">` : '<span class="builder-exercise-thumb-placeholder">🏋</span>'}
        </button>
        <div class="builder-exercise-name">${te.exercises ? te.exercises.name : 'Unknown exercise'}</div>
        <button type="button" class="btn-delete-measurement" data-action="delete-exercise" title="Remove from training">🗑</button>
      </div>
      <div class="set-target-rows">
        ${rowsHtml}
      </div>
      <button type="button" class="builder-add-set-btn" data-action="add-set">+ Add Set</button>
      <div class="builder-exercise-notes" style="margin-top:16px">
        <label>Extra Fields (optional)</label>
        <div class="extra-fields-container" id="extraFields-${te.id}"></div>
        <button type="button" class="btn-create-metric" data-action="add-extra-field" style="margin-top:6px">+ Add Field</button>
      </div>
      <div class="builder-exercise-notes">
        <label>Notes (visible to the athlete)</label>
        <input type="text" class="exercise-notes-input" value="${te.notes || ''}" placeholder="e.g. Focus on controlled tempo">
      </div>
    </div>
  `
}

// Reads one card's current DOM state and saves it - called for every
// exercise at once from the single page-level Save button (see
// saveTrainingBtn below), not from a per-card button, since a coach builds
// a training's whole exercise list in one sitting and only wants to press
// Save once at the end. Returns true/false instead of alerting on its own
// so the caller can report one combined error if several cards fail.
async function saveExerciseCard(teId) {
  const card = document.querySelector(`.builder-exercise-card[data-id="${teId}"]`)
  if (!card) return true

  const rows = [...card.querySelectorAll('.set-target-row')]
  const setTargets = rows.map(row => {
    const reps = row.querySelector('.set-reps-input').value.trim() || null
    const weightInput = row.querySelector('.set-weight-input')
    const weight = weightInput && weightInput.value ? parseFloat(weightInput.value) : null
    const restInput = row.querySelector('.set-rest-input')
    const rest = restInput.value ? parseInt(restInput.value) : null
    const type = row.querySelector('.set-type-select').value
    return { reps, weight, rest, type }
  })

  const notes = card.querySelector('.exercise-notes-input').value.trim() || null
  const extraFields = collectExtraFields(`extraFields-${teId}`)
  const first = setTargets[0] || { reps: null, weight: null, rest: null }

  const { error } = await supabase
    .from('training_exercises')
    .update({
      set_targets: setTargets,
      prescribed_sets: setTargets.length,
      prescribed_reps: first.reps,
      prescribed_weight: first.weight,
      rest_seconds: first.rest,
      extra_fields: extraFields,
      notes
    })
    .eq('id', teId)

  if (error) { console.log(error); return false }
  return true
}

// Saves every exercise card on the page at once. Standalone page: heads
// back to the Training Library list afterward (that's "done" for a coach
// building a training). Embedded in the calendar's "+ New Training"
// overlay: stays put and just confirms, since the overlay's own Done
// button (in athlete-calendar.js) is what actually closes it.
document.getElementById('saveTrainingBtn').addEventListener('click', async function() {
  const btn = this
  btn.disabled = true
  btn.textContent = 'Saving...'

  const ids = exercisesCache.map(te => te.id)
  const results = await Promise.all(ids.map(saveExerciseCard))

  if (results.some(ok => !ok)) {
    alert('Something went wrong saving one or more exercises - please try again')
    btn.disabled = false
    btn.textContent = '💾 Save'
    return
  }

  if (params.get('embed') === '1') {
    await loadExercisesList()
    btn.textContent = 'Saved!'
    setTimeout(function() { btn.disabled = false; btn.textContent = '💾 Save' }, 1200)
  } else {
    window.location.href = 'trainings.html'
  }
})

async function deleteExerciseRow(id) {
  if (!confirm('Remove this exercise from the training?')) return

  const { error } = await supabase.from('training_exercises').delete().eq('id', id)
  if (error) { console.log(error); alert('Something went wrong'); return }
  loadExercisesList()
}

document.getElementById('trainingExercisesList').addEventListener('click', async function(e) {
  const thumbBtn = e.target.closest('.builder-exercise-thumb')
  if (thumbBtn && thumbBtn.dataset.videoUrl) {
    playInlineVideo(thumbBtn, thumbBtn.dataset.videoUrl)
    return
  }

  const btn = e.target.closest('[data-action]')
  if (!btn) return
  const card = btn.closest('.builder-exercise-card')
  const teId = card ? card.dataset.id : null
  const te = teId ? exercisesCache.find(t => t.id === teId) : null
  const isTimed = !!(te && te.exercises && te.exercises.type === 'timed')

  if (btn.dataset.action === 'add-set') {
    addSetTargetRow(card.querySelector('.set-target-rows'), isTimed)
  } else if (btn.dataset.action === 'remove-set') {
    removeSetTargetRow(btn.closest('.set-target-row'))
  } else if (btn.dataset.action === 'delete-exercise') {
    await deleteExerciseRow(teId)
  } else if (btn.dataset.action === 'add-extra-field') {
    addExtraFieldRow(`extraFields-${teId}`)
  }
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
  select.innerHTML = '<option value="">Choose Category</option>' +
    categories.map(c => `<option value="${c}">${c}</option>`).join('') +
    '<option value="__new__">+ Add New Category</option>'
  select.value = ''
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
