// ==========================================================================
// SECTION BUILDER — screen
// Converted from the repo-root section-builder.js + the layout block of
// section-builder.html. Direct copy-adapt of training-builder.js (a section
// is really "a training-shaped block that gets pasted into something else")
// - same picker/edit patterns, just against sections/section_exercises
// instead of trainings/training_exercises. A section's own exercises never
// show a section_label header - a section IS the group being defined, and
// section_label is stamped onto the exercises only once they're copied out
// into a real training/day. Sets CAN be linked into supersets within a
// section though, and that link carries through the clone (see
// insertSectionInto*'s group-id remapping in training-builder.js/
// program-builder.js/athlete-calendar.js).
//
// This is the busiest of the three builders: one document-level click
// listener (closes a card's kebab dropdown on outside click) is tracked and
// removed in unmount(), and autosaveTimers (one debounce per section_exercise
// row) is cleared in full in unmount() - left running, a debounce armed
// right before the coach navigated away would fire minutes later against a
// card that no longer exists on screen. The two drag-classList setTimeout(fn,
// 0) calls are one-shot DOM nudges that fire and self-clear before the next
// tick; they hold no state and need no tracking.
// ==========================================================================
import { supabase } from '../../coachClient.js'
import * as nav from '../nav.js'
import { go } from '../router.js'
import { coachId } from '../session.js'
import { ensureCss } from '../lazy-css.js'

const TEMPLATE = `
  <div class="screen-header">
    <button class="btn-back" id="sectionBuilderBackBtn" aria-label="Back">←</button>
    <h2 class="screen-title" id="sectionNameHeading">Loading...</h2>
  </div>

  <div class="training-builder-layout">
    <!-- Mini Exercise Library: search + drag source. Dropping a card onto
         the section's exercise list on the right adds it (with blank
         prescribed values - click the exercise afterward to fill those
         in). "+ Create New Exercise" adds straight to both this library
         and the section. -->
    <div class="exercise-library-panel">
      <h3>Exercise Library</h3>
      <input type="text" id="exerciseSearchInput" class="exercise-search-input" placeholder="Search exercises..." />
      <div class="chip-row" id="exerciseCategoryChips" style="margin:10px 0"></div>
      <button class="btn-create-metric" id="openCreateExerciseBtn">+ Create New Exercise</button>
      <div class="exercise-library-list" id="exerciseLibraryList"></div>
    </div>

    <div class="dashboard training-builder-main">
      <div class="dashboard-header">
        <h2 id="sectionActionsHeading" style="visibility:hidden">Section</h2>
        <div style="display:flex; gap:12px">
          <button class="btn-profile-action" id="renameSectionBtn">Rename</button>
          <button class="btn-save" id="saveSectionBtn">Save</button>
        </div>
      </div>
      <p style="color:#aaaacc; font-size:13px; margin-top:-16px; margin-bottom:16px">Drag an exercise from the library to add it here.</p>
      <div id="sectionExercisesList"></div>
    </div>

    <!-- Exercise order outline: just names, in order - dragging one of
         these rows is a lot easier than dragging a whole tall exercise
         card, so it's a second, quicker way to reorder the same list. -->
    <div class="workout-outline-panel">
      <h3>Exercise Order</h3>
      <p style="color:#aaaacc; font-size:11px; margin-top:-8px; margin-bottom:12px">Drag to reorder</p>
      <div class="workout-outline-list" id="workoutOutlineList"></div>
    </div>
  </div>

  <!-- Rename Section Modal -->
  <div class="modal-overlay" id="renameSectionModal">
    <div class="modal">
      <h2>Rename Section</h2>
      <div class="form-group">
        <label>Name</label>
        <input type="text" id="renameSectionInput" />
      </div>
      <div class="form-actions">
        <button class="btn-cancel" id="cancelRenameSectionBtn" data-modal-dismiss>Cancel</button>
        <button class="btn-save" id="saveRenameSectionBtn">Save</button>
      </div>
    </div>
  </div>

  <!-- Create New Exercise Modal: opened from the Exercise Library panel's
       "+ Create New Exercise" button, adds straight to the section too -->
  <div class="modal-overlay" id="sCreateExerciseModal">
    <div class="modal">
      <h2 id="sCreateExerciseModalTitle">Create New Exercise</h2>
      <div class="form-group">
        <label>Name</label>
        <input type="text" id="sCreateExerciseName" placeholder="e.g. Romanian Deadlift" />
      </div>
      <div class="form-group">
        <label>Category</label>
        <select id="sCreateExerciseCategory">
          <option value="__new__">+ Add New Category</option>
        </select>
      </div>
      <div class="form-group" id="sCreateExerciseNewCategoryGroup" style="display:none">
        <label>New Category Name</label>
        <input type="text" id="sCreateExerciseNewCategory" placeholder="e.g. Legs" />
      </div>
      <div class="form-group">
        <label>Type</label>
        <select id="sCreateExerciseType">
          <option value="weights">Weightlifting (sets, reps, weight)</option>
          <option value="timed">Timed (sets, duration)</option>
          <option value="plyometric">Plyometric (sets, foot contacts, intensity)</option>
          <option value="__new__">+ Add New Type</option>
        </select>
      </div>
      <div class="form-group" id="sCreateExerciseNewTypeGroup" style="display:none">
        <label>New Type Name</label>
        <input type="text" id="sCreateExerciseNewType" placeholder="e.g. Sprints" />
      </div>
      <div class="form-group">
        <label>Logging Fields</label>
        <p style="color:#aaaacc; font-size:12px; margin:-2px 0 8px">What to track when this exercise is logged - independent of Type above, so any combination works (e.g. reps AND a hold time, or a weighted timed hold).</p>
        <label class="bodyweight-toggle" style="margin-bottom:8px"><span>Track Reps</span>
          <span class="toggle-switch"><input type="checkbox" id="sCreateExerciseTracksReps" checked><span class="toggle-slider"></span></span>
        </label>
        <label class="bodyweight-toggle" style="margin-bottom:8px"><span>Track Weight (kg)</span>
          <span class="toggle-switch"><input type="checkbox" id="sCreateExerciseTracksWeight" checked><span class="toggle-slider"></span></span>
        </label>
        <label class="bodyweight-toggle" style="margin-bottom:8px"><span>Timed</span>
          <span class="toggle-switch"><input type="checkbox" id="sCreateExerciseIsTimed"><span class="toggle-slider"></span></span>
        </label>
        <label class="bodyweight-toggle" style="margin-bottom:8px"><span>Log Each Side (unilateral)</span>
          <span class="toggle-switch"><input type="checkbox" id="sCreateExerciseIsUnilateral"><span class="toggle-slider"></span></span>
        </label>
        <label class="bodyweight-toggle"><span>Track Distance (meters)</span>
          <span class="toggle-switch"><input type="checkbox" id="sCreateExerciseTracksDistance"><span class="toggle-slider"></span></span>
        </label>
      </div>
      <div class="form-group">
        <label>Video Link (optional)</label>
        <input type="url" id="sCreateExerciseVideoUrl" placeholder="https://youtube.com/..." />
      </div>
      <div class="form-group">
        <label>Instructions (optional)</label>
        <textarea id="sCreateExerciseInstructions" class="notes-textarea"></textarea>
      </div>
      <div class="form-actions">
        <button class="btn-cancel" id="cancelSCreateExerciseBtn" data-modal-dismiss>Cancel</button>
        <button class="btn-save" id="saveSCreateExerciseBtn">Create & Select</button>
        <button class="btn-save" id="saveSEditExerciseBtn" style="display:none">Save Changes</button>
      </div>
    </div>
  </div>

  <!-- Adjust Fields Modal: opened from an exercise card's ⋮ menu - sets a
       per-instance override (tracks_weight_override/is_timed_override/
       is_unilateral_override/tracks_distance_override) on THIS section's
       row, scoped to just this one section. The exercise's own default in
       Exercise Library is never touched. -->
  <div class="modal-overlay" id="adjustFieldsModal">
    <div class="modal">
      <div class="graph-modal-header">
        <h2>Adjust Fields</h2>
        <button type="button" class="btn-cancel" id="closeAdjustFieldsBtn" data-modal-dismiss>✕</button>
      </div>
      <p style="color:#aaaacc; font-size:13px; margin:-6px 0 16px" id="adjustFieldsExerciseName"></p>
      <div class="form-group">
        <label>Logging Fields</label>
        <p style="color:#aaaacc; font-size:12px; margin:-2px 0 8px">What to track when this exercise is logged - independent of Type, so any combination works (e.g. a weighted timed hold). Applies only to this section - the exercise's own default in Exercise Library stays unchanged.</p>
        <label class="bodyweight-toggle" style="margin-bottom:8px"><span>Track Weight (kg)</span>
          <span class="toggle-switch"><input type="checkbox" id="adjustFieldsTracksWeight"><span class="toggle-slider"></span></span>
        </label>
        <label class="bodyweight-toggle" style="margin-bottom:8px"><span>Timed</span>
          <span class="toggle-switch"><input type="checkbox" id="adjustFieldsIsTimed"><span class="toggle-slider"></span></span>
        </label>
        <label class="bodyweight-toggle" style="margin-bottom:8px"><span>Log Each Side (unilateral)</span>
          <span class="toggle-switch"><input type="checkbox" id="adjustFieldsIsUnilateral"><span class="toggle-slider"></span></span>
        </label>
        <label class="bodyweight-toggle"><span>Track Distance (meters)</span>
          <span class="toggle-switch"><input type="checkbox" id="adjustFieldsTracksDistance"><span class="toggle-slider"></span></span>
        </label>
      </div>
      <div class="form-actions">
        <button class="btn-cancel" id="cancelAdjustFieldsBtn" data-modal-dismiss>Cancel</button>
        <button class="btn-save" id="saveAdjustFieldsBtn">Save</button>
      </div>
    </div>
  </div>

  <!-- Set Alternative Exercise: opened from a card's kebab menu - picks a
       single coach-curated fallback the athlete can one-tap switch to if
       they can't do the prescribed exercise. See openSetAlternativeModal
       below. -->
  <div class="modal-overlay" id="setAlternativeModal">
    <div class="modal">
      <div class="graph-modal-header">
        <h2>Alternative Exercise</h2>
        <button type="button" class="btn-cancel" id="closeSetAlternativeBtn" data-modal-dismiss>✕</button>
      </div>
      <p style="color:#aaaacc; font-size:13px; margin-top:-8px" id="setAlternativeExerciseName"></p>
      <input type="text" id="setAlternativeSearchInput" class="exercise-search-input" placeholder="Search exercises..." />
      <div class="exercise-library-list" id="setAlternativeList" style="max-height:320px; overflow-y:auto; margin-top:10px"></div>
      <button type="button" class="btn-cancel" id="removeAlternativeBtn" style="margin-top:12px; width:100%">Remove Alternative</button>
    </div>
  </div>

  <!-- Field picker: opened from a card's kebab "+ Add Field" - pick from
       the coach's reusable extra_field_names library, or type a new one.
       See openExtraFieldPicker() below -->
  <div class="modal-overlay" id="extraFieldPickerModal">
    <div class="modal">
      <div class="graph-modal-header">
        <h2>Add Field</h2>
        <button type="button" class="btn-cancel" id="closeExtraFieldPickerBtn" data-modal-dismiss>✕</button>
      </div>
      <div class="chip-row" id="extraFieldPickerList"></div>
      <div class="form-group" style="margin-top:16px">
        <label>New field name</label>
        <div style="display:flex; gap:8px">
          <input type="text" id="newExtraFieldNameInput" placeholder="e.g. Tempo" style="flex:1">
          <button type="button" class="btn-save" id="createExtraFieldNameBtn">+</button>
        </div>
      </div>
    </div>
  </div>

  <!-- Shown only while linking a superset - see updatePickingModeBar() below -->
  <div class="picking-mode-bar" id="pickingModeBar" style="display:none">
    <span class="picking-mode-bar-count" id="pickingModeBarCount"></span>
    <div class="picking-mode-bar-actions">
      <button type="button" class="btn-cancel" id="pickingModeBarCancelBtn">Cancel</button>
      <button type="button" class="btn-save" id="pickingModeBarFinishBtn">✓ Finish Superset</button>
    </div>
  </div>
`

