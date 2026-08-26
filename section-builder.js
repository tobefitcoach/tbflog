// ==========================================================================
// SECTION BUILDER
// Edits one section's flat exercise list. Direct copy-adapt of
// training-builder.js (a section is really "a training-shaped block that
// gets pasted into something else") - same picker/edit patterns, just
// against sections/section_exercises instead of trainings/training_exercises.
// A section's own exercises never show a section_label header - a section
// IS the group being defined, and section_label is stamped onto the
// exercises only once they're copied out into a real training/day. Sets
// CAN be linked into supersets within a section though, and that link
// carries through the clone (see insertSectionInto*'s group-id remapping
// in training-builder.js/program-builder.js/athlete-calendar.js).
// ==========================================================================
import { supabase } from './coachClient.js'

const params = new URLSearchParams(window.location.search)
const sectionId = params.get('id')

let allExercises = []
let exercisesCache = [] // last-loaded section_exercises for this section
// Category chips narrow the library alongside the name search (AND) - no
// chip selected shows everything. Categories are freeform per-exercise
// text, not a fixed list, so the chip set is generated from whatever
// values are actually in use (see renderCategoryChips)
let activeCategoryFilters = new Set()

const { data: { session } } = await supabase.auth.getSession()
if (!session) {
  window.location.href = 'login.html'
} else {
  loadSection()
  loadExercisesList()
  loadAllExercises()
}

