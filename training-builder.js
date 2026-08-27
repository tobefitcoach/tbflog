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
// Category chips narrow the library alongside the name search (AND) - no
// chip selected shows everything. Categories are freeform per-exercise
// text, not a fixed list, so the chip set is generated from whatever
// values are actually in use (see renderCategoryChips)
let activeCategoryFilters = new Set()
let exercisesCache = [] // last-loaded training_exercises for this training

const { data: { session } } = await supabase.auth.getSession()
if (!session) {
  window.location.href = 'login.html'
} else {
  loadTraining()
  loadExercisesList()
  loadAllExercises()
}

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
  renderCategoryChips()
  renderLibraryPanel()
}

// Rebuilds the chip row from whatever Category values are actually present
// across the library right now - same technique exercises.js's
// populateCategorySelect uses to fill its category dropdown
function renderCategoryChips() {
  const categories = [...new Set(allExercises.map(ex => ex.category).filter(Boolean))].sort()
  const row = document.getElementById('exerciseCategoryChips')
  row.innerHTML = categories.map(cat =>
    `<button type="button" class="chip-btn ${activeCategoryFilters.has(cat) ? 'selected' : ''}" data-category="${cat}">${cat}</button>`
  ).join('')
}

document.getElementById('exerciseCategoryChips').addEventListener('click', function(e) {
  const btn = e.target.closest('.chip-btn')
  if (!btn) return
  const cat = btn.dataset.category
  if (activeCategoryFilters.has(cat)) activeCategoryFilters.delete(cat)
  else activeCategoryFilters.add(cat)
  btn.classList.toggle('selected')
  renderLibraryPanel()
})

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
  let filtered = filter ? allExercises.filter(ex => ex.name.toLowerCase().includes(filter)) : allExercises
  if (activeCategoryFilters.size) filtered = filtered.filter(ex => activeCategoryFilters.has(ex.category))

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
          ${thumb ? `<img src="${thumb}" alt="" loading="lazy">` : '<span class="exercise-lib-thumb-placeholder"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="4" cy="12" r="2"></circle><circle cx="20" cy="12" r="2"></circle><line x1="6" y1="12" x2="18" y2="12"></line><line x1="9" y1="8" x2="9" y2="16"></line><line x1="15" y1="8" x2="15" y2="16"></line></svg></span>'}
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
// same as every other edit on this page. Grabbing any member of a section
// drags the whole section together - see the dataset.sectionInstanceId
// grouping below - since the whole point of a section is that it stays
// together.
let draggingCards = []

trainingDropZone.addEventListener('dragstart', function(e) {
  const handle = e.target.closest('.builder-drag-handle')
  if (!handle) return
  const card = handle.closest('.builder-exercise-card')
  const instanceId = card.dataset.sectionInstanceId
  draggingCards = instanceId
    ? [...trainingDropZone.querySelectorAll(`.builder-exercise-card[data-section-instance-id="${instanceId}"]`)]
    : [card]
  e.dataTransfer.effectAllowed = 'move'
  e.dataTransfer.setData('text/plain', '') // Firefox requires data to be set for drag to start
  e.dataTransfer.setDragImage(card, 20, 20)
  setTimeout(function() { draggingCards.forEach(c => c.classList.add('dragging')) }, 0)
})

trainingDropZone.addEventListener('dragover', function(e) {
  if (!draggingCards.length) return
  e.preventDefault()
  // Only a standalone card, or the FIRST card of a stationary section,
  // counts as a valid drop-target boundary - this is what makes it
  // impossible to drop in the middle of someone else's section
  const cards = [...trainingDropZone.querySelectorAll('.builder-exercise-card:not(.dragging)')]
  const unitLeaders = cards.filter(function(c) {
    const id = c.dataset.sectionInstanceId
    if (!id) return true
    const prev = c.previousElementSibling
    return !prev || prev.dataset.sectionInstanceId !== id
  })
  const after = unitLeaders.reduce(function(closest, card) {
    const box = card.getBoundingClientRect()
    const offset = e.clientY - box.top - box.height / 2
    return (offset < 0 && offset > closest.offset) ? { offset, element: card } : closest
  }, { offset: -Infinity, element: null }).element

  // Inserting each dragged card immediately before the same reference node,
  // in order, naturally reconstructs their original relative order right
  // before it (or, via appendChild below, at the very end)
  if (after) {
    draggingCards.forEach(c => trainingDropZone.insertBefore(c, after))
  } else {
    draggingCards.forEach(c => trainingDropZone.appendChild(c))
  }
})

trainingDropZone.addEventListener('dragend', function() {
  draggingCards.forEach(c => c.classList.remove('dragging'))
  draggingCards = []
  renderWorkoutOutline()
})

// ---- Exercise order outline (right side panel) ----
// Just names, in order - a much quicker drag target than a whole tall
// exercise card. Dragging a row here reorders the outline first, then
// applies that same order to the real cards on the left (syncCardOrder
// below) - so either list can be dragged and they stay in sync. A section
// collapses into one row here ("🧩 Warm-up A (3)") since the whole point
// of a section is that it stays together - dragging that one row moves
// every exercise underneath it as a block.
function renderWorkoutOutline() {
  const panel = document.getElementById('workoutOutlineList')
  const cards = [...trainingDropZone.querySelectorAll('.builder-exercise-card')]

  if (cards.length === 0) {
    panel.innerHTML = '<p class="no-metrics" style="font-size:12px">No exercises yet</p>'
    return
  }

  const units = []
  for (const card of cards) {
    const instanceId = card.dataset.sectionInstanceId
    const last = units[units.length - 1]
    if (instanceId && last && last.instanceId === instanceId) {
      last.cards.push(card)
    } else {
      units.push({ instanceId: instanceId || null, label: card.dataset.sectionLabel || '', cards: [card] })
    }
  }

  panel.innerHTML = units.map(function(unit, i) {
    if (unit.cards.length > 1) {
      const ids = unit.cards.map(c => c.dataset.id).join(',')
      return `
        <div class="workout-outline-item workout-outline-section" draggable="true" data-group-ids="${ids}">
          <span class="workout-outline-num">${i + 1}</span>
          <span class="workout-outline-name">${unit.label || 'Section'} (${unit.cards.length})</span>
        </div>
      `
    }
    const name = unit.cards[0].querySelector('.builder-exercise-name').textContent
    return `
      <div class="workout-outline-item" draggable="true" data-id="${unit.cards[0].dataset.id}">
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

// Reorders the real exercise cards to match the outline's current order -
// a group row carries every member's id (comma-joined) instead of just one
function syncCardOrderToOutline() {
  document.querySelectorAll('#workoutOutlineList .workout-outline-item').forEach(function(item) {
    const ids = item.dataset.groupIds ? item.dataset.groupIds.split(',') : [item.dataset.id]
    ids.forEach(function(id) {
      const card = trainingDropZone.querySelector(`.builder-exercise-card[data-id="${id}"]`)
      if (card) trainingDropZone.appendChild(card)
    })
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
  }]).select('*, exercises!exercise_id(id, name, category, type, video_url, instructions, tracks_reps, tracks_weight, is_timed, is_unilateral, tracks_distance)')

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
// Field name is picked from the coach's reusable extra_field_names library
// (see openExtraFieldPicker below) rather than typed per row - so each row
// is just a label + one value input instead of two free-text inputs, which
// is both more compact and rules out the same field ending up saved under
// two slightly different spellings on different exercises.
function addExtraFieldRow(containerId, name, value) {
  const container = document.getElementById(containerId)
  if (!container) return
  const row = document.createElement('div')
  row.className = 'extra-field-row'
  row.dataset.name = name || ''
  row.innerHTML = `
    <span class="extra-field-label">${name || ''}</span>
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
    const name = row.dataset.name
    const value = row.querySelector('.extra-field-value').value.trim()
    if (name && value) result[name] = value
  })
  return Object.keys(result).length ? result : null
}