const SET_TYPES = { main: 'Main Set', warmup: 'Warmup Set', failure: 'Set to Failure' }
const SUPERSET_COLORS = ['#4a4a8e', '#e0a030', '#3aa66e', '#c0466e', '#3a8ec0', '#a05fd6', '#c07a2e', '#5fb8b8']
const SUPERSET_CAP = 4
const BUILT_IN_TYPES = { weights: 'Weightlifting (sets, reps, weight)', timed: 'Timed (sets, duration)', plyometric: 'Plyometric (sets, foot contacts, intensity)' }

let root = null
let sectionId = null
let sectionDropZone = null // set once TEMPLATE is in the DOM - #sectionExercisesList
let workoutOutlineList = null // #workoutOutlineList

let allExercises = []
let exercisesCache = [] // last-loaded section_exercises for this section
// Category chips narrow the library alongside the name search (AND) - no
// chip selected shows everything. Categories are freeform per-exercise
// text, not a fixed list, so the chip set is generated from whatever
// values are actually in use (see renderCategoryChips)
let activeCategoryFilters = new Set()

let draggingCard = null
let draggingOutlineItem = null

let extraFieldNamesCache = null
let extraFieldPickerSeId = null

let autosaveTimers = {}

let pickingGroupIds = null // array being built while picking, else null

let adjustFieldsSeId = null
let setAlternativeSeId = null
let editingExerciseId = null

let onDocClickKebab = null

export async function mount(container, params, token) {
  ensureCss('css/builders.css?v=2')
  root = container
  sectionId = params.id
  container.innerHTML = TEMPLATE
  sectionDropZone = root.querySelector('#sectionExercisesList')
  workoutOutlineList = root.querySelector('#workoutOutlineList')
  bindEvents()

  await Promise.all([loadSection(token), loadExercisesList(token), loadAllExercises(token)])
}

export function unmount() {
  if (onDocClickKebab) document.removeEventListener('click', onDocClickKebab)
  onDocClickKebab = null

  // Every armed autosave debounce must die here - left running, one that
  // fired after the coach navigated away would write against a card whose
  // DOM no longer exists.
  Object.values(autosaveTimers).forEach(clearTimeout)
  autosaveTimers = {}

  root = null
  sectionId = null
  sectionDropZone = null
  workoutOutlineList = null
  allExercises = []
  exercisesCache = []
  activeCategoryFilters = new Set()
  draggingCard = null
  draggingOutlineItem = null
  extraFieldNamesCache = null
  extraFieldPickerSeId = null
  pickingGroupIds = null
  adjustFieldsSeId = null
  setAlternativeSeId = null
  editingExerciseId = null
}