// ==========================================================================
// ---- LOAD SECTION NAME ----
// ==========================================================================
async function loadSection() {
  const { data, error } = await fetchWithRetry((signal) => supabase
    .from('sections')
    .select('*')
    .eq('id', sectionId)
    .single()
    .abortSignal(signal)
  )

  if (error) {
    console.log('Error loading section:', error)
    document.getElementById('sectionNameHeading').textContent = 'Section not found'
    customAlert('Something went wrong loading this section - check your connection and try again')
    return
  }

  document.getElementById('sectionNameHeading').textContent = data.name
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
          ${thumb ? `<img src="${thumb}" alt="" loading="lazy">` : '<span class="exercise-lib-thumb-placeholder">🏋</span>'}
        </div>
        <span class="exercise-lib-name">${ex.name}</span>
      </div>
    `
  }).join('')
}

document.getElementById('exerciseSearchInput').addEventListener('input', renderLibraryPanel)

// ---- Drag from the library panel, drop onto the section's exercise list ----
document.getElementById('exerciseLibraryList').addEventListener('dragstart', function(e) {
  const card = e.target.closest('.exercise-lib-card')
  if (!card) return
  e.dataTransfer.setData('text/plain', card.dataset.id)
})

const sectionDropZone = document.getElementById('sectionExercisesList')

sectionDropZone.addEventListener('dragover', function(e) {
  e.preventDefault()
  if (!draggingCard) sectionDropZone.classList.add('drag-over')
})

sectionDropZone.addEventListener('dragleave', function() {
  sectionDropZone.classList.remove('drag-over')
})

sectionDropZone.addEventListener('drop', async function(e) {
  e.preventDefault()
  sectionDropZone.classList.remove('drag-over')
  const exerciseId = e.dataTransfer.getData('text/plain')
  if (exerciseId) await addExerciseToSection(exerciseId)
})

// ---- Reorder exercises already in the section by dragging the ⠿ handle ----
// Purely a DOM reorder while dragging (no network call) - the new order is
// only written to order_index when the page's own Save button is pressed,
// same as every other edit on this page.
let draggingCard = null

sectionDropZone.addEventListener('dragstart', function(e) {
  const handle = e.target.closest('.builder-drag-handle')
  if (!handle) return
  draggingCard = handle.closest('.builder-exercise-card')
  e.dataTransfer.effectAllowed = 'move'
  e.dataTransfer.setData('text/plain', '') // Firefox requires data to be set for drag to start
  e.dataTransfer.setDragImage(draggingCard, 20, 20)
  setTimeout(function() { draggingCard.classList.add('dragging') }, 0)
})

sectionDropZone.addEventListener('dragover', function(e) {
  if (!draggingCard) return
  e.preventDefault()
  const cards = [...sectionDropZone.querySelectorAll('.builder-exercise-card:not(.dragging)')]
  const after = cards.reduce(function(closest, card) {
    const box = card.getBoundingClientRect()
    const offset = e.clientY - box.top - box.height / 2
    return (offset < 0 && offset > closest.offset) ? { offset, element: card } : closest
  }, { offset: -Infinity, element: null }).element

  if (after) {
    sectionDropZone.insertBefore(draggingCard, after)
  } else {
    sectionDropZone.appendChild(draggingCard)
  }
})

sectionDropZone.addEventListener('dragend', function() {
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
  const cards = [...sectionDropZone.querySelectorAll('.builder-exercise-card')]

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
    const card = sectionDropZone.querySelector(`.builder-exercise-card[data-id="${id}"]`)
    if (card) sectionDropZone.appendChild(card)
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
async function addExerciseToSection(exerciseId) {
  const nextOrder = exercisesCache.length ? Math.max(...exercisesCache.map(se => se.order_index)) + 1 : 0

  const { data, error } = await supabase.from('section_exercises').insert([{
    section_id: sectionId,
    exercise_id: exerciseId,
    order_index: nextOrder
  }]).select('*, exercises(id, name, category, type, video_url, tracks_weight, is_timed, is_unilateral, tracks_distance)')

  if (error) { console.log(error); customAlert('Something went wrong'); return }

  const newRow = data[0]
  exercisesCache.push(newRow)

  const container = document.getElementById('sectionExercisesList')
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
// A section_exercises row keeps one set_targets array
// ([{reps, weight, rest, type}, ...], index 0 = Set 1) so each set can have
// its own target AND its own rest afterward AND its own type (warmup / main
// / failure) - same shape training-builder.js/program-builder.js use.
// prescribed_sets/prescribed_reps/prescribed_weight/rest_seconds are kept
// in sync purely so every other place that only reads those old columns
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

function renderSetTargetRow(setNumber, target, isTimed, tracksWeight, isUnilateral, onlyRow) {
  const repsPlaceholder = (isTimed ? 'e.g. 45 sec' : 'reps') + (isUnilateral ? ' each side' : '')
  const restParts = parseTimeToParts(target.rest)
  return `
    <div class="set-target-row" data-set-number="${setNumber}">
      <span class="set-label">Set ${setNumber}</span>
      <select class="set-type-select">
        ${Object.entries(SET_TYPES).map(([value, label]) => `<option value="${value}" ${(target.type || 'main') === value ? 'selected' : ''}>${label}</option>`).join('')}
      </select>
      <input type="text" class="set-reps-input" value="${target.reps || ''}" placeholder="${repsPlaceholder}">
      ${tracksWeight ? `<input type="number" class="set-weight-input" value="${target.weight != null ? target.weight : ''}" placeholder="kg" step="0.5">` : ''}
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
    .from('section_exercises')
    .select('*, exercises(id, name, category, type, video_url, tracks_weight, is_timed, is_unilateral, tracks_distance)')
    .eq('section_id', sectionId)
    .abortSignal(signal)
  )

  if (error) { console.log('Error loading section exercises:', error); customAlert('Something went wrong loading this section\'s exercises - check your connection and try again'); return }

  data.sort((a, b) => a.order_index - b.order_index)
  exercisesCache = data
  renderExercisesList()
}

function renderExercisesList() {
  const container = document.getElementById('sectionExercisesList')

  if (exercisesCache.length === 0) {
    container.innerHTML = '<p class="no-metrics">No exercises yet — drag one in from the library on the left</p>'
    return
  }

  container.innerHTML = exercisesCache.map(renderExerciseCard).join('')

  // innerHTML wipes any dynamically-built children, so extra field rows
  // (built with document.createElement, not template strings) get
  // re-populated here for every card
  for (const se of exercisesCache) {
    if (se.extra_fields) {
      for (const [k, v] of Object.entries(se.extra_fields)) addExtraFieldRow(`extraFields-${se.id}`, k, v)
    }
  }

  renderWorkoutOutline()
}

