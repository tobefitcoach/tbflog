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
  const { data, error } = await fetchWithRetry((signal) => supabase
    .from('trainings')
    .select('*')
    .eq('id', trainingId)
    .single()
    .abortSignal(signal)
  )

  if (error) {
    console.log('Error loading training:', error)
    document.getElementById('trainingNameHeading').textContent = 'Workout not found'
    customAlert('Something went wrong loading this workout - check your connection and try again')
    return
  }

  document.getElementById('trainingNameHeading').textContent = data.name
}

// ==========================================================================
// ---- EXERCISE LIBRARY PANEL (search + drag source) ----
// ==========================================================================
async function loadAllExercises() {
  const { data, error } = await fetchWithRetry((signal) => supabase.from('exercises').select('*').order('name').abortSignal(signal))
  if (error) { console.log('Error loading exercises:', error); customAlert('Something went wrong loading the exercise library - check your connection and try again'); return }
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
  if (!draggingCard) trainingDropZone.classList.add('drag-over')
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

// ---- Reorder exercises already in the training by dragging the ⠿ handle ----
// Purely a DOM reorder while dragging (no network call) - the new order is
// only written to order_index when the page's own Save button is pressed,
// same as every other edit on this page.
let draggingCard = null

trainingDropZone.addEventListener('dragstart', function(e) {
  const handle = e.target.closest('.builder-drag-handle')
  if (!handle) return
  draggingCard = handle.closest('.builder-exercise-card')
  e.dataTransfer.effectAllowed = 'move'
  e.dataTransfer.setData('text/plain', '') // Firefox requires data to be set for drag to start
  e.dataTransfer.setDragImage(draggingCard, 20, 20)
  setTimeout(function() { draggingCard.classList.add('dragging') }, 0)
})

trainingDropZone.addEventListener('dragover', function(e) {
  if (!draggingCard) return
  e.preventDefault()
  const cards = [...trainingDropZone.querySelectorAll('.builder-exercise-card:not(.dragging)')]
  const after = cards.reduce(function(closest, card) {
    const box = card.getBoundingClientRect()
    const offset = e.clientY - box.top - box.height / 2
    return (offset < 0 && offset > closest.offset) ? { offset, element: card } : closest
  }, { offset: -Infinity, element: null }).element

  if (after) {
    trainingDropZone.insertBefore(draggingCard, after)
  } else {
    trainingDropZone.appendChild(draggingCard)
  }
})

trainingDropZone.addEventListener('dragend', function() {
  if (draggingCard) draggingCard.classList.remove('dragging')
  draggingCard = null
  renderWorkoutOutline()
})

// ---- Exercise order outline (right side panel) ----
// Just names, in order - a much quicker drag target than a whole tall
// exercise card. Dragging a row here reorders the outline first, then
// applies that same order to the real cards on the left (syncCardOrder
// below) - so either list can be dragged and they stay in sync.
function renderWorkoutOutline() {
  const panel = document.getElementById('workoutOutlineList')
  const cards = [...trainingDropZone.querySelectorAll('.builder-exercise-card')]

  if (cards.length === 0) {
    panel.innerHTML = '<p class="no-metrics" style="font-size:12px">No exercises yet</p>'
    return
  }

  panel.innerHTML = cards.map(function(card, i) {
    const name = card.querySelector('.builder-exercise-name').textContent
    return `
      <div class="workout-outline-item" draggable="true" data-id="${card.dataset.id}">
        <span class="workout-outline-num">${i + 1}</span>
        <span class="workout-outline-name">${name}</span>
      </div>
    `
  }).join('')
}

function renumberOutline() {
  document.querySelectorAll('#workoutOutlineList .workout-outline-item').forEach(function(item, i) {
    item.querySelector('.workout-outline-num').textContent = i + 1
  })
}

// Reorders the real exercise cards to match the outline's current order
function syncCardOrderToOutline() {
  const order = [...document.querySelectorAll('#workoutOutlineList .workout-outline-item')].map(item => item.dataset.id)
  order.forEach(function(id) {
    const card = trainingDropZone.querySelector(`.builder-exercise-card[data-id="${id}"]`)
    if (card) trainingDropZone.appendChild(card)
  })
}

let draggingOutlineItem = null
const workoutOutlineList = document.getElementById('workoutOutlineList')

workoutOutlineList.addEventListener('dragstart', function(e) {
  const item = e.target.closest('.workout-outline-item')
  if (!item) return
  draggingOutlineItem = item
  e.dataTransfer.effectAllowed = 'move'
  e.dataTransfer.setData('text/plain', '')
  setTimeout(function() { item.classList.add('dragging') }, 0)
})

workoutOutlineList.addEventListener('dragover', function(e) {
  if (!draggingOutlineItem) return
  e.preventDefault()
  const items = [...workoutOutlineList.querySelectorAll('.workout-outline-item:not(.dragging)')]
  const after = items.reduce(function(closest, item) {
    const box = item.getBoundingClientRect()
    const offset = e.clientY - box.top - box.height / 2
    return (offset < 0 && offset > closest.offset) ? { offset, element: item } : closest
  }, { offset: -Infinity, element: null }).element

  if (after) {
    workoutOutlineList.insertBefore(draggingOutlineItem, after)
  } else {
    workoutOutlineList.appendChild(draggingOutlineItem)
  }
})

workoutOutlineList.addEventListener('dragend', function() {
  if (!draggingOutlineItem) return
  draggingOutlineItem.classList.remove('dragging')
  draggingOutlineItem = null
  syncCardOrderToOutline()
  renumberOutline()
})

// Dropped in with no prescribed values yet - renders immediately as one
// blank, empty set row (see deriveSetTargets) ready to edit right there,
// no separate step needed. Appends just this one new card instead of
// reloading + re-rendering the whole list, so any unsaved edits sitting in
// other cards' rows aren't wiped out by the refresh.
async function addExerciseToTraining(exerciseId) {
  const nextOrder = exercisesCache.length ? Math.max(...exercisesCache.map(te => te.order_index)) + 1 : 0

  const { data, error } = await supabase.from('training_exercises').insert([{
    training_id: trainingId,
    exercise_id: exerciseId,
    order_index: nextOrder
  }]).select('*, exercises(id, name, category, type, video_url, tracks_weight, is_timed, is_unilateral)')

  if (error) { console.log(error); customAlert('Something went wrong'); return }

  const newRow = data[0]
  exercisesCache.push(newRow)

  const container = document.getElementById('trainingExercisesList')
  if (exercisesCache.length === 1) {
    container.innerHTML = renderExerciseCard(newRow)
  } else {
    container.insertAdjacentHTML('beforeend', renderExerciseCard(newRow))
  }
  renderWorkoutOutline()
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

function renderSetTargetRow(setNumber, target, isTimed, tracksWeight, isUnilateral, onlyRow) {
  const repsPlaceholder = (isTimed ? 'e.g. 45 sec' : 'reps') + (isUnilateral ? ' each side' : '')
  return `
    <div class="set-target-row" data-set-number="${setNumber}">
      <span class="set-label">Set ${setNumber}</span>
      <select class="set-type-select">
        ${Object.entries(SET_TYPES).map(([value, label]) => `<option value="${value}" ${(target.type || 'main') === value ? 'selected' : ''}>${label}</option>`).join('')}
      </select>
      <input type="text" class="set-reps-input" value="${target.reps || ''}" placeholder="${repsPlaceholder}">
      ${tracksWeight ? `<input type="number" class="set-weight-input" value="${target.weight != null ? target.weight : ''}" placeholder="kg" step="0.5">` : ''}
      <input type="number" class="set-rest-input" value="${target.rest != null ? target.rest : ''}" placeholder="rest sec">
      <button type="button" class="set-remove-btn" data-action="remove-set" ${onlyRow ? 'disabled' : ''}>✕</button>
    </div>
  `
}

function addSetTargetRow(rowsEl, isTimed, tracksWeight, isUnilateral) {
  const rows = [...rowsEl.querySelectorAll('.set-target-row')]
  if (rows.length === 1) rows[0].querySelector('.set-remove-btn').disabled = false
  rowsEl.insertAdjacentHTML('beforeend', renderSetTargetRow(rows.length + 1, { reps: null, weight: null, rest: null, type: 'main' }, isTimed, tracksWeight, isUnilateral, false))
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
  const { data, error } = await fetchWithRetry((signal) => supabase
    .from('training_exercises')
    .select('*, exercises(id, name, category, type, video_url, tracks_weight, is_timed, is_unilateral)')
    .eq('training_id', trainingId)
    .abortSignal(signal)
  )

  if (error) { console.log('Error loading training exercises:', error); customAlert('Something went wrong loading this workout\'s exercises - check your connection and try again'); return }

  data.sort((a, b) => a.order_index - b.order_index)
  exercisesCache = data
  renderExercisesList()
}

// One header per run of consecutive exercises sharing the same non-null
// section_label - list must already be sorted by order_index. Manually/
// individually added exercises (section_label null) never get a header.
function renderExerciseListHtml(list) {
  let html = ''
  let lastLabel // undefined sentinel - a run of nulls never gets a header
  for (const item of list) {
    if (item.section_label !== lastLabel) {
      if (item.section_label) html += `<div class="builder-section-header">${item.section_label}</div>`
      lastLabel = item.section_label
    }
    html += renderExerciseCard(item)
  }
  return html
}

function renderExercisesList() {
  const container = document.getElementById('trainingExercisesList')

  if (exercisesCache.length === 0) {
    container.innerHTML = '<p class="no-metrics">No exercises yet — drag one in from the library on the left</p>'
    return
  }

  container.innerHTML = renderExerciseListHtml(exercisesCache)

  // innerHTML wipes any dynamically-built children, so extra field rows
  // (built with document.createElement, not template strings) get
  // re-populated here for every card, same as the old edit modal did
  for (const te of exercisesCache) {
    if (te.extra_fields) {
      for (const [k, v] of Object.entries(te.extra_fields)) addExtraFieldRow(`extraFields-${te.id}`, k, v)
    }
  }

  renderWorkoutOutline()
}

function renderExerciseCard(te) {
  const isTimed = te.exercises && te.exercises.is_timed
  const tracksWeight = !te.exercises || te.exercises.tracks_weight
  const isUnilateral = te.exercises && te.exercises.is_unilateral
  const videoUrl = (te.exercises && te.exercises.video_url) || ''
  const thumb = getYouTubeThumbnail(videoUrl)
  const targets = deriveSetTargets(te)
  const rowsHtml = targets.map((t, i) => renderSetTargetRow(i + 1, t, isTimed, tracksWeight, isUnilateral, targets.length === 1)).join('')
  const partner = te.superset_group_id ? exercisesCache.find(other => other.id !== te.id && other.superset_group_id === te.superset_group_id) : null

  return `
    <div class="builder-exercise-card" data-id="${te.id}" data-superset-group-id="${te.superset_group_id || ''}">
      <div class="builder-exercise-card-header">
        <span class="builder-drag-handle" draggable="true" title="Drag to reorder">⠿</span>
        <button type="button" class="builder-exercise-thumb" ${videoUrl ? `data-video-url="${videoUrl}"` : 'disabled'}>
          ${thumb ? `<img src="${thumb}" alt="" loading="lazy">` : '<span class="builder-exercise-thumb-placeholder">🏋</span>'}
        </button>
        <div class="builder-exercise-name">${te.exercises ? te.exercises.name : 'Unknown exercise'}</div>
        ${isUnilateral ? '<span class="builder-unilateral-badge">Each Side</span>' : ''}
        ${partner ? `<span class="builder-superset-badge">🔗 Linked with ${partner.exercises ? partner.exercises.name : 'exercise'}</span>` : ''}
        <button type="button" class="builder-link-btn ${te.superset_group_id ? 'linked' : ''}" data-action="toggle-link" title="${te.superset_group_id ? 'Unlink superset' : 'Link with another exercise (superset)'}">🔗</button>
        <button type="button" class="btn-delete-measurement" data-action="delete-exercise" title="Remove from workout">🗑</button>
      </div>
      <div class="set-target-rows">
        ${rowsHtml}
      </div>
      <button type="button" class="builder-add-set-btn" data-action="add-set">+ Add Set</button>
      <div class="builder-exercise-notes">
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
async function saveExerciseCard(teId, orderIndex) {
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
      notes,
      order_index: orderIndex,
      superset_group_id: card.dataset.supersetGroupId || null
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

  const ids = [...document.querySelectorAll('#trainingExercisesList .builder-exercise-card')].map(card => card.dataset.id)
  const results = await Promise.all(ids.map(saveExerciseCard))

  if (results.some(ok => !ok)) {
    customAlert('Something went wrong saving one or more exercises - please try again')
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

// Removes just this one card instead of reloading + re-rendering the whole
// list, so any unsaved edits sitting in other cards' rows aren't wiped out
async function deleteExerciseRow(id) {
  if (!(await customConfirm('Remove this exercise from the workout?'))) return

  const card = document.querySelector(`.builder-exercise-card[data-id="${id}"]`)
  if (card && card.dataset.supersetGroupId) unlinkSupersetPair(card.dataset.supersetGroupId, trainingDropZone)

  const { error } = await supabase.from('training_exercises').delete().eq('id', id)
  if (error) { console.log(error); customAlert('Something went wrong'); return }

  exercisesCache = exercisesCache.filter(te => te.id !== id)
  if (card) card.remove()
  if (exercisesCache.length === 0) {
    document.getElementById('trainingExercisesList').innerHTML = '<p class="no-metrics">No exercises yet — drag one in from the library on the left</p>'
  }
  renderWorkoutOutline()
}

// ==========================================================================
// ---- SUPERSETS (link exactly two exercises) ----
// Draft-until-Save, exactly like set_targets/notes - a link only becomes
// real when saveExerciseCard's payload includes it. Picking mode only
// marks OTHER cards in this same training as pickable, since a superset
// partner always has to be within the same exercise list.
// ==========================================================================
let pickingPartnerForId = null

function handleLinkClick(id, listScopeEl) {
  const card = listScopeEl.querySelector(`.builder-exercise-card[data-id="${id}"]`)
  const currentGroupId = card.dataset.supersetGroupId || null
  if (currentGroupId) { unlinkSupersetPair(currentGroupId, listScopeEl); return }
  if (pickingPartnerForId === id) { exitPickingMode(listScopeEl); return }
  if (pickingPartnerForId) { completeSupersetPairing(pickingPartnerForId, id, listScopeEl); return }
  enterPickingMode(id, listScopeEl)
}

function enterPickingMode(id, listScopeEl) {
  pickingPartnerForId = id
  listScopeEl.querySelectorAll('.builder-exercise-card').forEach(card => {
    const isSelf = card.dataset.id === id
    const isLinked = !!card.dataset.supersetGroupId
    card.classList.toggle('picking-self', isSelf)
    card.classList.toggle('pickable', !isSelf && !isLinked)
  })
}

function exitPickingMode(listScopeEl) {
  pickingPartnerForId = null
  listScopeEl.querySelectorAll('.builder-exercise-card').forEach(c => c.classList.remove('picking-self', 'pickable'))
}

function completeSupersetPairing(idA, idB, listScopeEl) {
  const groupId = crypto.randomUUID()
  const cardA = listScopeEl.querySelector(`.builder-exercise-card[data-id="${idA}"]`)
  const cardB = listScopeEl.querySelector(`.builder-exercise-card[data-id="${idB}"]`)
  cardA.dataset.supersetGroupId = groupId
  cardB.dataset.supersetGroupId = groupId
  exitPickingMode(listScopeEl)
  refreshSupersetBadge(cardA)
  refreshSupersetBadge(cardB)
}

function unlinkSupersetPair(groupId, listScopeEl) {
  listScopeEl.querySelectorAll(`.builder-exercise-card[data-superset-group-id="${groupId}"]`).forEach(card => {
    delete card.dataset.supersetGroupId
    refreshSupersetBadge(card)
  })
}

function refreshSupersetBadge(card) {
  const existing = card.querySelector('.builder-superset-badge')
  if (existing) existing.remove()
  const linkBtn = card.querySelector('.builder-link-btn')
  const groupId = card.dataset.supersetGroupId
  linkBtn.classList.toggle('linked', !!groupId)
  linkBtn.title = groupId ? 'Unlink superset' : 'Link with another exercise (superset)'
  if (!groupId) return
  const partnerCard = [...trainingDropZone.querySelectorAll(`.builder-exercise-card[data-superset-group-id="${groupId}"]`)].find(c => c !== card)
  const partnerName = partnerCard ? partnerCard.querySelector('.builder-exercise-name').textContent : null
  if (!partnerName) return
  card.querySelector('.builder-exercise-card-header').insertBefore(
    Object.assign(document.createElement('span'), { className: 'builder-superset-badge', textContent: `🔗 Linked with ${partnerName}` }),
    linkBtn
  )
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
  const isTimed = !!(te && te.exercises && te.exercises.is_timed)
  const tracksWeight = !!(te && (!te.exercises || te.exercises.tracks_weight))
  const isUnilateral = !!(te && te.exercises && te.exercises.is_unilateral)

  if (btn.dataset.action === 'add-set') {
    addSetTargetRow(card.querySelector('.set-target-rows'), isTimed, tracksWeight, isUnilateral)
  } else if (btn.dataset.action === 'remove-set') {
    removeSetTargetRow(btn.closest('.set-target-row'))
  } else if (btn.dataset.action === 'delete-exercise') {
    await deleteExerciseRow(teId)
  } else if (btn.dataset.action === 'add-extra-field') {
    addExtraFieldRow(`extraFields-${teId}`)
  } else if (btn.dataset.action === 'toggle-link') {
    handleLinkClick(teId, trainingDropZone)
  }
})

// ==========================================================================
// ---- CREATE NEW EXERCISE ----
// Opened from the Exercise Library panel. Saving adds it to both the
// searchable library and straight onto the training (it was made
// specifically to use here, no need for a separate drag step).
// ==========================================================================
const BUILT_IN_TYPES = { weights: 'Weightlifting (sets, reps, weight)', timed: 'Timed (sets, duration)', plyometric: 'Plyometric (sets, foot contacts, intensity)' }

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
  document.getElementById('tCreateExerciseTracksWeight').checked = true
  document.getElementById('tCreateExerciseIsTimed').checked = false
  document.getElementById('tCreateExerciseIsUnilateral').checked = false
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
  const tracksWeight = document.getElementById('tCreateExerciseTracksWeight').checked
  const isTimed = document.getElementById('tCreateExerciseIsTimed').checked
  const isUnilateral = document.getElementById('tCreateExerciseIsUnilateral').checked

  if (!name) { customAlert('Please enter a name'); return }

  const { data, error } = await supabase
    .from('exercises')
    .insert([{ coach_id: session.user.id, name, category, type, video_url: videoUrl, instructions, tracks_weight: tracksWeight, is_timed: isTimed, is_unilateral: isUnilateral }])
    .select()

  if (error) { console.log(error); customAlert('Something went wrong'); return }

  allExercises.push(data[0])
  allExercises.sort((a, b) => a.name.localeCompare(b.name))
  renderLibraryPanel()
  document.getElementById('tCreateExerciseModal').classList.remove('active')
  await addExerciseToTraining(data[0].id)
})

// ==========================================================================
// ---- ADD SECTION (bulk-insert a saved reusable group of exercises) ----
// List + preview, same UX as the calendar's "Add Workout" popup. Inserted
// exercises are offset past whatever's already in the training (never
// copied verbatim - a verbatim copy would collide/interleave order_index
// with exercises already in the list) and stamped with section_label so
// they render grouped under a header (see renderExerciseListHtml).
// ==========================================================================
let cachedSections = null
let selectedSectionId = null
let selectedSectionName = null

async function getSectionsList() {
  if (cachedSections) return cachedSections
  const { data, error } = await fetchWithRetry((signal) => supabase.from('sections').select('*').order('name').abortSignal(signal))
  if (error) { console.log(error); customAlert('Something went wrong loading your sections - check your connection and try again'); return null }
  cachedSections = data
  return cachedSections
}

function resetSectionPreview() {
  selectedSectionId = null
  selectedSectionName = null
  document.getElementById('addSectionPreview').innerHTML = '<p class="no-metrics">Select a section to preview it</p>'
  document.getElementById('insertSectionBtn').disabled = true
}

document.getElementById('addSectionBtn').addEventListener('click', async function() {
  resetSectionPreview()
  const list = document.getElementById('addSectionList')
  const data = await getSectionsList()

  if (data === null) {
    list.innerHTML = '<p class="no-metrics">Something went wrong loading the Section Library</p>'
  } else if (data.length === 0) {
    list.innerHTML = '<p class="no-metrics">No sections saved yet - create one in the Section Library first</p>'
  } else {
    list.innerHTML = data.map(s => `
      <div class="training-pick-row" data-id="${s.id}" data-name="${s.name}">
        <span>${s.name}</span>
      </div>
    `).join('')

    list.querySelectorAll('.training-pick-row').forEach(row => {
      row.addEventListener('click', function() {
        list.querySelectorAll('.training-pick-row').forEach(r => r.classList.remove('selected'))
        row.classList.add('selected')
        previewSection(row.dataset.id, row.dataset.name)
      })
    })
  }

  document.getElementById('addSectionModal').classList.add('active')
})

function renderSectionPreviewExercise(se) {
  const thumb = getYouTubeThumbnail(se.exercises && se.exercises.video_url)
  const setCount = deriveSetTargets(se).length
  return `
    <div class="workout-preview-exercise">
      <div class="workout-preview-thumb">${thumb ? `<img src="${thumb}" alt="" loading="lazy">` : '🏋'}</div>
      <div class="workout-preview-info">
        <div class="workout-preview-name">${se.exercises ? se.exercises.name : 'Unknown exercise'}</div>
        <div class="workout-preview-target">${setCount} set${setCount === 1 ? '' : 's'}</div>
      </div>
    </div>
  `
}

async function previewSection(sectionId, name) {
  selectedSectionId = sectionId
  selectedSectionName = name
  document.getElementById('insertSectionBtn').disabled = false

  const preview = document.getElementById('addSectionPreview')
  preview.innerHTML = '<p class="no-metrics">Loading...</p>'

  const { data, error } = await supabase
    .from('section_exercises')
    .select('*, exercises(id, name, video_url)')
    .eq('section_id', sectionId)

  if (error) { console.log(error); preview.innerHTML = '<p class="no-metrics">Something went wrong loading this section</p>'; return }

  data.sort((a, b) => a.order_index - b.order_index)
  preview.innerHTML = data.length === 0
    ? '<p class="no-metrics">No exercises in this section</p>'
    : data.map(renderSectionPreviewExercise).join('')
}

document.getElementById('insertSectionBtn').addEventListener('click', async function() {
  if (!selectedSectionId) return
  await insertSectionIntoTraining(selectedSectionId, selectedSectionName)
})

document.getElementById('closeAddSectionBtn').addEventListener('click', function() {
  document.getElementById('addSectionModal').classList.remove('active')
})

async function insertSectionIntoTraining(sectionId, sectionName) {
  const { data: sectionExercises, error } = await supabase.from('section_exercises').select('*').eq('section_id', sectionId)
  if (error) { console.log(error); customAlert('Something went wrong'); return }
  sectionExercises.sort((a, b) => a.order_index - b.order_index)
  if (sectionExercises.length === 0) { document.getElementById('addSectionModal').classList.remove('active'); return }

  const baseOrder = exercisesCache.length ? Math.max(...exercisesCache.map(te => te.order_index)) + 1 : 0

  const { data: inserted, error: insertError } = await supabase.from('training_exercises').insert(
    sectionExercises.map((se, i) => ({
      training_id: trainingId, exercise_id: se.exercise_id, order_index: baseOrder + i,
      prescribed_sets: se.prescribed_sets, prescribed_reps: se.prescribed_reps,
      prescribed_weight: se.prescribed_weight, rest_seconds: se.rest_seconds,
      extra_fields: se.extra_fields, set_targets: se.set_targets, notes: se.notes,
      section_label: sectionName
    }))
  ).select('*, exercises(id, name, category, type, video_url, tracks_weight, is_timed, is_unilateral)')
  if (insertError) { console.log(insertError); customAlert('Something went wrong copying the exercises'); return }

  exercisesCache.push(...inserted)
  renderExercisesList()
  document.getElementById('addSectionModal').classList.remove('active')
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
  if (!name) { customAlert('Please enter a name'); return }

  const { error } = await supabase.from('trainings').update({ name }).eq('id', trainingId)
  if (error) { console.log(error); customAlert('Something went wrong'); return }

  document.getElementById('trainingNameHeading').textContent = name
  document.getElementById('renameTrainingModal').classList.remove('active')
})