// ==========================================================================
// ---- EVENT BINDING ----
// Everything that was a top-level document.getElementById(...).addEventListener
// call in the original lives here now, bound once per mount() against the
// freshly-rendered TEMPLATE. Order is unchanged from the original file.
// ==========================================================================
function bindEvents() {
  root.querySelector('#sectionBuilderBackBtn').addEventListener('click', function() { nav.back() })

  root.querySelector('#exerciseCategoryChips').addEventListener('click', function(e) {
    const btn = e.target.closest('.chip-btn')
    if (!btn) return
    const cat = btn.dataset.category
    if (activeCategoryFilters.has(cat)) activeCategoryFilters.delete(cat)
    else activeCategoryFilters.add(cat)
    btn.classList.toggle('selected')
    renderLibraryPanel()
  })

  root.querySelector('#exerciseSearchInput').addEventListener('input', renderLibraryPanel)

  // ---- Drag from the library panel, drop onto the section's exercise list ----
  root.querySelector('#exerciseLibraryList').addEventListener('dragstart', function(e) {
    const card = e.target.closest('.exercise-lib-card')
    if (!card) return
    e.dataTransfer.setData('text/plain', card.dataset.id)
  })

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

  root.querySelector('#createExtraFieldNameBtn').addEventListener('click', async function() {
    const name = root.querySelector('#newExtraFieldNameInput').value.trim()
    if (!name) return
    const { error } = await supabase.from('extra_field_names').upsert([{ coach_id: coachId(), name }], { onConflict: 'coach_id,name' })
    if (error) { console.log(error); customAlert('Something went wrong saving that field name - try again'); return }
    extraFieldNamesCache = null
    pickExtraField(name)
  })

  root.querySelector('#extraFieldPickerList').addEventListener('click', function(e) {
    const btn = e.target.closest('.chip-btn')
    if (btn) pickExtraField(btn.dataset.name)
  })

  root.querySelector('#closeExtraFieldPickerBtn').addEventListener('click', function() {
    root.querySelector('#extraFieldPickerModal').classList.remove('active')
  })

  // Saves every exercise card on the page at once, then heads back to the
  // Section Library list.
  root.querySelector('#saveSectionBtn').addEventListener('click', async function() {
    const btn = this
    btn.disabled = true
    btn.textContent = 'Saving...'

    const ids = [...root.querySelectorAll('#sectionExercisesList .builder-exercise-card')].map(card => card.dataset.id)
    ids.forEach(id => { clearTimeout(autosaveTimers[id]); delete autosaveTimers[id] })
    const results = await Promise.all(ids.map(saveExerciseCard))

    if (results.some(ok => !ok)) {
      customAlert('Something went wrong saving one or more exercises - please try again')
      btn.disabled = false
      btn.textContent = 'Save'
      return
    }

    go('sections', {})
  })

  root.querySelector('#sectionExercisesList').addEventListener('click', async function(e) {
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
    const tracksReps = !!(se && (!se.exercises || se.exercises.tracks_reps !== false))
    const isTimed = !!(se && se.exercises && se.exercises.is_timed)
    const tracksWeight = !!(se && (!se.exercises || se.exercises.tracks_weight))
    const isUnilateral = !!(se && se.exercises && se.exercises.is_unilateral)

    if (btn.dataset.action === 'add-set') {
      addSetTargetRow(card.querySelector('.set-target-rows'), tracksReps, isTimed, tracksWeight, isUnilateral)
      scheduleAutosave(seId)
      for (const other of linkedCardsFor(card)) {
        const oSe = exercisesCache.find(s => s.id === other.dataset.id)
        addSetTargetRow(
          other.querySelector('.set-target-rows'),
          !!(oSe && (!oSe.exercises || oSe.exercises.tracks_reps !== false)),
          !!(oSe && oSe.exercises && oSe.exercises.is_timed),
          !!(oSe && (!oSe.exercises || oSe.exercises.tracks_weight)),
          !!(oSe && oSe.exercises && oSe.exercises.is_unilateral)
        )
        scheduleAutosave(other.dataset.id)
      }
    } else if (btn.dataset.action === 'remove-set') {
      const row = btn.closest('.set-target-row')
      const setNumber = row.dataset.setNumber
      removeSetTargetRow(row)
      scheduleAutosave(seId)
      for (const other of linkedCardsFor(card)) {
        const otherRow = other.querySelector(`.set-target-row[data-set-number="${setNumber}"]`)
        if (otherRow && other.querySelectorAll('.set-target-row').length > 1) {
          removeSetTargetRow(otherRow)
          scheduleAutosave(other.dataset.id)
        }
      }
    } else if (btn.dataset.action === 'delete-exercise') {
      await deleteExerciseRow(seId)
    } else if (btn.dataset.action === 'add-extra-field') {
      btn.closest('.kebab-dropdown')?.classList.remove('active')
      openExtraFieldPicker(seId)
    } else if (btn.dataset.action === 'toggle-link') {
      handleLinkClick(seId, sectionDropZone)
    } else if (btn.dataset.action === 'toggle-kebab') {
      const dropdown = btn.parentElement.querySelector('.kebab-dropdown')
      const wasActive = dropdown.classList.contains('active')
      root.querySelectorAll('#sectionExercisesList .kebab-dropdown.active').forEach(d => d.classList.remove('active'))
      if (!wasActive) dropdown.classList.add('active')
    } else if (btn.dataset.action === 'adjust-fields') {
      btn.closest('.kebab-dropdown').classList.remove('active')
      await flushCardSave(seId)
      openAdjustFieldsModal(exercisesCache.find(s => s.id === seId))
    } else if (btn.dataset.action === 'set-alternative') {
      btn.closest('.kebab-dropdown').classList.remove('active')
      await flushCardSave(seId)
      openSetAlternativeModal(exercisesCache.find(s => s.id === seId))
    } else if (btn.dataset.action === 'edit-exercise') {
      btn.closest('.kebab-dropdown').classList.remove('active')
      if (se && se.exercises) openExerciseModal(se.exercises)
    }
  })

  // Kebab dropdowns (see toggle-kebab above) close on their own toggle or on
  // picking an item, but not yet on an outside click - add that here so one
  // left open doesn't linger while the coach works on other cards
  onDocClickKebab = function(e) {
    if (e.target.closest('.builder-kebab-menu')) return
    root?.querySelectorAll('#sectionExercisesList .kebab-dropdown.active').forEach(d => d.classList.remove('active'))
  }
  document.addEventListener('click', onDocClickKebab)

  // ==========================================================================
  // ---- ADJUST FIELDS (per-instance override) ----
  // ==========================================================================
  root.querySelector('#closeAdjustFieldsBtn').addEventListener('click', function() {
    root.querySelector('#adjustFieldsModal').classList.remove('active')
  })
  root.querySelector('#cancelAdjustFieldsBtn').addEventListener('click', function() {
    root.querySelector('#adjustFieldsModal').classList.remove('active')
  })

  root.querySelector('#saveAdjustFieldsBtn').addEventListener('click', async function() {
    if (!adjustFieldsSeId) return
    const updates = {
      tracks_weight_override: root.querySelector('#adjustFieldsTracksWeight').checked,
      is_timed_override: root.querySelector('#adjustFieldsIsTimed').checked,
      is_unilateral_override: root.querySelector('#adjustFieldsIsUnilateral').checked,
      tracks_distance_override: root.querySelector('#adjustFieldsTracksDistance').checked
    }
    const { error } = await supabase.from('section_exercises').update(updates).eq('id', adjustFieldsSeId)
    if (error) { console.log(error); customAlert('Something went wrong saving those fields - try again'); return }

    const se = exercisesCache.find(s => s.id === adjustFieldsSeId)
    if (se) {
      Object.assign(se, updates)
      applyFieldOverrides(se)
      const card = root.querySelector(`.builder-exercise-card[data-id="${se.id}"]`)
      if (card) {
        card.outerHTML = renderExerciseCard(se)
        if (se.extra_fields) {
          for (const [k, v] of Object.entries(se.extra_fields)) addExtraFieldRow(`extraFields-${se.id}`, k, v)
        }
      }
    }

    root.querySelector('#adjustFieldsModal').classList.remove('active')
  })

  // ==========================================================================
  // ---- SET ALTERNATIVE EXERCISE ----
  // ==========================================================================
  root.querySelector('#setAlternativeSearchInput').addEventListener('input', renderSetAlternativeList)

  root.querySelector('#setAlternativeList').addEventListener('click', async function(e) {
    const item = e.target.closest('.exercise-lib-card')
    if (item) await saveAlternativeExercise(setAlternativeSeId, item.dataset.id)
  })

  root.querySelector('#removeAlternativeBtn').addEventListener('click', async function() {
    await saveAlternativeExercise(setAlternativeSeId, null)
  })

  root.querySelector('#closeSetAlternativeBtn').addEventListener('click', function() {
    root.querySelector('#setAlternativeModal').classList.remove('active')
  })

  // mm:ss rest boxes: strip anything non-digit as it's typed, then pad back
  // to 2 digits (and clamp seconds to 59) once the coach taps away. Selects
  // the "00" on focus so typing a digit replaces it instead of needing a
  // manual delete first
  root.querySelector('#sectionExercisesList').addEventListener('focusin', function(e) {
    if (e.target.matches('.set-time-mm, .set-time-ss')) {
      e.target.select()
    }
  })
  root.querySelector('#sectionExercisesList').addEventListener('input', function(e) {
    if (e.target.matches('.set-time-mm, .set-time-ss')) {
      e.target.value = e.target.value.replace(/\D/g, '').slice(0, 2)
    }
  })
  root.querySelector('#sectionExercisesList').addEventListener('focusout', function(e) {
    if (e.target.matches('.set-time-mm, .set-time-ss')) {
      const max = e.target.classList.contains('set-time-ss') ? 59 : 99
      const val = Math.min(parseInt(e.target.value) || 0, max)
      e.target.value = String(val).padStart(2, '0')
    }
  })

  // Any set field, note, or extra-field value - autosave the owning card a
  // moment after the coach stops typing (see scheduleAutosave below)
  root.querySelector('#sectionExercisesList').addEventListener('input', function(e) {
    if (!e.target.matches(AUTOSAVE_FIELD_SELECTOR)) return
    const card = e.target.closest('.builder-exercise-card')
    if (card) scheduleAutosave(card.dataset.id)
  })
  root.querySelector('#sectionExercisesList').addEventListener('change', function(e) {
    if (!e.target.matches('.set-type-select')) return
    const card = e.target.closest('.builder-exercise-card')
    if (card) scheduleAutosave(card.dataset.id)
  })

  // ==========================================================================
  // ---- CREATE NEW EXERCISE ----
  // ==========================================================================
  root.querySelector('#sCreateExerciseCategory').addEventListener('change', toggleCreateNewCategoryField)

  root.querySelector('#sCreateExerciseType').addEventListener('change', function() {
    toggleCreateNewTypeField()
    applyTypeLoggingDefaults(this.value)
  })

  root.querySelector('#openCreateExerciseBtn').addEventListener('click', function() {
    editingExerciseId = null
    root.querySelector('#sCreateExerciseModalTitle').textContent = 'Create New Exercise'
    root.querySelector('#saveSCreateExerciseBtn').style.display = ''
    root.querySelector('#saveSEditExerciseBtn').style.display = 'none'
    root.querySelector('#sCreateExerciseName').value = ''
    root.querySelector('#sCreateExerciseNewCategory').value = ''
    populateCreateCategorySelect()
    root.querySelector('#sCreateExerciseNewType').value = ''
    populateCreateTypeSelect()
    root.querySelector('#sCreateExerciseTracksReps').checked = true
    root.querySelector('#sCreateExerciseTracksWeight').checked = true
    root.querySelector('#sCreateExerciseIsTimed').checked = false
    root.querySelector('#sCreateExerciseIsUnilateral').checked = false
    root.querySelector('#sCreateExerciseTracksDistance').checked = false
    root.querySelector('#sCreateExerciseVideoUrl').value = ''
    root.querySelector('#sCreateExerciseInstructions').value = ''
    root.querySelector('#sCreateExerciseModal').classList.add('active')
  })

  root.querySelector('#cancelSCreateExerciseBtn').addEventListener('click', function() {
    root.querySelector('#sCreateExerciseModal').classList.remove('active')
  })

  root.querySelector('#saveSCreateExerciseBtn').addEventListener('click', async function() {
    const name = root.querySelector('#sCreateExerciseName').value.trim()
    const categorySelect = root.querySelector('#sCreateExerciseCategory').value
    const category = categorySelect === '__new__'
      ? root.querySelector('#sCreateExerciseNewCategory').value.trim()
      : categorySelect
    const typeSelect = root.querySelector('#sCreateExerciseType').value
    const type = typeSelect === '__new__'
      ? root.querySelector('#sCreateExerciseNewType').value.trim() || 'weights'
      : typeSelect
    const videoUrl = root.querySelector('#sCreateExerciseVideoUrl').value.trim()
    const instructions = root.querySelector('#sCreateExerciseInstructions').value.trim()
    const tracksReps = root.querySelector('#sCreateExerciseTracksReps').checked
    const tracksWeight = root.querySelector('#sCreateExerciseTracksWeight').checked
    const isTimed = root.querySelector('#sCreateExerciseIsTimed').checked
    const isUnilateral = root.querySelector('#sCreateExerciseIsUnilateral').checked
    const tracksDistance = root.querySelector('#sCreateExerciseTracksDistance').checked

    if (!name) { customAlert('Please enter a name'); return }

    const { data, error } = await supabase
      .from('exercises')
      .insert([{ coach_id: coachId(), name, category, type, video_url: videoUrl, instructions, tracks_reps: tracksReps, tracks_weight: tracksWeight, is_timed: isTimed, is_unilateral: isUnilateral, tracks_distance: tracksDistance }])
      .select()

    if (error) { console.log(error); customAlert('Something went wrong'); return }

    allExercises.push(data[0])
    allExercises.sort((a, b) => a.name.localeCompare(b.name))
    renderCategoryChips()
    renderLibraryPanel()
    root.querySelector('#sCreateExerciseModal').classList.remove('active')
    await addExerciseToSection(data[0].id)
  })

  // Edits the real Exercise Library row in place (name/category/type/logging
  // fields/video/instructions) - every card using this exercise, in this
  // section and anywhere else, sees the change immediately since they all
  // just reference the same exercises.id. foot_contacts/intensity_tier
  // (Plyometric-only fields, no UI in this modal) are deliberately left out
  // of the update payload so this never silently clears them.
  root.querySelector('#saveSEditExerciseBtn').addEventListener('click', async function() {
    if (!editingExerciseId) return
    const name = root.querySelector('#sCreateExerciseName').value.trim()
    const categorySelect = root.querySelector('#sCreateExerciseCategory').value
    const category = categorySelect === '__new__'
      ? root.querySelector('#sCreateExerciseNewCategory').value.trim()
      : categorySelect
    const typeSelect = root.querySelector('#sCreateExerciseType').value
    const type = typeSelect === '__new__'
      ? root.querySelector('#sCreateExerciseNewType').value.trim() || 'weights'
      : typeSelect
    const videoUrl = root.querySelector('#sCreateExerciseVideoUrl').value.trim()
    const instructions = root.querySelector('#sCreateExerciseInstructions').value.trim()
    const tracksReps = root.querySelector('#sCreateExerciseTracksReps').checked
    const tracksWeight = root.querySelector('#sCreateExerciseTracksWeight').checked
    const isTimed = root.querySelector('#sCreateExerciseIsTimed').checked
    const isUnilateral = root.querySelector('#sCreateExerciseIsUnilateral').checked
    const tracksDistance = root.querySelector('#sCreateExerciseTracksDistance').checked

    if (!name) { customAlert('Please enter a name'); return }

    const updates = { name, category, type, video_url: videoUrl, instructions, tracks_reps: tracksReps, tracks_weight: tracksWeight, is_timed: isTimed, is_unilateral: isUnilateral, tracks_distance: tracksDistance }
    const { error } = await supabase.from('exercises').update(updates).eq('id', editingExerciseId)
    if (error) { console.log(error); customAlert('Something went wrong saving that - try again'); return }

    // Flushed BEFORE the cache is updated with the new logging-field values
    // below - flushing after would have every card's still-old DOM (not yet
    // re-rendered) read against the NEW field flags, reaching for inputs
    // (e.g. a timer box on a card that isn't timed yet) that don't exist yet
    await flushAllPendingSaves()

    const cachedEx = allExercises.find(ex => ex.id === editingExerciseId)
    if (cachedEx) Object.assign(cachedEx, updates)
    allExercises.sort((a, b) => a.name.localeCompare(b.name))
    for (const se of exercisesCache) {
      if (se.exercises && se.exercises.id === editingExerciseId) Object.assign(se.exercises, updates)
    }

    renderCategoryChips()
    renderLibraryPanel()
    renderExercisesList()
    root.querySelector('#sCreateExerciseModal').classList.remove('active')
  })

  // ==========================================================================
  // ---- RENAME SECTION ----
  // ==========================================================================
  root.querySelector('#renameSectionBtn').addEventListener('click', function() {
    root.querySelector('#renameSectionInput').value = root.querySelector('#sectionNameHeading').textContent
    root.querySelector('#renameSectionModal').classList.add('active')
  })

  root.querySelector('#cancelRenameSectionBtn').addEventListener('click', function() {
    root.querySelector('#renameSectionModal').classList.remove('active')
  })

  root.querySelector('#saveRenameSectionBtn').addEventListener('click', async function() {
    const name = root.querySelector('#renameSectionInput').value.trim()
    if (!name) { customAlert('Please enter a name'); return }

    const { error } = await supabase.from('sections').update({ name }).eq('id', sectionId)
    if (error) { console.log(error); customAlert('Something went wrong'); return }

    root.querySelector('#sectionNameHeading').textContent = name
    root.querySelector('#renameSectionModal').classList.remove('active')
  })
}