function renderExerciseCard(se) {
  const isTimed = se.exercises && se.exercises.is_timed
  const tracksWeight = !se.exercises || se.exercises.tracks_weight
  const isUnilateral = se.exercises && se.exercises.is_unilateral
  const videoUrl = (se.exercises && se.exercises.video_url) || ''
  const thumb = getYouTubeThumbnail(videoUrl)
  const targets = deriveSetTargets(se)
  const rowsHtml = targets.map((t, i) => renderSetTargetRow(i + 1, t, isTimed, tracksWeight, isUnilateral, targets.length === 1)).join('')
  const groupMembers = se.superset_group_id ? exercisesCache.filter(other => other.id !== se.id && other.superset_group_id === se.superset_group_id) : []
  const groupColor = se.superset_group_id ? colorForSupersetGroup(se.superset_group_id) : null
  const linkTitle = groupMembers.length
    ? `Linked with ${groupMembers.map(m => m.exercises ? m.exercises.name : 'exercise').join(', ')} - tap to remove`
    : 'Link with other exercises (superset)'

  return `
    <div class="builder-exercise-card" data-id="${se.id}" data-superset-group-id="${se.superset_group_id || ''}">
      <div class="builder-exercise-card-header">
        <span class="builder-drag-handle" draggable="true" title="Drag to reorder">⠿</span>
        <button type="button" class="builder-exercise-thumb" ${videoUrl ? `data-video-url="${videoUrl}"` : 'disabled'}>
          ${thumb ? `<img src="${thumb}" alt="" loading="lazy">` : '<span class="builder-exercise-thumb-placeholder">🏋</span>'}
        </button>
        <div class="builder-exercise-name">${se.exercises ? se.exercises.name : 'Unknown exercise'}</div>
        ${isUnilateral ? '<span class="builder-unilateral-badge">Each Side</span>' : ''}
        <button type="button" class="builder-link-btn ${se.superset_group_id ? 'linked' : ''}" data-action="toggle-link" style="${groupColor ? `border-color:${groupColor}; color:${groupColor}; background-color:${groupColor}22` : ''}" title="${linkTitle}">🔗</button>
        <button type="button" class="btn-delete-measurement" data-action="delete-exercise" title="Remove from section">🗑</button>
      </div>
      <div class="set-target-rows">
        ${rowsHtml}
      </div>
      <button type="button" class="builder-add-set-btn" data-action="add-set">+ Add Set</button>
      <div class="builder-exercise-notes">
        <label>Extra Fields (optional)</label>
        <div class="extra-fields-container" id="extraFields-${se.id}"></div>
        <button type="button" class="btn-create-metric" data-action="add-extra-field" style="margin-top:6px">+ Add Field</button>
      </div>
      <div class="builder-exercise-notes">
        <label>Notes (visible to the athlete)</label>
        <input type="text" class="exercise-notes-input" value="${se.notes || ''}" placeholder="e.g. Focus on controlled tempo">
      </div>
    </div>
  `
}

// Reads one card's current DOM state and saves it - called for every
// exercise at once from the single page-level Save button, not from a
// per-card button. Returns true/false instead of alerting on its own so
// the caller can report one combined error if several cards fail.
async function saveExerciseCard(seId, orderIndex) {
  const card = document.querySelector(`.builder-exercise-card[data-id="${seId}"]`)
  if (!card) return true

  const rows = [...card.querySelectorAll('.set-target-row')]
  const setTargets = rows.map(row => {
    const reps = row.querySelector('.set-reps-input').value.trim() || null
    const weightInput = row.querySelector('.set-weight-input')
    const weight = weightInput && weightInput.value ? parseFloat(weightInput.value) : null
    const restMm = parseInt(row.querySelector('.set-rest-mm').value) || 0
    const restSs = parseInt(row.querySelector('.set-rest-ss').value) || 0
    const rest = (restMm === 0 && restSs === 0) ? null : restMm * 60 + restSs
    const type = row.querySelector('.set-type-select').value
    return { reps, weight, rest, type }
  })

  const notes = card.querySelector('.exercise-notes-input').value.trim() || null
  const extraFields = collectExtraFields(`extraFields-${seId}`)
  const first = setTargets[0] || { reps: null, weight: null, rest: null }

  const { error } = await supabase
    .from('section_exercises')
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
    .eq('id', seId)

  if (error) { console.log(error); return false }
  return true
}