// ==========================================================================
// ---- EXTRA FIELD PICKER ----
// Opened from a card's kebab menu (see 'add-extra-field' below) instead of
// a permanent "+ Add Field" button + two-input row sitting on every card -
// with 2-3 exercises each carrying a few sets, that was enough vertical
// space to force scrolling just to see the rest of the workout. Names come
// from extra_field_names, a small coach-wide reusable library (same
// "library" shape as exercises/sections) so a coach picks "RPE" once and
// it's there for every exercise after, instead of retyping it each time.
// ==========================================================================
let extraFieldNamesCache = null
let extraFieldPickerTeId = null

async function loadExtraFieldNames() {
  if (extraFieldNamesCache) return extraFieldNamesCache
  const { data, error } = await fetchWithRetry((signal) => supabase
    .from('extra_field_names')
    .select('id, name')
    .order('name')
    .abortSignal(signal)
  )
  if (error) { console.log(error); extraFieldNamesCache = []; return extraFieldNamesCache }
  extraFieldNamesCache = data
  return extraFieldNamesCache
}

async function openExtraFieldPicker(teId) {
  extraFieldPickerTeId = teId
  const names = await loadExtraFieldNames()
  const list = document.getElementById('extraFieldPickerList')
  list.innerHTML = names.length
    ? names.map(n => `<button type="button" class="chip-btn" data-name="${n.name}">${n.name}</button>`).join('')
    : '<p class="no-metrics">No fields created yet - add one below</p>'
  document.getElementById('newExtraFieldNameInput').value = ''
  document.getElementById('extraFieldPickerModal').classList.add('active')
}

function pickExtraField(name) {
  if (!extraFieldPickerTeId || !name) return
  const containerId = `extraFields-${extraFieldPickerTeId}`
  if (document.querySelector(`#${containerId} .extra-field-row[data-name="${name}"]`)) {
    document.getElementById('extraFieldPickerModal').classList.remove('active')
    return // already on this card - avoid a silent duplicate that only the last one would save
  }
  addExtraFieldRow(containerId, name, '')
  document.getElementById('extraFieldPickerModal').classList.remove('active')
}

document.getElementById('extraFieldPickerList').addEventListener('click', function(e) {
  const btn = e.target.closest('.chip-btn')
  if (btn) pickExtraField(btn.dataset.name)
})

document.getElementById('createExtraFieldNameBtn').addEventListener('click', async function() {
  const name = document.getElementById('newExtraFieldNameInput').value.trim()
  if (!name) return
  const { error } = await supabase.from('extra_field_names').upsert([{ coach_id: session.user.id, name }], { onConflict: 'coach_id,name' })
  if (error) { console.log(error); customAlert('Something went wrong saving that field name - try again'); return }
  extraFieldNamesCache = null
  pickExtraField(name)
})

document.getElementById('closeExtraFieldPickerBtn').addEventListener('click', function() {
  document.getElementById('extraFieldPickerModal').classList.remove('active')
})

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

// Splits any previously-stored timed value into {mm, ss} so the mm:ss input
// boxes can be prefilled - handles the "M:SS" format this app now saves,
// old plain-seconds strings ("45") from before this change, and a
// best-effort digit grab for anything else free-typed in the past ("45s")
function parseTimeToParts(val) {
  if (val == null || val === '') return { mm: 0, ss: 0 }
  const str = String(val).trim()
  const mmss = str.match(/^(\d+):(\d{1,2})$/)
  if (mmss) return { mm: parseInt(mmss[1]), ss: Math.min(parseInt(mmss[2]), 59) }
  if (/^\d+$/.test(str)) {
    const total = parseInt(str)
    return { mm: Math.floor(total / 60), ss: total % 60 }
  }
  const digits = str.match(/\d+/)
  return digits ? { mm: 0, ss: Math.min(parseInt(digits[0]), 59) } : { mm: 0, ss: 0 }
}