// ==========================================================================
// ---- LOAD SECTION NAME ----
// ==========================================================================
async function loadSection(token) {
  const { data, error } = await window.fetchWithRetry((signal) => supabase
    .from('sections')
    .select('*')
    .eq('id', sectionId)
    .single()
    .abortSignal(signal)
  )
  if (!nav.isCurrent(token)) return

  if (error) {
    console.log('Error loading section:', error)
    root.querySelector('#sectionNameHeading').textContent = 'Section not found'
    customAlert('Something went wrong loading this section - check your connection and try again')
    return
  }

  root.querySelector('#sectionNameHeading').textContent = data.name
}

// ==========================================================================
// ---- EXERCISE LIBRARY PANEL (search + drag source) ----
// ==========================================================================
async function loadAllExercises(token) {
  const { data, error } = await window.fetchWithRetry((signal) => supabase.from('exercises').select('*').eq('archived', false).order('name').abortSignal(signal))
  if (!nav.isCurrent(token)) return
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
  const row = root.querySelector('#exerciseCategoryChips')
  row.innerHTML = categories.map(cat =>
    `<button type="button" class="chip-btn ${activeCategoryFilters.has(cat) ? 'selected' : ''}" data-category="${cat}">${cat}</button>`
  ).join('')
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
  const filter = root.querySelector('#exerciseSearchInput').value.trim().toLowerCase()
  let filtered = filter ? allExercises.filter(ex => ex.name.toLowerCase().includes(filter)) : allExercises
  if (activeCategoryFilters.size) filtered = filtered.filter(ex => activeCategoryFilters.has(ex.category))

  const list = root.querySelector('#exerciseLibraryList')

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

// ---- Exercise order outline (right side panel) ----
// Just names, in order - a much quicker drag target than a whole tall
// exercise card. Dragging a row here reorders the outline first, then
// applies that same order to the real cards on the left (syncCardOrder
// below) - so either list can be dragged and they stay in sync.
function renderWorkoutOutline() {
  const panel = workoutOutlineList
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
  workoutOutlineList.querySelectorAll('.workout-outline-item').forEach(function(item, i) {
    item.querySelector('.workout-outline-num').textContent = i + 1
  })
}

// Reorders the real exercise cards to match the outline's current order
function syncCardOrderToOutline() {
  const order = [...workoutOutlineList.querySelectorAll('.workout-outline-item')].map(item => item.dataset.id)
  order.forEach(function(id) {
    const card = sectionDropZone.querySelector(`.builder-exercise-card[data-id="${id}"]`)
    if (card) sectionDropZone.appendChild(card)
  })
}

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
  }]).select('*, exercises!exercise_id(id, name, category, type, video_url, tracks_reps, tracks_weight, is_timed, is_unilateral, tracks_distance)')

  if (error) { console.log(error); customAlert('Something went wrong'); return }

  const newRow = data[0]
  exercisesCache.push(newRow)

  const container = root.querySelector('#sectionExercisesList')
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
  const container = root.querySelector('#' + containerId)
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
  const rows = root.querySelectorAll('#' + containerId + ' .extra-field-row')
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
// Opened from a card's kebab menu (see 'add-extra-field' above) instead of
// a permanent "+ Add Field" button sitting on every card. Names come from
// extra_field_names, the same coach-wide reusable library Workout Builder's
// picker uses.
// ==========================================================================
async function loadExtraFieldNames() {
  if (extraFieldNamesCache) return extraFieldNamesCache
  const { data, error } = await window.fetchWithRetry((signal) => supabase
    .from('extra_field_names')
    .select('id, name')
    .order('name')
    .abortSignal(signal)
  )
  if (error) { console.log(error); extraFieldNamesCache = []; return extraFieldNamesCache }
  extraFieldNamesCache = data
  return extraFieldNamesCache
}