// Saves every exercise card on the page at once, then heads back to the
// Section Library list.
document.getElementById('saveSectionBtn').addEventListener('click', async function() {
  const btn = this
  btn.disabled = true
  btn.textContent = 'Saving...'

  const ids = [...document.querySelectorAll('#sectionExercisesList .builder-exercise-card')].map(card => card.dataset.id)
  const results = await Promise.all(ids.map(saveExerciseCard))

  if (results.some(ok => !ok)) {
    customAlert('Something went wrong saving one or more exercises - please try again')
    btn.disabled = false
    btn.textContent = '💾 Save'
    return
  }

  window.location.href = 'sections.html'
})

// Removes just this one card instead of reloading + re-rendering the whole
// list, so any unsaved edits sitting in other cards' rows aren't wiped out
async function deleteExerciseRow(id) {
  if (!(await customConfirm('Remove this exercise from the section?'))) return

  const card = document.querySelector(`.builder-exercise-card[data-id="${id}"]`)
  if (card && card.dataset.supersetGroupId) removeFromSupersetGroup(id, sectionDropZone)

  const { error } = await supabase.from('section_exercises').delete().eq('id', id)
  if (error) { console.log(error); customAlert('Something went wrong'); return }

  exercisesCache = exercisesCache.filter(se => se.id !== id)
  if (card) card.remove()
  if (exercisesCache.length === 0) {
    document.getElementById('sectionExercisesList').innerHTML = '<p class="no-metrics">No exercises yet — drag one in from the library on the left</p>'
  }
  renderWorkoutOutline()
}

// ==========================================================================
// ---- SUPERSETS (link up to 4 exercises into one giant-set group) ----
// Same pattern as training-builder.js, scoped to sectionDropZone - every
// member of a group always has to be within the same section. This link
// carries through when the section is later inserted into a real training/
// day (see insertSectionInto*'s group-id remapping elsewhere). Draft-
// until-Save, exactly like set_targets/notes.
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

  const others = [...sectionDropZone.querySelectorAll(`.builder-exercise-card[data-superset-group-id="${groupId}"]`)].filter(c => c !== card)
  const names = others.map(c => c.querySelector('.builder-exercise-name').textContent).filter(Boolean)
  linkBtn.title = names.length ? `Linked with ${names.join(', ')} - tap to remove` : 'Remove from superset'
}

document.getElementById('sectionExercisesList').addEventListener('click', async function(e) {
  const thumbBtn = e.target.closest('.builder-exercise-thumb')
  if (thumbBtn && thumbBtn.dataset.videoUrl) {
    playInlineVideo(thumbBtn, thumbBtn.dataset.videoUrl)
    return
  }

  const btn = e.target.closest('[data-action]')
  if (!btn) return
  const card = btn.closest('.builder-exercise-card')
  const seId = card ? card.dataset.id : null
  const se = seId ? exercisesCache.find(s => s.id === seId) : null
  const isTimed = !!(se && se.exercises && se.exercises.is_timed)
  const tracksWeight = !!(se && (!se.exercises || se.exercises.tracks_weight))
  const isUnilateral = !!(se && se.exercises && se.exercises.is_unilateral)

  if (btn.dataset.action === 'add-set') {
    addSetTargetRow(card.querySelector('.set-target-rows'), isTimed, tracksWeight, isUnilateral)
  } else if (btn.dataset.action === 'remove-set') {
    removeSetTargetRow(btn.closest('.set-target-row'))
  } else if (btn.dataset.action === 'delete-exercise') {
    await deleteExerciseRow(seId)
  } else if (btn.dataset.action === 'add-extra-field') {
    addExtraFieldRow(`extraFields-${seId}`)
  } else if (btn.dataset.action === 'toggle-link') {
    handleLinkClick(seId, sectionDropZone)
  }
})