function renderSetTargetRow(setNumber, target, tracksReps, isTimed, tracksWeight, isUnilateral, tracksDistance, onlyRow) {
  const repsPlaceholder = 'reps' + (isUnilateral ? ' each side' : '')
  // Legacy rows (saved back when Timed replaced Reps instead of coexisting
  // with it) stored the duration IN the reps field - fall back to reading
  // it from there, but only when reps isn't ALSO being tracked, so a real
  // rep count can never get misread as a duration once both are on.
  const durationSource = target.duration != null ? target.duration : (isTimed && !tracksReps ? target.reps : null)
  const { mm, ss } = parseTimeToParts(durationSource)
  const restParts = parseTimeToParts(target.rest)
  return `
    <div class="set-target-row" data-set-number="${setNumber}">
      <span class="set-label">Set ${setNumber}</span>
      <select class="set-type-select">
        ${Object.entries(SET_TYPES).map(([value, label]) => `<option value="${value}" ${(target.type || 'main') === value ? 'selected' : ''}>${label}</option>`).join('')}
      </select>
      ${tracksReps ? `<input type="text" class="set-reps-input" value="${target.reps || ''}" placeholder="${repsPlaceholder}">` : ''}
      ${isTimed ? `
        <div class="set-time-group" title="Time - minutes:seconds">
          <span class="set-time-group-label">Time</span>
          <div class="set-time-input">
            <input type="text" inputmode="numeric" class="set-time-mm" value="${String(mm).padStart(2, '0')}" maxlength="2">
            <span class="set-time-sep">:</span>
            <input type="text" inputmode="numeric" class="set-time-ss" value="${String(ss).padStart(2, '0')}" maxlength="2">
          </div>
        </div>
      ` : ''}
      ${tracksWeight ? `<input type="number" class="set-weight-input" value="${target.weight != null ? target.weight : ''}" placeholder="kg" step="0.5">` : ''}
      ${tracksDistance ? `<input type="number" class="set-distance-input" value="${target.distance != null ? target.distance : ''}" placeholder="meters" step="1">` : ''}
      <div class="set-time-group" title="Rest - minutes:seconds">
        <span class="set-time-group-label">Rest</span>
        <div class="set-time-input">
          <input type="text" inputmode="numeric" class="set-time-mm set-rest-mm" value="${String(restParts.mm).padStart(2, '0')}" maxlength="2">
          <span class="set-time-sep">:</span>
          <input type="text" inputmode="numeric" class="set-time-ss set-rest-ss" value="${String(restParts.ss).padStart(2, '0')}" maxlength="2">
        </div>
      </div>
      <button type="button" class="set-remove-btn" data-action="remove-set" ${onlyRow ? 'disabled' : ''}>✕</button>
    </div>
  `
}

// A superset is performed as one shared round, so its exercises can't
// drift to different set counts - every other card linked to this one
// (same superset_group_id), if any.
function linkedCardsFor(card) {
  const groupId = card.dataset.supersetGroupId
  if (!groupId) return []
  return [...trainingDropZone.querySelectorAll(`.builder-exercise-card[data-superset-group-id="${groupId}"]`)].filter(c => c !== card)
}

// Reads a set row's current (possibly-edited) field values, so a new set
// added below it starts from what's already there instead of always blank -
// an untouched row's inputs are still at their blank defaults, so this
// naturally stays blank too when nothing was filled in yet.
function readSetRowValues(rowEl) {
  if (!rowEl) return { reps: null, duration: null, weight: null, rest: null, distance: null, type: 'main' }
  const repsInput = rowEl.querySelector('.set-reps-input')
  const weightInput = rowEl.querySelector('.set-weight-input')
  const distanceInput = rowEl.querySelector('.set-distance-input')
  const typeSelect = rowEl.querySelector('.set-type-select')
  const timeMm = rowEl.querySelector('.set-time-mm:not(.set-rest-mm)')
  const timeSs = rowEl.querySelector('.set-time-ss:not(.set-rest-ss)')
  const restMm = rowEl.querySelector('.set-rest-mm')
  const restSs = rowEl.querySelector('.set-rest-ss')
  return {
    reps: repsInput ? repsInput.value : null,
    duration: timeMm ? `${timeMm.value}:${timeSs.value}` : null,
    weight: weightInput && weightInput.value !== '' ? weightInput.value : null,
    distance: distanceInput && distanceInput.value !== '' ? distanceInput.value : null,
    rest: restMm ? `${restMm.value}:${restSs.value}` : null,
    type: typeSelect ? typeSelect.value : 'main'
  }
}