async function openExtraFieldPicker(seId) {
  extraFieldPickerSeId = seId
  const names = await loadExtraFieldNames()
  const list = root.querySelector('#extraFieldPickerList')
  list.innerHTML = names.length
    ? names.map(n => `<button type="button" class="chip-btn" data-name="${n.name}">${n.name}</button>`).join('')
    : '<p class="no-metrics">No fields created yet - add one below</p>'
  root.querySelector('#newExtraFieldNameInput').value = ''
  root.querySelector('#extraFieldPickerModal').classList.add('active')
}

function pickExtraField(name) {
  if (!extraFieldPickerSeId || !name) return
  const containerId = `extraFields-${extraFieldPickerSeId}`
  if (root.querySelector(`#${containerId} .extra-field-row[data-name="${name}"]`)) {
    root.querySelector('#extraFieldPickerModal').classList.remove('active')
    return // already on this card - avoid a silent duplicate that only the last one would save
  }
  addExtraFieldRow(containerId, name, '')
  root.querySelector('#extraFieldPickerModal').classList.remove('active')
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

// Brought up to parity with training-builder.js/program-builder.js's own
// renderSetTargetRow here - this one used to just relabel the reps input's
// placeholder for a timed exercise instead of giving it a real mm:ss
// timer, the only one of the four builders with that gap.
function renderSetTargetRow(setNumber, target, tracksReps, isTimed, tracksWeight, isUnilateral, onlyRow) {
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
  return [...sectionDropZone.querySelectorAll(`.builder-exercise-card[data-superset-group-id="${groupId}"]`)].filter(c => c !== card)
}

// Reads a set row's current (possibly-edited) field values, so a new set
// added below it starts from what's already there instead of always blank -
// an untouched row's inputs are still at their blank defaults, so this
// naturally stays blank too when nothing was filled in yet.
function readSetRowValues(rowEl) {
  if (!rowEl) return { reps: null, duration: null, weight: null, rest: null, type: 'main' }
  const repsInput = rowEl.querySelector('.set-reps-input')
  const weightInput = rowEl.querySelector('.set-weight-input')
  const typeSelect = rowEl.querySelector('.set-type-select')
  const timeMm = rowEl.querySelector('.set-time-mm:not(.set-rest-mm)')
  const timeSs = rowEl.querySelector('.set-time-ss:not(.set-rest-ss)')
  const restMm = rowEl.querySelector('.set-rest-mm')
  const restSs = rowEl.querySelector('.set-rest-ss')
  return {
    reps: repsInput ? repsInput.value : null,
    duration: timeMm ? `${timeMm.value}:${timeSs.value}` : null,
    weight: weightInput && weightInput.value !== '' ? weightInput.value : null,
    rest: restMm ? `${restMm.value}:${restSs.value}` : null,
    type: typeSelect ? typeSelect.value : 'main'
  }
}

function addSetTargetRow(rowsEl, tracksReps, isTimed, tracksWeight, isUnilateral) {
  const rows = [...rowsEl.querySelectorAll('.set-target-row')]
  if (rows.length === 1) rows[0].querySelector('.set-remove-btn').disabled = false
  const carryOver = readSetRowValues(rows[rows.length - 1])
  rowsEl.insertAdjacentHTML('beforeend', renderSetTargetRow(rows.length + 1, carryOver, tracksReps, isTimed, tracksWeight, isUnilateral, false))
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
// straight from the exercise's own row (se.exercises) - an explicit
// *_override on THIS section_exercises row (set via a card's "Adjust
// Fields" menu, scoped to just this one section) takes precedence instead.
// Merging the override into se.exercises here, once per fetch, means every
// existing read of se.exercises.* downstream (set-target rows, badges,
// etc.) sees the right effective value with no other changes needed.
function applyFieldOverrides(se) {
  if (!se.exercises) return
  if (se.tracks_weight_override != null) se.exercises.tracks_weight = se.tracks_weight_override
  if (se.is_timed_override != null) se.exercises.is_timed = se.is_timed_override
  if (se.is_unilateral_override != null) se.exercises.is_unilateral = se.is_unilateral_override
  if (se.tracks_distance_override != null) se.exercises.tracks_distance = se.tracks_distance_override
}

async function loadExercisesList(token) {
  const { data, error } = await window.fetchWithRetry((signal) => supabase
    .from('section_exercises')
    .select('*, exercises!exercise_id(id, name, category, type, video_url, tracks_reps, tracks_weight, is_timed, is_unilateral, tracks_distance)')
    .eq('section_id', sectionId)
    .abortSignal(signal)
  )
  if (!nav.isCurrent(token)) return

  if (error) { console.log('Error loading section exercises:', error); customAlert('Something went wrong loading this section\'s exercises - check your connection and try again'); return }

  data.sort((a, b) => a.order_index - b.order_index)
  data.forEach(applyFieldOverrides)
  exercisesCache = data
  renderExercisesList()
}

function renderExercisesList() {
  const container = root.querySelector('#sectionExercisesList')

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
  const tracksReps = !se.exercises || se.exercises.tracks_reps !== false
  const isTimed = se.exercises && se.exercises.is_timed
  const tracksWeight = !se.exercises || se.exercises.tracks_weight
  const isUnilateral = se.exercises && se.exercises.is_unilateral
  const videoUrl = (se.exercises && se.exercises.video_url) || ''
  const thumb = getYouTubeThumbnail(videoUrl)
  const targets = deriveSetTargets(se)
  const rowsHtml = targets.map((t, i) => renderSetTargetRow(i + 1, t, tracksReps, isTimed, tracksWeight, isUnilateral, targets.length === 1)).join('')
  const groupMembers = se.superset_group_id ? exercisesCache.filter(other => other.id !== se.id && other.superset_group_id === se.superset_group_id) : []
  const groupColor = se.superset_group_id ? colorForSupersetGroup(se.superset_group_id) : null
  const linkTitle = groupMembers.length
    ? `Linked with ${groupMembers.map(m => m.exercises ? m.exercises.name : 'exercise').join(', ')} - tap to remove`
    : 'Link with other exercises (superset)'
  const altExercise = se.alternative_exercise_id ? allExercises.find(ex => ex.id === se.alternative_exercise_id) : null

  return `
    <div class="builder-exercise-card" data-id="${se.id}" data-superset-group-id="${se.superset_group_id || ''}">
      <div class="builder-exercise-card-header">
        <span class="builder-drag-handle" draggable="true" title="Drag to reorder">⠿</span>
        <button type="button" class="builder-exercise-thumb" ${videoUrl ? `data-video-url="${videoUrl}"` : 'disabled'}>
          ${thumb ? `<img src="${thumb}" alt="" loading="lazy">` : '<span class="builder-exercise-thumb-placeholder"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="4" cy="12" r="2"></circle><circle cx="20" cy="12" r="2"></circle><line x1="6" y1="12" x2="18" y2="12"></line><line x1="9" y1="8" x2="9" y2="16"></line><line x1="15" y1="8" x2="15" y2="16"></line></svg></span>'}
        </button>
        <div class="builder-exercise-name">${se.exercises ? se.exercises.name : 'Unknown exercise'}</div>
        ${isUnilateral ? '<span class="builder-unilateral-badge">Each Side</span>' : ''}
        ${altExercise ? `<span class="builder-unilateral-badge" title="Athletes can switch to this if they can't do the main exercise">Alt: ${altExercise.name}</span>` : ''}
        <button type="button" class="builder-link-btn ${se.superset_group_id ? 'linked' : ''}" data-action="toggle-link" style="${groupColor ? `border-color:${groupColor}; color:${groupColor}; background-color:${groupColor}22` : ''}" title="${linkTitle}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 7h3a5 5 0 0 1 5 5 5 5 0 0 1-5 5h-3m-6 0H6a5 5 0 0 1-5-5 5 5 0 0 1 5-5h3"></path><line x1="8" y1="12" x2="16" y2="12"></line></svg></button>
        <div class="kebab-menu builder-kebab-menu">
          <button type="button" class="builder-kebab-btn" data-action="toggle-kebab" title="More options">⋮</button>
          <div class="kebab-dropdown">
            <button type="button" class="kebab-item" data-action="adjust-fields">Adjust Fields</button>
            <button type="button" class="kebab-item" data-action="add-extra-field">+ Add Field</button>
            <button type="button" class="kebab-item" data-action="edit-exercise">Adjust Exercise</button>
            <button type="button" class="kebab-item" data-action="set-alternative">${altExercise ? 'Change' : 'Set'} Alternative Exercise</button>
          </div>
        </div>
        <button type="button" class="btn-delete-measurement" data-action="delete-exercise" title="Remove from section"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg></button>
      </div>
      <div class="set-target-rows">
        ${rowsHtml}
      </div>
      <button type="button" class="builder-add-set-btn" data-action="add-set">+ Add Set</button>
      <div class="extra-fields-container" id="extraFields-${se.id}"></div>
      <div class="builder-exercise-notes">
        <label>Notes (visible to the athlete)</label>
        <textarea class="exercise-notes-input" placeholder="e.g. Focus on controlled tempo">${se.notes || ''}</textarea>
      </div>
    </div>
  `
}

// Reads one card's current DOM state and saves it - called for every
// exercise at once from the single page-level Save button, not from a
// per-card button. Returns true/false instead of alerting on its own so
// the caller can report one combined error if several cards fail.
async function saveExerciseCard(seId, orderIndex) {
  const card = root.querySelector(`.builder-exercise-card[data-id="${seId}"]`)
  if (!card) return true

  const se = exercisesCache.find(s => s.id === seId)
  const isTimed = !!(se && se.exercises && se.exercises.is_timed)

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
    const restMm = parseInt(row.querySelector('.set-rest-mm').value) || 0
    const restSs = parseInt(row.querySelector('.set-rest-ss').value) || 0
    const rest = (restMm === 0 && restSs === 0) ? null : restMm * 60 + restSs
    const type = row.querySelector('.set-type-select').value
    return { reps, duration, weight, rest, type }
  })

  const notes = card.querySelector('.exercise-notes-input').value.trim() || null
  const extraFields = collectExtraFields(`extraFields-${seId}`)
  const first = setTargets[0] || { reps: null, duration: null, weight: null, rest: null }

  const updates = {
    set_targets: setTargets,
    prescribed_sets: setTargets.length,
    prescribed_reps: first.reps != null ? first.reps : first.duration,
    prescribed_weight: first.weight,
    rest_seconds: first.rest,
    extra_fields: extraFields,
    notes,
    order_index: orderIndex,
    superset_group_id: card.dataset.supersetGroupId || null
  }

  const { error } = await supabase.from('section_exercises').update(updates).eq('id', seId)

  if (error) { console.log(error); return false }
  // Keeps exercisesCache in sync with what's actually saved, so any action
  // that re-renders a card from cache (Adjust Fields, Set Alternative,
  // Adjust Exercise) reflects what was just typed instead of overwriting it
  // with stale pre-edit data - see scheduleAutosave/flushCardSave below.
  if (se) Object.assign(se, updates)
  return true
}