// mm:ss rest boxes: strip anything non-digit as it's typed, then pad back
// to 2 digits (and clamp seconds to 59) once the coach taps away. Selects
// the "00" on focus so typing a digit replaces it instead of needing a
// manual delete first
document.getElementById('sectionExercisesList').addEventListener('focusin', function(e) {
  if (e.target.matches('.set-time-mm, .set-time-ss')) {
    e.target.select()
  }
})
document.getElementById('sectionExercisesList').addEventListener('input', function(e) {
  if (e.target.matches('.set-time-mm, .set-time-ss')) {
    e.target.value = e.target.value.replace(/\D/g, '').slice(0, 2)
  }
})
document.getElementById('sectionExercisesList').addEventListener('focusout', function(e) {
  if (e.target.matches('.set-time-mm, .set-time-ss')) {
    const max = e.target.classList.contains('set-time-ss') ? 59 : 99
    const val = Math.min(parseInt(e.target.value) || 0, max)
    e.target.value = String(val).padStart(2, '0')
  }
})

// ==========================================================================
// ---- CREATE NEW EXERCISE ----
// Opened from the Exercise Library panel. Saving adds it to both the
// searchable library and straight onto the section.
// ==========================================================================
const BUILT_IN_TYPES = { weights: 'Weightlifting (sets, reps, weight)', timed: 'Timed (sets, duration)', plyometric: 'Plyometric (sets, foot contacts, intensity)' }

function populateCreateCategorySelect() {
  const select = document.getElementById('sCreateExerciseCategory')
  const categories = [...new Set(allExercises.map(ex => ex.category).filter(c => c && c.trim()))].sort()
  select.innerHTML = '<option value="">Choose Category</option>' +
    categories.map(c => `<option value="${c}">${c}</option>`).join('') +
    '<option value="__new__">+ Add New Category</option>'
  select.value = ''
  toggleCreateNewCategoryField()
}

function toggleCreateNewCategoryField() {
  const isNew = document.getElementById('sCreateExerciseCategory').value === '__new__'
  document.getElementById('sCreateExerciseNewCategoryGroup').style.display = isNew ? 'block' : 'none'
}

document.getElementById('sCreateExerciseCategory').addEventListener('change', toggleCreateNewCategoryField)

function populateCreateTypeSelect() {
  const select = document.getElementById('sCreateExerciseType')
  const customTypes = [...new Set(allExercises.map(ex => ex.type).filter(t => t && !(t in BUILT_IN_TYPES)))].sort()
  select.innerHTML =
    Object.entries(BUILT_IN_TYPES).map(([value, label]) => `<option value="${value}">${label}</option>`).join('') +
    customTypes.map(t => `<option value="${t}">${t}</option>`).join('') +
    '<option value="__new__">+ Add New Type</option>'
  select.value = 'weights'
  toggleCreateNewTypeField()
}

function toggleCreateNewTypeField() {
  const isNew = document.getElementById('sCreateExerciseType').value === '__new__'
  document.getElementById('sCreateExerciseNewTypeGroup').style.display = isNew ? 'block' : 'none'
}

// Nudges the logging-field toggles to their common defaults when the coach
// actually picks a type - the coach can still flip either toggle back
// afterward for a less common combination (e.g. a weighted timed hold)
function applyTypeLoggingDefaults(type) {
  if (type === 'timed') {
    document.getElementById('sCreateExerciseIsTimed').checked = true
    document.getElementById('sCreateExerciseTracksWeight').checked = false
  } else if (type === 'weights') {
    document.getElementById('sCreateExerciseIsTimed').checked = false
    document.getElementById('sCreateExerciseTracksWeight').checked = true
  }
}