function addSetTargetRow(rowsEl, tracksReps, isTimed, tracksWeight, isUnilateral, tracksDistance) {
  const rows = [...rowsEl.querySelectorAll('.set-target-row')]
  if (rows.length === 1) rows[0].querySelector('.set-remove-btn').disabled = false
  const carryOver = readSetRowValues(rows[rows.length - 1])
  rowsEl.insertAdjacentHTML('beforeend', renderSetTargetRow(rows.length + 1, carryOver, tracksReps, isTimed, tracksWeight, isUnilateral, tracksDistance, false))
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
// tracks_weight/is_timed/is_unilateral/tracks_distance normally come
// straight from the exercise's own row (te.exercises) - an explicit
// *_override on THIS training_exercises row (set via a card's "Adjust
// Fields" menu, scoped to just this one workout) takes precedence instead.
// Merging the override into te.exercises here, once per fetch, means every
// existing read of te.exercises.* downstream (set-target rows, badges,
// etc.) sees the right effective value with no other changes needed.
function applyFieldOverrides(te) {
  if (!te.exercises) return
  if (te.tracks_weight_override != null) te.exercises.tracks_weight = te.tracks_weight_override
  if (te.is_timed_override != null) te.exercises.is_timed = te.is_timed_override
  if (te.is_unilateral_override != null) te.exercises.is_unilateral = te.is_unilateral_override
  if (te.tracks_distance_override != null) te.exercises.tracks_distance = te.tracks_distance_override
}

async function loadExercisesList() {
  const { data, error } = await fetchWithRetry((signal) => supabase
    .from('training_exercises')
    .select('*, exercises!exercise_id(id, name, category, type, video_url, instructions, tracks_reps, tracks_weight, is_timed, is_unilateral, tracks_distance)')
    .eq('training_id', trainingId)
    .abortSignal(signal)
  )

  if (error) { console.log('Error loading training exercises:', error); customAlert('Something went wrong loading this workout\'s exercises - check your connection and try again'); return }

  data.sort((a, b) => a.order_index - b.order_index)
  data.forEach(applyFieldOverrides)
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
  const tracksReps = !te.exercises || te.exercises.tracks_reps !== false
  const isTimed = te.exercises && te.exercises.is_timed
  const tracksWeight = !te.exercises || te.exercises.tracks_weight
  const isUnilateral = te.exercises && te.exercises.is_unilateral
  const tracksDistance = te.exercises && te.exercises.tracks_distance
  const videoUrl = (te.exercises && te.exercises.video_url) || ''
  const thumb = getYouTubeThumbnail(videoUrl)
  const targets = deriveSetTargets(te)
  const rowsHtml = targets.map((t, i) => renderSetTargetRow(i + 1, t, tracksReps, isTimed, tracksWeight, isUnilateral, tracksDistance, targets.length === 1)).join('')
  const groupMembers = te.superset_group_id ? exercisesCache.filter(other => other.id !== te.id && other.superset_group_id === te.superset_group_id) : []
  const groupColor = te.superset_group_id ? colorForSupersetGroup(te.superset_group_id) : null
  const linkTitle = groupMembers.length
    ? `Linked with ${groupMembers.map(m => m.exercises ? m.exercises.name : 'exercise').join(', ')} - tap to remove`
    : 'Link with other exercises (superset)'
  const altExercise = te.alternative_exercise_id ? allExercises.find(ex => ex.id === te.alternative_exercise_id) : null

  return `
    <div class="builder-exercise-card" data-id="${te.id}" data-superset-group-id="${te.superset_group_id || ''}" data-section-instance-id="${te.section_instance_id || ''}" data-section-label="${te.section_label || ''}">
      <div class="builder-exercise-card-header">
        <span class="builder-drag-handle" draggable="true" title="Drag to reorder">⠿</span>
        <button type="button" class="builder-exercise-thumb" ${videoUrl ? `data-video-url="${videoUrl}"` : 'disabled'}>
          ${thumb ? `<img src="${thumb}" alt="" loading="lazy">` : '<span class="builder-exercise-thumb-placeholder"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="4" cy="12" r="2"></circle><circle cx="20" cy="12" r="2"></circle><line x1="6" y1="12" x2="18" y2="12"></line><line x1="9" y1="8" x2="9" y2="16"></line><line x1="15" y1="8" x2="15" y2="16"></line></svg></span>'}
        </button>
        <div class="builder-exercise-name">${te.exercises ? te.exercises.name : 'Unknown exercise'}</div>
        ${isUnilateral ? '<span class="builder-unilateral-badge">Each Side</span>' : ''}
        ${altExercise ? `<span class="builder-unilateral-badge" title="Athletes can switch to this if they can't do the main exercise">Alt: ${altExercise.name}</span>` : ''}
        <button type="button" class="builder-link-btn ${te.superset_group_id ? 'linked' : ''}" data-action="toggle-link" style="${groupColor ? `border-color:${groupColor}; color:${groupColor}; background-color:${groupColor}22` : ''}" title="${linkTitle}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 7h3a5 5 0 0 1 5 5 5 5 0 0 1-5 5h-3m-6 0H6a5 5 0 0 1-5-5 5 5 0 0 1 5-5h3"></path><line x1="8" y1="12" x2="16" y2="12"></line></svg></button>
        <div class="kebab-menu builder-kebab-menu">
          <button type="button" class="builder-kebab-btn" data-action="toggle-kebab" title="More options">⋮</button>
          <div class="kebab-dropdown">
            <button type="button" class="kebab-item" data-action="adjust-fields">Adjust Fields</button>
            <button type="button" class="kebab-item" data-action="add-extra-field">+ Add Field</button>
            <button type="button" class="kebab-item" data-action="edit-exercise">Adjust Exercise</button>
            <button type="button" class="kebab-item" data-action="set-alternative">${altExercise ? 'Change' : 'Set'} Alternative Exercise</button>
          </div>
        </div>
        <button type="button" class="btn-delete-measurement" data-action="delete-exercise" title="Remove from workout"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg></button>
      </div>
      <div class="set-target-rows">
        ${rowsHtml}
      </div>
      <button type="button" class="builder-add-set-btn" data-action="add-set">+ Add Set</button>
      <div class="extra-fields-container" id="extraFields-${te.id}"></div>
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

  const te = exercisesCache.find(t => t.id === teId)
  const tracksReps = !!(te && (!te.exercises || te.exercises.tracks_reps !== false))
  const isTimed = !!(te && te.exercises && te.exercises.is_timed)

  const rows = [...card.querySelectorAll('.set-target-row')]
  const setTargets = rows.map(row => {
    const repsInput = row.querySelector('.set-reps-input')
    const reps = repsInput ? (repsInput.value.trim() || null) : null
    let duration = null
    if (isTimed) {
      const mm = parseInt(row.querySelector('.set-time-mm').value) || 0
      const ss = parseInt(row.querySelector('.set-time-ss').value) || 0
      duration = (mm === 0 && ss === 0) ? null : `${mm}:${String(ss).padStart(2, '0')}`
    }
    const weightInput = row.querySelector('.set-weight-input')
    const weight = weightInput && weightInput.value ? parseFloat(weightInput.value) : null
    const distanceInput = row.querySelector('.set-distance-input')
    const distance = distanceInput && distanceInput.value ? parseFloat(distanceInput.value) : null
    const restMm = parseInt(row.querySelector('.set-rest-mm').value) || 0
    const restSs = parseInt(row.querySelector('.set-rest-ss').value) || 0
    const rest = (restMm === 0 && restSs === 0) ? null : restMm * 60 + restSs
    const type = row.querySelector('.set-type-select').value
    return { reps, duration, weight, distance, rest, type }
  })

  const notes = card.querySelector('.exercise-notes-input').value.trim() || null
  const extraFields = collectExtraFields(`extraFields-${teId}`)
  const first = setTargets[0] || { reps: null, duration: null, weight: null, rest: null }

  const { error } = await supabase
    .from('training_exercises')
    .update({
      set_targets: setTargets,
      prescribed_sets: setTargets.length,
      // Legacy single-value column, still read by places that predate the
      // set_targets pyramid - falls back to duration so a purely-timed
      // exercise still shows something sensible there
      prescribed_reps: first.reps != null ? first.reps : first.duration,
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
    btn.textContent = 'Save'
    return
  }

  if (params.get('embed') === '1') {
    await loadExercisesList()
    btn.textContent = 'Saved!'
    setTimeout(function() { btn.disabled = false; btn.textContent = 'Save' }, 1200)
  } else {
    window.location.href = 'trainings.html'
  }
})

// Removes just this one card instead of reloading + re-rendering the whole
// list, so any unsaved edits sitting in other cards' rows aren't wiped out
async function deleteExerciseRow(id) {
  if (!(await customConfirm('Remove this exercise from the workout?'))) return

  const card = document.querySelector(`.builder-exercise-card[data-id="${id}"]`)
  if (card && card.dataset.supersetGroupId) removeFromSupersetGroup(id, trainingDropZone)

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
// ---- SUPERSETS (link up to 4 exercises into one giant-set group) ----
// Draft-until-Save, exactly like set_targets/notes - a link only becomes
// real when saveExerciseCard's payload includes it. Picking mode only
// marks OTHER cards in this same training as pickable, since every member
// of a group always has to be within the same exercise list.
// ==========================================================================
let pickingGroupIds = null // array being built while picking, else null
const SUPERSET_CAP = 4

function handleLinkClick(id, listScopeEl) {
  const card = listScopeEl.querySelector(`.builder-exercise-card[data-id="${id}"]`)
  const currentGroupId = card.dataset.supersetGroupId || null
  if (currentGroupId && !pickingGroupIds) { removeFromSupersetGroup(id, listScopeEl); return }
  if (pickingGroupIds && pickingGroupIds[0] === id) { finalizePicking(listScopeEl); return }
  if (pickingGroupIds && pickingGroupIds.includes(id)) return // already picked, not the original - ignore
  if (pickingGroupIds) { addToPickingGroup(id, listScopeEl); return }
  enterPickingMode(id, listScopeEl)
}

function enterPickingMode(id, listScopeEl) {
  pickingGroupIds = [id]
  refreshPickingHighlight(listScopeEl)
  updatePickingModeBar(listScopeEl)
}

// Tapping another unlinked card adds it to the group being built - once
// the cap is hit the group finalizes on its own, no extra tap needed
function addToPickingGroup(id, listScopeEl) {
  pickingGroupIds.push(id)
  if (pickingGroupIds.length >= SUPERSET_CAP) { finalizePicking(listScopeEl); return }
  refreshPickingHighlight(listScopeEl)
  updatePickingModeBar(listScopeEl)
}

function refreshPickingHighlight(listScopeEl) {
  listScopeEl.querySelectorAll('.builder-exercise-card').forEach(card => {
    const picked = pickingGroupIds.includes(card.dataset.id)
    const isLinked = !!card.dataset.supersetGroupId
    card.classList.toggle('picking-self', picked)
    card.classList.toggle('pickable', !picked && !isLinked)
  })
}

function exitPickingMode(listScopeEl) {
  pickingGroupIds = null
  listScopeEl.querySelectorAll('.builder-exercise-card').forEach(c => c.classList.remove('picking-self', 'pickable'))
  updatePickingModeBar(listScopeEl)
}

// Floating bar shown only while picking mode is active - the only way to
// confirm a superset used to be tapping the original card's 🔗 button
// again (undiscoverable, no visible affordance), so this gives an explicit
// "Finish Superset" button for stopping at 2 or 3 instead of the 4-cap
function updatePickingModeBar(listScopeEl) {
  const bar = document.getElementById('pickingModeBar')
  if (!bar) return
  if (!pickingGroupIds) { bar.style.display = 'none'; return }
  bar.style.display = 'flex'
  const n = pickingGroupIds.length
  document.getElementById('pickingModeBarCount').textContent = `${n} exercise${n === 1 ? '' : 's'} selected`
  const finishBtn = document.getElementById('pickingModeBarFinishBtn')
  finishBtn.disabled = n < 2
  finishBtn.onclick = () => finalizePicking(listScopeEl)
  document.getElementById('pickingModeBarCancelBtn').onclick = () => exitPickingMode(listScopeEl)
}

// Tapping the original card again finishes early with fewer than the cap -
// needs at least 2 to actually form a group, otherwise it's just a cancel
function finalizePicking(listScopeEl) {
  if (pickingGroupIds.length < 2) { exitPickingMode(listScopeEl); return }
  const groupId = crypto.randomUUID()
  const ids = pickingGroupIds
  ids.forEach(id => {
    listScopeEl.querySelector(`.builder-exercise-card[data-id="${id}"]`).dataset.supersetGroupId = groupId
  })
  exitPickingMode(listScopeEl)
  ids.forEach(id => refreshSupersetBadge(listScopeEl.querySelector(`.builder-exercise-card[data-id="${id}"]`)))
}

// Removes just this one card from its group (tapped via 🔗, or from
// deleteExerciseRow) - if that would leave only one member, that last one
// is cleared too, since a "group of 1" isn't a superset
function removeFromSupersetGroup(id, listScopeEl) {
  const card = listScopeEl.querySelector(`.builder-exercise-card[data-id="${id}"]`)
  const groupId = card.dataset.supersetGroupId
  if (!groupId) return
  delete card.dataset.supersetGroupId
  const remaining = [...listScopeEl.querySelectorAll(`.builder-exercise-card[data-superset-group-id="${groupId}"]`)]
  if (remaining.length === 1) delete remaining[0].dataset.supersetGroupId
  refreshSupersetBadge(card)
  remaining.forEach(refreshSupersetBadge)
}

// Deterministic color per superset group id, so several groups on the
// same list are visually distinguishable at a glance without spelling out
// which exercises are linked (that's in the 🔗 button's title tooltip
// instead) - same group id always resolves to the same color
const SUPERSET_COLORS = ['#4a4a8e', '#e0a030', '#3aa66e', '#c0466e', '#3a8ec0', '#a05fd6', '#c07a2e', '#5fb8b8']
function colorForSupersetGroup(groupId) {
  let hash = 0
  for (let i = 0; i < groupId.length; i++) hash = (hash * 31 + groupId.charCodeAt(i)) >>> 0
  return SUPERSET_COLORS[hash % SUPERSET_COLORS.length]
}

function refreshSupersetBadge(card) {
  const linkBtn = card.querySelector('.builder-link-btn')
  const groupId = card.dataset.supersetGroupId
  linkBtn.classList.toggle('linked', !!groupId)

  if (!groupId) {
    linkBtn.style.borderColor = ''
    linkBtn.style.color = ''
    linkBtn.style.backgroundColor = ''
    linkBtn.title = 'Link with other exercises (superset)'
    return
  }

  const color = colorForSupersetGroup(groupId)
  linkBtn.style.borderColor = color
  linkBtn.style.color = color
  linkBtn.style.backgroundColor = color + '22'

  const others = [...trainingDropZone.querySelectorAll(`.builder-exercise-card[data-superset-group-id="${groupId}"]`)].filter(c => c !== card)
  const names = others.map(c => c.querySelector('.builder-exercise-name').textContent).filter(Boolean)
  linkBtn.title = names.length ? `Linked with ${names.join(', ')} - tap to remove` : 'Remove from superset'
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
  const tracksReps = !!(te && (!te.exercises || te.exercises.tracks_reps !== false))
  const isTimed = !!(te && te.exercises && te.exercises.is_timed)
  const tracksWeight = !!(te && (!te.exercises || te.exercises.tracks_weight))
  const isUnilateral = !!(te && te.exercises && te.exercises.is_unilateral)
  const tracksDistance = !!(te && te.exercises && te.exercises.tracks_distance)

  if (btn.dataset.action === 'add-set') {
    addSetTargetRow(card.querySelector('.set-target-rows'), tracksReps, isTimed, tracksWeight, isUnilateral, tracksDistance)
    for (const other of linkedCardsFor(card)) {
      const oTe = exercisesCache.find(t => t.id === other.dataset.id)
      addSetTargetRow(
        other.querySelector('.set-target-rows'),
        !!(oTe && (!oTe.exercises || oTe.exercises.tracks_reps !== false)),
        !!(oTe && oTe.exercises && oTe.exercises.is_timed),
        !!(oTe && (!oTe.exercises || oTe.exercises.tracks_weight)),
        !!(oTe && oTe.exercises && oTe.exercises.is_unilateral),
        !!(oTe && oTe.exercises && oTe.exercises.tracks_distance)
      )
    }
  } else if (btn.dataset.action === 'remove-set') {
    const row = btn.closest('.set-target-row')
    const setNumber = row.dataset.setNumber
    removeSetTargetRow(row)
    for (const other of linkedCardsFor(card)) {
      const otherRow = other.querySelector(`.set-target-row[data-set-number="${setNumber}"]`)
      // Never drop a linked card to zero rows even if counts had somehow
      // already drifted apart - same floor the remove button's own
      // disabled state already enforces for a single card
      if (otherRow && other.querySelectorAll('.set-target-row').length > 1) removeSetTargetRow(otherRow)
    }
  } else if (btn.dataset.action === 'delete-exercise') {
    await deleteExerciseRow(teId)
  } else if (btn.dataset.action === 'add-extra-field') {
    btn.closest('.kebab-dropdown')?.classList.remove('active')
    openExtraFieldPicker(teId)
  } else if (btn.dataset.action === 'toggle-link') {
    handleLinkClick(teId, trainingDropZone)
  } else if (btn.dataset.action === 'toggle-kebab') {
    const dropdown = btn.parentElement.querySelector('.kebab-dropdown')
    const wasActive = dropdown.classList.contains('active')
    document.querySelectorAll('#trainingExercisesList .kebab-dropdown.active').forEach(d => d.classList.remove('active'))
    if (!wasActive) dropdown.classList.add('active')
  } else if (btn.dataset.action === 'adjust-fields') {
    btn.closest('.kebab-dropdown').classList.remove('active')
    openAdjustFieldsModal(te)
  } else if (btn.dataset.action === 'set-alternative') {
    btn.closest('.kebab-dropdown').classList.remove('active')
    openSetAlternativeModal(te)
  } else if (btn.dataset.action === 'edit-exercise') {
    btn.closest('.kebab-dropdown').classList.remove('active')
    if (te && te.exercises) openExerciseModal(te.exercises)
  }
})

// Kebab dropdowns (see toggle-kebab above) close on their own toggle or on
// picking an item, but not yet on an outside click - add that here so one
// left open doesn't linger while the coach works on other cards
document.addEventListener('click', function(e) {
  if (e.target.closest('.builder-kebab-menu')) return
  document.querySelectorAll('#trainingExercisesList .kebab-dropdown.active').forEach(d => d.classList.remove('active'))
})

// ==========================================================================
// ---- ADJUST FIELDS (from an exercise card's ⋮ menu) ----
// tracks_weight/is_timed/is_unilateral/tracks_distance normally come from
// the exercise's own row (Exercise Library's own edit modal). This saves
// an override on THIS training_exercises row instead - scoped to just this
// one workout, never touching the shared exercise (see the 4 *_override
// columns added alongside this feature). The checkboxes start from the
// resolved effective value (applyFieldOverrides already merged any
// existing override into te.exercises at load time), so Save always
// writes a full, explicit snapshot of all 4 fields as this instance's
// override - simple and predictable, at the cost of no longer tracking
// the exercise's default if it changes later (expected: an adjustment is
// a deliberate one-off pin, not a subscription to future defaults).
// ==========================================================================
let adjustFieldsTeId = null

function openAdjustFieldsModal(te) {
  if (!te) return
  adjustFieldsTeId = te.id
  document.getElementById('adjustFieldsExerciseName').textContent = te.exercises ? te.exercises.name : ''
  document.getElementById('adjustFieldsTracksWeight').checked = !te.exercises || !!te.exercises.tracks_weight
  document.getElementById('adjustFieldsIsTimed').checked = !!(te.exercises && te.exercises.is_timed)
  document.getElementById('adjustFieldsIsUnilateral').checked = !!(te.exercises && te.exercises.is_unilateral)
  document.getElementById('adjustFieldsTracksDistance').checked = !!(te.exercises && te.exercises.tracks_distance)
  document.getElementById('adjustFieldsModal').classList.add('active')
}

document.getElementById('closeAdjustFieldsBtn').addEventListener('click', function() {
  document.getElementById('adjustFieldsModal').classList.remove('active')
})
document.getElementById('cancelAdjustFieldsBtn').addEventListener('click', function() {
  document.getElementById('adjustFieldsModal').classList.remove('active')
})

document.getElementById('saveAdjustFieldsBtn').addEventListener('click', async function() {
  if (!adjustFieldsTeId) return
  const updates = {
    tracks_weight_override: document.getElementById('adjustFieldsTracksWeight').checked,
    is_timed_override: document.getElementById('adjustFieldsIsTimed').checked,
    is_unilateral_override: document.getElementById('adjustFieldsIsUnilateral').checked,
    tracks_distance_override: document.getElementById('adjustFieldsTracksDistance').checked
  }
  const { error } = await supabase.from('training_exercises').update(updates).eq('id', adjustFieldsTeId)
  if (error) { console.log(error); customAlert('Something went wrong saving those fields - try again'); return }

  const te = exercisesCache.find(t => t.id === adjustFieldsTeId)
  if (te) {
    Object.assign(te, updates)
    applyFieldOverrides(te)
    const card = document.querySelector(`.builder-exercise-card[data-id="${te.id}"]`)
    if (card) {
      card.outerHTML = renderExerciseCard(te)
      if (te.extra_fields) {
        for (const [k, v] of Object.entries(te.extra_fields)) addExtraFieldRow(`extraFields-${te.id}`, k, v)
      }
    }
  }

  document.getElementById('adjustFieldsModal').classList.remove('active')
})

// ==========================================================================
// ---- SET ALTERNATIVE EXERCISE ----
// A coach-curated single fallback exercise for when an athlete can't do the
// prescribed one (no equipment, an injury) - shown to the athlete as a
// quick one-tap icon during the guided workout instead of the free-search
// Swap button. Search reuses allExercises, the same library cache already
// loaded for the drag-in panel on the left - no separate query needed.
// ==========================================================================
let setAlternativeTeId = null

function openSetAlternativeModal(te) {
  if (!te) return
  setAlternativeTeId = te.id
  document.getElementById('setAlternativeExerciseName').textContent = te.exercises ? `For: ${te.exercises.name}` : ''
  document.getElementById('setAlternativeSearchInput').value = ''
  const removeBtn = document.getElementById('removeAlternativeBtn')
  removeBtn.style.display = te.alternative_exercise_id ? '' : 'none'
  renderSetAlternativeList()
  document.getElementById('setAlternativeModal').classList.add('active')
}

function renderSetAlternativeList() {
  const filter = document.getElementById('setAlternativeSearchInput').value.trim().toLowerCase()
  const te = exercisesCache.find(t => t.id === setAlternativeTeId)
  const ownExerciseId = te ? te.exercise_id : null
  const filtered = (filter ? allExercises.filter(ex => ex.name.toLowerCase().includes(filter)) : allExercises)
    .filter(ex => ex.id !== ownExerciseId)

  const list = document.getElementById('setAlternativeList')
  if (filtered.length === 0) {
    list.innerHTML = '<p class="no-metrics">No exercises found</p>'
    return
  }
  list.innerHTML = filtered.map(ex => {
    const thumb = getYouTubeThumbnail(ex.video_url)
    return `
      <div class="exercise-lib-card" data-id="${ex.id}">
        <div class="exercise-lib-thumb">
          ${thumb ? `<img src="${thumb}" alt="" loading="lazy">` : '<span class="exercise-lib-thumb-placeholder"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="4" cy="12" r="2"></circle><circle cx="20" cy="12" r="2"></circle><line x1="6" y1="12" x2="18" y2="12"></line><line x1="9" y1="8" x2="9" y2="16"></line><line x1="15" y1="8" x2="15" y2="16"></line></svg></span>'}
        </div>
        <span class="exercise-lib-name">${ex.name}</span>
      </div>
    `
  }).join('')
}

document.getElementById('setAlternativeSearchInput').addEventListener('input', renderSetAlternativeList)

document.getElementById('setAlternativeList').addEventListener('click', async function(e) {
  const item = e.target.closest('.exercise-lib-card')
  if (item) await saveAlternativeExercise(setAlternativeTeId, item.dataset.id)
})

document.getElementById('removeAlternativeBtn').addEventListener('click', async function() {
  await saveAlternativeExercise(setAlternativeTeId, null)
})

document.getElementById('closeSetAlternativeBtn').addEventListener('click', function() {
  document.getElementById('setAlternativeModal').classList.remove('active')
})

async function saveAlternativeExercise(teId, altExerciseId) {
  if (!teId) return
  const { error } = await supabase.from('training_exercises').update({ alternative_exercise_id: altExerciseId }).eq('id', teId)
  if (error) { console.log(error); customAlert('Something went wrong saving that - try again'); return }

  const te = exercisesCache.find(t => t.id === teId)
  if (te) {
    te.alternative_exercise_id = altExerciseId
    const card = document.querySelector(`.builder-exercise-card[data-id="${te.id}"]`)
    if (card) {
      card.outerHTML = renderExerciseCard(te)
      if (te.extra_fields) {
        for (const [k, v] of Object.entries(te.extra_fields)) addExtraFieldRow(`extraFields-${te.id}`, k, v)
      }
    }
  }

  document.getElementById('setAlternativeModal').classList.remove('active')
}

// mm:ss time boxes: strip anything non-digit as it's typed, then pad back
// to 2 digits (and clamp seconds to 59) once the coach taps away. Selects
// the "00" on focus so typing a digit replaces it instead of needing a
// manual delete first
document.getElementById('trainingExercisesList').addEventListener('focusin', function(e) {
  if (e.target.matches('.set-time-mm, .set-time-ss')) {
    e.target.select()
  }
})
document.getElementById('trainingExercisesList').addEventListener('input', function(e) {
  if (e.target.matches('.set-time-mm, .set-time-ss')) {
    e.target.value = e.target.value.replace(/\D/g, '').slice(0, 2)
  }
})
document.getElementById('trainingExercisesList').addEventListener('focusout', function(e) {
  if (e.target.matches('.set-time-mm, .set-time-ss')) {
    const max = e.target.classList.contains('set-time-ss') ? 59 : 99
    const val = Math.min(parseInt(e.target.value) || 0, max)
    e.target.value = String(val).padStart(2, '0')
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

// Nudges the logging-field toggles to their common defaults when the coach
// actually picks a type - the coach can still flip either toggle back
// afterward for a less common combination (e.g. a weighted timed hold)
function applyTypeLoggingDefaults(type) {
  if (type === 'timed') {
    document.getElementById('tCreateExerciseTracksReps').checked = false
    document.getElementById('tCreateExerciseIsTimed').checked = true
    document.getElementById('tCreateExerciseTracksWeight').checked = false
  } else if (type === 'weights') {
    document.getElementById('tCreateExerciseTracksReps').checked = true
    document.getElementById('tCreateExerciseIsTimed').checked = false
    document.getElementById('tCreateExerciseTracksWeight').checked = true
  }
}

document.getElementById('tCreateExerciseType').addEventListener('change', function() {
  toggleCreateNewTypeField()
  applyTypeLoggingDefaults(this.value)
})

// null while creating a brand new exercise; the exercise's id while
// "Adjust Exercise" (a workout card's kebab menu) is editing an existing
// one in place - both share this one modal, just with different
// title/button and a different save handler (see openExerciseModal below
// and the two save button handlers)
let editingExerciseId = null

document.getElementById('openCreateExerciseBtn').addEventListener('click', function() {
  editingExerciseId = null
  document.getElementById('tCreateExerciseModalTitle').textContent = 'Create New Exercise'
  document.getElementById('saveTCreateExerciseBtn').style.display = ''
  document.getElementById('saveTEditExerciseBtn').style.display = 'none'
  document.getElementById('tCreateExerciseName').value = ''
  document.getElementById('tCreateExerciseNewCategory').value = ''
  populateCreateCategorySelect()
  document.getElementById('tCreateExerciseNewType').value = ''
  populateCreateTypeSelect()
  document.getElementById('tCreateExerciseTracksReps').checked = true
  document.getElementById('tCreateExerciseTracksWeight').checked = true
  document.getElementById('tCreateExerciseIsTimed').checked = false
  document.getElementById('tCreateExerciseIsUnilateral').checked = false
  document.getElementById('tCreateExerciseTracksDistance').checked = false
  document.getElementById('tCreateExerciseVideoUrl').value = ''
  document.getElementById('tCreateExerciseInstructions').value = ''
  document.getElementById('tCreateExerciseModal').classList.add('active')
})

// Opened from a workout card's kebab "Adjust Exercise" - same modal as
// creating one, prefilled with the exercise's current real values (this
// edits the actual Exercise Library row, not just this one workout's
// instance of it - see openAdjustFieldsModal for the per-instance version).
function openExerciseModal(exercise) {
  editingExerciseId = exercise.id
  document.getElementById('tCreateExerciseModalTitle').textContent = 'Adjust Exercise'
  document.getElementById('saveTCreateExerciseBtn').style.display = 'none'
  document.getElementById('saveTEditExerciseBtn').style.display = ''
  document.getElementById('tCreateExerciseName').value = exercise.name || ''
  document.getElementById('tCreateExerciseNewCategory').value = ''
  populateCreateCategorySelect()
  document.getElementById('tCreateExerciseCategory').value = exercise.category || ''
  document.getElementById('tCreateExerciseNewType').value = ''
  populateCreateTypeSelect()
  document.getElementById('tCreateExerciseType').value = exercise.type || 'weights'
  toggleCreateNewCategoryField()
  toggleCreateNewTypeField()
  document.getElementById('tCreateExerciseTracksReps').checked = exercise.tracks_reps !== false
  document.getElementById('tCreateExerciseTracksWeight').checked = !!exercise.tracks_weight
  document.getElementById('tCreateExerciseIsTimed').checked = !!exercise.is_timed
  document.getElementById('tCreateExerciseIsUnilateral').checked = !!exercise.is_unilateral
  document.getElementById('tCreateExerciseTracksDistance').checked = !!exercise.tracks_distance
  document.getElementById('tCreateExerciseVideoUrl').value = exercise.video_url || ''
  document.getElementById('tCreateExerciseInstructions').value = exercise.instructions || ''
  document.getElementById('tCreateExerciseModal').classList.add('active')
}

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
  const tracksReps = document.getElementById('tCreateExerciseTracksReps').checked
  const tracksWeight = document.getElementById('tCreateExerciseTracksWeight').checked
  const isTimed = document.getElementById('tCreateExerciseIsTimed').checked
  const isUnilateral = document.getElementById('tCreateExerciseIsUnilateral').checked
  const tracksDistance = document.getElementById('tCreateExerciseTracksDistance').checked

  if (!name) { customAlert('Please enter a name'); return }

  const { data, error } = await supabase
    .from('exercises')
    .insert([{ coach_id: session.user.id, name, category, type, video_url: videoUrl, instructions, tracks_reps: tracksReps, tracks_weight: tracksWeight, is_timed: isTimed, is_unilateral: isUnilateral, tracks_distance: tracksDistance }])
    .select()

  if (error) { console.log(error); customAlert('Something went wrong'); return }

  allExercises.push(data[0])
  allExercises.sort((a, b) => a.name.localeCompare(b.name))
  renderCategoryChips()
  renderLibraryPanel()
  document.getElementById('tCreateExerciseModal').classList.remove('active')
  await addExerciseToTraining(data[0].id)
})

// Edits the real Exercise Library row in place (name/category/type/logging
// fields/video/instructions) - every workout card using this exercise,
// in this training and any other, sees the change immediately since they
// all just reference the same exercises.id. foot_contacts/intensity_tier
// (Plyometric-only fields, no UI in this modal) are deliberately left out
// of the update payload so this never silently clears them.
document.getElementById('saveTEditExerciseBtn').addEventListener('click', async function() {
  if (!editingExerciseId) return
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
  const tracksReps = document.getElementById('tCreateExerciseTracksReps').checked
  const tracksWeight = document.getElementById('tCreateExerciseTracksWeight').checked
  const isTimed = document.getElementById('tCreateExerciseIsTimed').checked
  const isUnilateral = document.getElementById('tCreateExerciseIsUnilateral').checked
  const tracksDistance = document.getElementById('tCreateExerciseTracksDistance').checked

  if (!name) { customAlert('Please enter a name'); return }

  const updates = { name, category, type, video_url: videoUrl, instructions, tracks_reps: tracksReps, tracks_weight: tracksWeight, is_timed: isTimed, is_unilateral: isUnilateral, tracks_distance: tracksDistance }
  const { error } = await supabase.from('exercises').update(updates).eq('id', editingExerciseId)
  if (error) { console.log(error); customAlert('Something went wrong saving that - try again'); return }

  const cachedEx = allExercises.find(ex => ex.id === editingExerciseId)
  if (cachedEx) Object.assign(cachedEx, updates)
  allExercises.sort((a, b) => a.name.localeCompare(b.name))
  for (const te of exercisesCache) {
    if (te.exercises && te.exercises.id === editingExerciseId) Object.assign(te.exercises, updates)
  }

  renderCategoryChips()
  renderLibraryPanel()
  renderExercisesList()
  document.getElementById('tCreateExerciseModal').classList.remove('active')
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
      <div class="workout-preview-thumb">${thumb ? `<img src="${thumb}" alt="" loading="lazy">` : '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="4" cy="12" r="2"></circle><circle cx="20" cy="12" r="2"></circle><line x1="6" y1="12" x2="18" y2="12"></line><line x1="9" y1="8" x2="9" y2="16"></line><line x1="15" y1="8" x2="15" y2="16"></line></svg>'}</div>
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

  // Fresh group id per distinct superset_group_id in this batch, so
  // inserting the same section twice into one training doesn't make both
  // copies' supersets collide into a single group - same reasoning as the
  // baseOrder offset just above, applied to group ids instead of order_index
  const groupIdMap = {}
  for (const se of sectionExercises) {
    if (se.superset_group_id && !groupIdMap[se.superset_group_id]) groupIdMap[se.superset_group_id] = crypto.randomUUID()
  }

  // One id shared by the WHOLE batch (unlike groupIdMap above, which is
  // per superset sub-group within the batch) - this is what keeps the
  // section together as a single block in the drag-reorder UI from now on
  const sectionInstanceId = crypto.randomUUID()

  const { data: inserted, error: insertError } = await supabase.from('training_exercises').insert(
    sectionExercises.map((se, i) => ({
      training_id: trainingId, exercise_id: se.exercise_id, order_index: baseOrder + i,
      prescribed_sets: se.prescribed_sets, prescribed_reps: se.prescribed_reps,
      prescribed_weight: se.prescribed_weight, rest_seconds: se.rest_seconds,
      extra_fields: se.extra_fields, set_targets: se.set_targets, notes: se.notes,
      section_label: sectionName,
      section_instance_id: sectionInstanceId,
      superset_group_id: se.superset_group_id ? groupIdMap[se.superset_group_id] : null
    }))
  ).select('*, exercises!exercise_id(id, name, category, type, video_url, instructions, tracks_reps, tracks_weight, is_timed, is_unilateral, tracks_distance)')
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