// ==========================================================================
// ---- AUTOSAVE ----
// Every set/notes/extra-field edit and superset link/unlink used to only
// persist when the coach pressed the page's one big Save button - meaning
// any of the kebab actions above (which redraw a card straight from
// exercisesCache) would silently wipe out whatever was typed but not yet
// saved. Now every edit gets written to the database on its own, a moment
// after the coach stops typing (same "it just stays, unless you change it
// yourself" reliability the athlete's own logging screen already has) -
// the big Save button still exists for the final "I'm done" navigation,
// but nothing is ever actually waiting on it anymore.
// ==========================================================================
const AUTOSAVE_FIELD_SELECTOR = '.set-reps-input, .set-weight-input, .set-time-mm, .set-time-ss, .exercise-notes-input, .extra-field-value'

function scheduleAutosave(seId) {
  clearTimeout(autosaveTimers[seId])
  autosaveTimers[seId] = setTimeout(() => flushCardSave(seId), 800)
}

async function flushCardSave(seId) {
  clearTimeout(autosaveTimers[seId])
  delete autosaveTimers[seId]
  const ids = [...root.querySelectorAll('#sectionExercisesList .builder-exercise-card')].map(c => c.dataset.id)
  const orderIndex = ids.indexOf(seId)
  if (orderIndex === -1) return true
  return saveExerciseCard(seId, orderIndex)
}