document.getElementById('sCreateExerciseType').addEventListener('change', function() {
  toggleCreateNewTypeField()
  applyTypeLoggingDefaults(this.value)
})

document.getElementById('openCreateExerciseBtn').addEventListener('click', function() {
  document.getElementById('sCreateExerciseName').value = ''
  document.getElementById('sCreateExerciseNewCategory').value = ''
  populateCreateCategorySelect()
  document.getElementById('sCreateExerciseNewType').value = ''
  populateCreateTypeSelect()
  document.getElementById('sCreateExerciseTracksWeight').checked = true
  document.getElementById('sCreateExerciseIsTimed').checked = false
  document.getElementById('sCreateExerciseIsUnilateral').checked = false
  document.getElementById('sCreateExerciseTracksDistance').checked = false
  document.getElementById('sCreateExerciseVideoUrl').value = ''
  document.getElementById('sCreateExerciseInstructions').value = ''
  document.getElementById('sCreateExerciseModal').classList.add('active')
})

document.getElementById('cancelSCreateExerciseBtn').addEventListener('click', function() {
  document.getElementById('sCreateExerciseModal').classList.remove('active')
})

document.getElementById('saveSCreateExerciseBtn').addEventListener('click', async function() {
  const name = document.getElementById('sCreateExerciseName').value.trim()
  const categorySelect = document.getElementById('sCreateExerciseCategory').value
  const category = categorySelect === '__new__'
    ? document.getElementById('sCreateExerciseNewCategory').value.trim()
    : categorySelect
  const typeSelect = document.getElementById('sCreateExerciseType').value
  const type = typeSelect === '__new__'
    ? document.getElementById('sCreateExerciseNewType').value.trim() || 'weights'
    : typeSelect
  const videoUrl = document.getElementById('sCreateExerciseVideoUrl').value.trim()
  const instructions = document.getElementById('sCreateExerciseInstructions').value.trim()
  const tracksWeight = document.getElementById('sCreateExerciseTracksWeight').checked
  const isTimed = document.getElementById('sCreateExerciseIsTimed').checked
  const isUnilateral = document.getElementById('sCreateExerciseIsUnilateral').checked
  const tracksDistance = document.getElementById('sCreateExerciseTracksDistance').checked

  if (!name) { customAlert('Please enter a name'); return }

  const { data, error } = await supabase
    .from('exercises')
    .insert([{ coach_id: session.user.id, name, category, type, video_url: videoUrl, instructions, tracks_weight: tracksWeight, is_timed: isTimed, is_unilateral: isUnilateral, tracks_distance: tracksDistance }])
    .select()

  if (error) { console.log(error); customAlert('Something went wrong'); return }

  allExercises.push(data[0])
  allExercises.sort((a, b) => a.name.localeCompare(b.name))
  renderCategoryChips()
  renderLibraryPanel()
  document.getElementById('sCreateExerciseModal').classList.remove('active')
  await addExerciseToSection(data[0].id)
})

// ==========================================================================
// ---- RENAME SECTION ----
// ==========================================================================
document.getElementById('renameSectionBtn').addEventListener('click', function() {
  document.getElementById('renameSectionInput').value = document.getElementById('sectionNameHeading').textContent
  document.getElementById('renameSectionModal').classList.add('active')
})

document.getElementById('cancelRenameSectionBtn').addEventListener('click', function() {
  document.getElementById('renameSectionModal').classList.remove('active')
})

document.getElementById('saveRenameSectionBtn').addEventListener('click', async function() {
  const name = document.getElementById('renameSectionInput').value.trim()
  if (!name) { customAlert('Please enter a name'); return }

  const { error } = await supabase.from('sections').update({ name }).eq('id', sectionId)
  if (error) { console.log(error); customAlert('Something went wrong'); return }

  document.getElementById('sectionNameHeading').textContent = name
  document.getElementById('renameSectionModal').classList.remove('active')
})