// Flushes every card at once - used right before an action rebuilds the
// WHOLE list from exercisesCache (Adjust Exercise), so nothing mid-edit on
// any other card gets lost in that rebuild.
async function flushAllPendingSaves() {
  const ids = [...root.querySelectorAll('#sectionExercisesList .builder-exercise-card')].map(c => c.dataset.id)
  await Promise.all(ids.map((id, i) => { clearTimeout(autosaveTimers[id]); delete autosaveTimers[id]; return saveExerciseCard(id, i) }))
}

// Removes just this one card instead of reloading + re-rendering the whole
// list, so any unsaved edits sitting in other cards' rows aren't wiped out
async function deleteExerciseRow(id) {
  if (!(await customConfirm('Remove this exercise from the section?'))) return

  clearTimeout(autosaveTimers[id])
  delete autosaveTimers[id]
  const card = root.querySelector(`.builder-exercise-card[data-id="${id}"]`)
  if (card && card.dataset.supersetGroupId) removeFromSupersetGroup(id, sectionDropZone)

  const { error } = await supabase.from('section_exercises').delete().eq('id', id)
  if (error) { console.log(error); customAlert('Something went wrong'); return }

  exercisesCache = exercisesCache.filter(se => se.id !== id)
  if (card) card.remove()
  if (exercisesCache.length === 0) {
    root.querySelector('#sectionExercisesList').innerHTML = '<p class="no-metrics">No exercises yet — drag one in from the library on the left</p>'
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
  const bar = root.querySelector('#pickingModeBar')
  if (!bar) return
  if (!pickingGroupIds) { bar.style.display = 'none'; return }
  bar.style.display = 'flex'
  const n = pickingGroupIds.length
  root.querySelector('#pickingModeBarCount').textContent = `${n} exercise${n === 1 ? '' : 's'} selected`
  const finishBtn = root.querySelector('#pickingModeBarFinishBtn')
  finishBtn.disabled = n < 2
  finishBtn.onclick = () => finalizePicking(listScopeEl)
  root.querySelector('#pickingModeBarCancelBtn').onclick = () => exitPickingMode(listScopeEl)
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
  ids.forEach(scheduleAutosave)
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
  scheduleAutosave(id)
  remaining.forEach(c => scheduleAutosave(c.dataset.id))
}

// Deterministic color per superset group id, so several groups on the
// same list are visually distinguishable at a glance without spelling out
// which exercises are linked (that's in the 🔗 button's title tooltip
// instead) - same group id always resolves to the same color
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

// ==========================================================================
// ---- ADJUST FIELDS (per-instance override) ----
// ==========================================================================
function openAdjustFieldsModal(se) {
  if (!se) return
  adjustFieldsSeId = se.id
  root.querySelector('#adjustFieldsExerciseName').textContent = se.exercises ? se.exercises.name : ''
  root.querySelector('#adjustFieldsTracksWeight').checked = !se.exercises || !!se.exercises.tracks_weight
  root.querySelector('#adjustFieldsIsTimed').checked = !!(se.exercises && se.exercises.is_timed)
  root.querySelector('#adjustFieldsIsUnilateral').checked = !!(se.exercises && se.exercises.is_unilateral)
  root.querySelector('#adjustFieldsTracksDistance').checked = !!(se.exercises && se.exercises.tracks_distance)
  root.querySelector('#adjustFieldsModal').classList.add('active')
}

// ==========================================================================
// ---- SET ALTERNATIVE EXERCISE ----
// A coach-curated single fallback exercise for when an athlete can't do the
// prescribed one (no equipment, an injury) - shown to the athlete as a
// quick one-tap icon during the guided workout instead of the free-search
// Swap button. Search reuses allExercises, the same library cache already
// loaded for the drag-in panel on the left - no separate query needed.
// ==========================================================================
function openSetAlternativeModal(se) {
  if (!se) return
  setAlternativeSeId = se.id
  root.querySelector('#setAlternativeExerciseName').textContent = se.exercises ? `For: ${se.exercises.name}` : ''
  root.querySelector('#setAlternativeSearchInput').value = ''
  const removeBtn = root.querySelector('#removeAlternativeBtn')
  removeBtn.style.display = se.alternative_exercise_id ? '' : 'none'
  renderSetAlternativeList()
  root.querySelector('#setAlternativeModal').classList.add('active')
}

function renderSetAlternativeList() {
  const filter = root.querySelector('#setAlternativeSearchInput').value.trim().toLowerCase()
  const se = exercisesCache.find(s => s.id === setAlternativeSeId)
  const ownExerciseId = se ? se.exercise_id : null
  const filtered = (filter ? allExercises.filter(ex => ex.name.toLowerCase().includes(filter)) : allExercises)
    .filter(ex => ex.id !== ownExerciseId)

  const list = root.querySelector('#setAlternativeList')
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

async function saveAlternativeExercise(seId, altExerciseId) {
  if (!seId) return
  const { error } = await supabase.from('section_exercises').update({ alternative_exercise_id: altExerciseId }).eq('id', seId)
  if (error) { console.log(error); customAlert('Something went wrong saving that - try again'); return }

  const se = exercisesCache.find(s => s.id === seId)
  if (se) {
    se.alternative_exercise_id = altExerciseId
    const card = root.querySelector(`.builder-exercise-card[data-id="${se.id}"]`)
    if (card) {
      card.outerHTML = renderExerciseCard(se)
      if (se.extra_fields) {
        for (const [k, v] of Object.entries(se.extra_fields)) addExtraFieldRow(`extraFields-${se.id}`, k, v)
      }
    }
  }

  root.querySelector('#setAlternativeModal').classList.remove('active')
}

// ==========================================================================
// ---- CREATE NEW EXERCISE ----
// Opened from the Exercise Library panel. Saving adds it to both the
// searchable library and straight onto the section.
// ==========================================================================
function populateCreateCategorySelect() {
  const select = root.querySelector('#sCreateExerciseCategory')
  const categories = [...new Set(allExercises.map(ex => ex.category).filter(c => c && c.trim()))].sort()
  select.innerHTML = '<option value="">Choose Category</option>' +
    categories.map(c => `<option value="${c}">${c}</option>`).join('') +
    '<option value="__new__">+ Add New Category</option>'
  select.value = ''
  toggleCreateNewCategoryField()
}

function toggleCreateNewCategoryField() {
  const isNew = root.querySelector('#sCreateExerciseCategory').value === '__new__'
  root.querySelector('#sCreateExerciseNewCategoryGroup').style.display = isNew ? 'block' : 'none'
}

function populateCreateTypeSelect() {
  const select = root.querySelector('#sCreateExerciseType')
  const customTypes = [...new Set(allExercises.map(ex => ex.type).filter(t => t && !(t in BUILT_IN_TYPES)))].sort()
  select.innerHTML =
    Object.entries(BUILT_IN_TYPES).map(([value, label]) => `<option value="${value}">${label}</option>`).join('') +
    customTypes.map(t => `<option value="${t}">${t}</option>`).join('') +
    '<option value="__new__">+ Add New Type</option>'
  select.value = 'weights'
  toggleCreateNewTypeField()
}

function toggleCreateNewTypeField() {
  const isNew = root.querySelector('#sCreateExerciseType').value === '__new__'
  root.querySelector('#sCreateExerciseNewTypeGroup').style.display = isNew ? 'block' : 'none'
}

// Nudges the logging-field toggles to their common defaults when the coach
// actually picks a type - the coach can still flip either toggle back
// afterward for a less common combination (e.g. a weighted timed hold)
function applyTypeLoggingDefaults(type) {
  if (type === 'timed') {
    root.querySelector('#sCreateExerciseTracksReps').checked = false
    root.querySelector('#sCreateExerciseIsTimed').checked = true
    root.querySelector('#sCreateExerciseTracksWeight').checked = false
  } else if (type === 'weights') {
    root.querySelector('#sCreateExerciseTracksReps').checked = true
    root.querySelector('#sCreateExerciseIsTimed').checked = false
    root.querySelector('#sCreateExerciseTracksWeight').checked = true
  }
}

// "Adjust Exercise" (a section card's kebab menu) is editing an existing
// one in place - both share this one modal, just with different
// title/button and a different save handler (see openExerciseModal below
// and the two save button handlers in bindEvents)
function openExerciseModal(exercise) {
  editingExerciseId = exercise.id
  root.querySelector('#sCreateExerciseModalTitle').textContent = 'Adjust Exercise'
  root.querySelector('#saveSCreateExerciseBtn').style.display = 'none'
  root.querySelector('#saveSEditExerciseBtn').style.display = ''
  root.querySelector('#sCreateExerciseName').value = exercise.name || ''
  root.querySelector('#sCreateExerciseNewCategory').value = ''
  populateCreateCategorySelect()
  root.querySelector('#sCreateExerciseCategory').value = exercise.category || ''
  root.querySelector('#sCreateExerciseNewType').value = ''
  populateCreateTypeSelect()
  root.querySelector('#sCreateExerciseType').value = exercise.type || 'weights'
  toggleCreateNewCategoryField()
  toggleCreateNewTypeField()
  root.querySelector('#sCreateExerciseTracksReps').checked = exercise.tracks_reps !== false
  root.querySelector('#sCreateExerciseTracksWeight').checked = !!exercise.tracks_weight
  root.querySelector('#sCreateExerciseIsTimed').checked = !!exercise.is_timed
  root.querySelector('#sCreateExerciseIsUnilateral').checked = !!exercise.is_unilateral
  root.querySelector('#sCreateExerciseTracksDistance').checked = !!exercise.tracks_distance
  root.querySelector('#sCreateExerciseVideoUrl').value = exercise.video_url || ''
  root.querySelector('#sCreateExerciseInstructions').value = exercise.instructions || ''
  root.querySelector('#sCreateExerciseModal').classList.add('active')
}
