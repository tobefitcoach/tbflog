// ==========================================================================
// WORKOUT BUILDER — screen, and the calendar / Program Builder overlay
// Edits one training's flat exercise list. Same picker/edit patterns as
// program-builder.js, just without the week/day nesting - a training is
// always one flat session. Each exercise is an always-editable card (video
// thumbnail, one row per set with its own reps/weight target, rest time,
// notes) instead of a popup modal - mirrors the athlete's own live workout
// screen (athlete-app/workout/: renderActiveExercise, renderSetRow).
//
// Doubles as the editor for one already-scheduled calendar day when opened
// with a dayId instead of a training id (the athlete calendar's and Program
// Builder's "Build Workout" overlay) - same search-the-library/drag/reorder
// UI either way, just pointed at program_exercises for that day instead of
// training_exercises for a Workout Library template. EXERCISE_TABLE/
// PARENT_FIELD/parentId below are the only three things that differ
// between the two modes; everything else in this file reads through them.
//
// Two ways in:
//   - the 'training-builder' route (Workout Library): mount/beforeLeave/
//     unmount below, with a slim back bar above the builder
//   - openBuilder/flushBuilder/closeBuilder, which athlete-detail/ and
//     program-builder.js call to show it inside their overlay
// Only one builder is ever open at a time. It used to be the separate
// training-builder.html page shown in an iframe; running in the app
// instead means it opens without reloading everything, and an autosave
// still in flight when it closes simply finishes instead of being dropped.
// ==========================================================================
import { supabase } from '../../coachClient.js?v=__V__'
import * as nav from '../nav.js?v=__V__'
import { coachId } from '../session.js?v=__V__'
import { ensureCss } from '../lazy-css.js?v=__V__'
import { getYouTubeThumbnail, getYouTubeEmbedUrl } from '../../shared/video.js?v=__V__'
import { applyFieldOverrides } from '../../shared/exercise-fields.js?v=__V__'
import { copyExercises } from '../../shared/copy-exercises.js?v=__V__'
import { customAlert, customConfirm } from '../../confirm-modal.js?v=__V__'
import { fetchWithRetry } from '../../network-retry.js?v=__V__'

const ROUTE_TEMPLATE = `
  <div class="tb-route" id="trainingBuilderRoute">
    <div class="screen-header tb-route-bar">
      <button class="btn-back" id="trainingBuilderRouteBackBtn" aria-label="Back to Workout Library"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"></polyline></svg></button>
      <span class="tb-route-bar-label">Workout Library</span>
    </div>
    <div class="tb-host" id="trainingBuilderRouteHost"></div>
  </div>
`

const TEMPLATE = `
  <div class="app-layout">
    <!-- Mini Exercise Library: search + drag source. Dropping a card onto
         the training's exercise list on the right adds it (with blank
         prescribed values - click the exercise afterward to fill those
         in). "+ Create New Exercise" adds straight to both this library
         and the training. -->
    <div class="exercise-library-panel" id="exerciseLibraryPanel">
      <div class="exercise-library-panel-head">
        <h3>Exercise Library</h3>
        <!-- Mobile only (see the (max-width:768px) block in builders.css) -
             the panel starts collapsed there so the workout itself is the
             first thing on screen instead of a full search UI pushing it
             below the fold. Desktop never sees this button; the panel is
             always expanded there, same as before. -->
        <button type="button" class="library-toggle-btn" id="libraryToggleBtn">+ Add Exercise</button>
      </div>
      <div class="exercise-library-body" id="exerciseLibraryBody">
        <input type="text" id="exerciseSearchInput" class="exercise-search-input" placeholder="Search exercises..." />
        <div class="chip-row" id="exerciseCategoryChips" style="margin:10px 0"></div>
        <button class="btn-create-metric" id="openCreateExerciseBtn">+ Create New Exercise</button>
        <div class="exercise-library-list" id="exerciseLibraryList"></div>
      </div>
    </div>

    <div class="dashboard training-builder-main">
      <div class="dashboard-header">
        <div style="display:flex; align-items:center; gap:12px">
          <h2 id="trainingNameHeading">Loading...</h2>
          <!-- Day mode only - see paintLiveBadge() in training-builder.js -->
          <span class="live-link-badge" id="liveLinkBadge" style="display:none" title="Still tracking the Workout Library entry it was built from - editing that Training updates this day automatically, until it's started or hand-edited">Live</span>
          <select id="trainingTypeSelect" class="workout-type-select">
            <option value="gym">Gym</option>
            <option value="field">Field</option>
            <option value="run">Run</option>
          </select>
        </div>
        <div style="display:flex; gap:12px">
          <button class="btn-profile-action" id="renameTrainingBtn">Rename</button>
          <button class="btn-profile-action" id="addSectionBtn">Add Section</button>
          <!-- Day mode only (?dayId= instead of ?id=) - inserting a whole
               other Workout Library entry's exercises only makes sense
               onto an already-scheduled day, not into a training that IS
               one, so this stays hidden/shown opposite Add Section -->
          <button class="btn-profile-action" id="addWorkoutToDayBtn" style="display:none">Add Workout</button>
          <button class="btn-save" id="saveTrainingBtn">Save</button>
        </div>
      </div>
      <p class="training-empty-hint" id="trainingEmptyHint">Tap an exercise's + to add it here, or drag one on desktop.</p>
      <div id="trainingExercisesList"></div>
    </div>

    <!-- Exercise order outline: just names, in order - dragging one of
         these rows is a lot easier than dragging a whole tall exercise
         card, so it's a second, quicker way to reorder the same list
         (see training-builder.js's outline drag handlers, which keep
         this and the exercise cards on the left in sync with each
         other). Reordering is still mouse-drag only (see the file's own
         header comment on scope) - #outlineOrderHint below swaps its
         text on a touch device so it doesn't promise a drag that can't
         happen there. -->
    <div class="workout-outline-panel">
      <h3>Exercise Order</h3>
      <p style="color:#aaaacc; font-size:11px; margin-top:-8px; margin-bottom:12px" id="outlineOrderHint">Drag to reorder</p>
      <div class="workout-outline-list" id="workoutOutlineList"></div>
    </div>
  </div>

  <!-- Rename Training Modal -->
  <div class="modal-overlay" id="renameTrainingModal">
    <div class="modal">
      <h2 id="renameTrainingModalTitle">Rename Workout</h2>
      <div class="form-group">
        <label>Name</label>
        <input type="text" id="renameTrainingInput" />
      </div>
      <div class="form-actions">
        <button class="btn-cancel" id="cancelRenameTrainingBtn">Cancel</button>
        <button class="btn-save" id="saveRenameTrainingBtn">Save</button>
      </div>
    </div>
  </div>

  <!-- Create New Exercise Modal: opened from the Exercise Library panel's
       "+ Create New Exercise" button, adds straight to the training too -->
  <div class="modal-overlay" id="tCreateExerciseModal">
    <div class="modal">
      <h2 id="tCreateExerciseModalTitle">Create New Exercise</h2>
      <div class="form-group">
        <label>Name</label>
        <input type="text" id="tCreateExerciseName" placeholder="e.g. Romanian Deadlift" />
      </div>
      <div class="form-group">
        <label>Category</label>
        <select id="tCreateExerciseCategory">
          <option value="__new__">+ Add New Category</option>
        </select>
      </div>
      <div class="form-group" id="tCreateExerciseNewCategoryGroup" style="display:none">
        <label>New Category Name</label>
        <input type="text" id="tCreateExerciseNewCategory" placeholder="e.g. Legs" />
      </div>
      <div class="form-group">
        <label>Type</label>
        <select id="tCreateExerciseType">
          <option value="weights">Weightlifting (sets, reps, weight)</option>
          <option value="timed">Timed (sets, duration)</option>
          <option value="plyometric">Plyometric (sets, foot contacts, intensity)</option>
          <option value="__new__">+ Add New Type</option>
        </select>
      </div>
      <div class="form-group" id="tCreateExerciseNewTypeGroup" style="display:none">
        <label>New Type Name</label>
        <input type="text" id="tCreateExerciseNewType" placeholder="e.g. Sprints" />
      </div>
      <div class="form-group">
        <label>Logging Fields</label>
        <p style="color:#aaaacc; font-size:12px; margin:-2px 0 8px">What to track when this exercise is logged - independent of Type above, so any combination works (e.g. reps AND a hold time, or a weighted timed hold).</p>
        <label class="bodyweight-toggle" style="margin-bottom:8px"><span>Track Reps</span>
          <span class="toggle-switch"><input type="checkbox" id="tCreateExerciseTracksReps" checked><span class="toggle-slider"></span></span>
        </label>
        <label class="bodyweight-toggle" style="margin-bottom:8px"><span>Track Weight (kg)</span>
          <span class="toggle-switch"><input type="checkbox" id="tCreateExerciseTracksWeight" checked><span class="toggle-slider"></span></span>
        </label>
        <label class="bodyweight-toggle" style="margin-bottom:8px"><span>Timed</span>
          <span class="toggle-switch"><input type="checkbox" id="tCreateExerciseIsTimed"><span class="toggle-slider"></span></span>
        </label>
        <label class="bodyweight-toggle" style="margin-bottom:8px"><span>Log Each Side (unilateral)</span>
          <span class="toggle-switch"><input type="checkbox" id="tCreateExerciseIsUnilateral"><span class="toggle-slider"></span></span>
        </label>
        <label class="bodyweight-toggle"><span>Track Distance (meters)</span>
          <span class="toggle-switch"><input type="checkbox" id="tCreateExerciseTracksDistance"><span class="toggle-slider"></span></span>
        </label>
      </div>
      <div class="form-group">
        <label>Video Link (optional)</label>
        <input type="url" id="tCreateExerciseVideoUrl" placeholder="https://youtube.com/..." />
      </div>
      <div class="form-group">
        <label>Instructions (optional)</label>
        <textarea id="tCreateExerciseInstructions" class="notes-textarea"></textarea>
      </div>
      <div class="form-actions">
        <button class="btn-cancel" id="cancelTCreateExerciseBtn">Cancel</button>
        <button class="btn-save" id="saveTCreateExerciseBtn">Create & Select</button>
        <button class="btn-save" id="saveTEditExerciseBtn" style="display:none">Save Changes</button>
      </div>
    </div>
  </div>

  <!-- Add Section popup: list + preview, same layout pattern as the
       calendar's "Add Workout" popup - picking a row previews it on the
       right, Insert bulk-copies its exercises into this training. -->
  <div class="modal-overlay" id="addSectionModal">
    <div class="modal modal-wide">
      <div class="graph-modal-header">
        <h2>Add Section</h2>
        <button class="btn-cancel" id="closeAddSectionBtn">✕</button>
      </div>
      <div class="day-add-workout-layout">
        <div class="day-add-workout-list-col">
          <div class="day-add-workout-list-header">
            <span class="day-add-workout-list-title">Sections</span>
            <a href="dashboard.html" target="_blank" class="btn-small-create">+ New</a>
          </div>
          <div class="entries-modal-body" id="addSectionList"></div>
        </div>
        <div class="day-add-workout-preview" id="addSectionPreview">
          <p class="no-metrics">Select a section to preview it</p>
        </div>
      </div>
      <div class="form-actions" style="justify-content:flex-end; margin-top:16px">
        <button class="btn-save" id="insertSectionBtn" disabled>Insert</button>
      </div>
    </div>
  </div>

  <!-- Add Workout popup - day mode only (see addWorkoutToDayBtn). Same
       list + preview pattern as Add Section above, sourced from the
       Workout Library instead, bulk-copying that training's exercises
       onto this day. -->
  <div class="modal-overlay" id="addWorkoutToDayModal">
    <div class="modal modal-wide">
      <div class="graph-modal-header">
        <h2>Add Workout</h2>
        <button class="btn-cancel" id="closeAddWorkoutToDayBtn">✕</button>
      </div>
      <div class="day-add-workout-layout">
        <div class="day-add-workout-list-col">
          <div class="day-add-workout-list-header">
            <span class="day-add-workout-list-title">Workouts</span>
            <a href="dashboard.html" target="_blank" class="btn-small-create">+ New</a>
          </div>
          <div class="entries-modal-body" id="addWorkoutToDayList"></div>
        </div>
        <div class="day-add-workout-preview" id="addWorkoutToDayPreview">
          <p class="no-metrics">Select a workout to preview it</p>
        </div>
      </div>
      <div class="form-actions" style="justify-content:flex-end; margin-top:16px">
        <button class="btn-save" id="insertWorkoutToDayBtn" disabled>Insert</button>
      </div>
    </div>
  </div>

  <!-- Adjust Fields Modal: opened from an exercise card's ⋮ menu - sets a
       per-instance override (tracks_weight_override/is_timed_override/
       is_unilateral_override/tracks_distance_override) on THIS training's
       row, scoped to just this one workout. The exercise's own default in
       Exercise Library is never touched. -->
  <div class="modal-overlay" id="adjustFieldsModal">
    <div class="modal">
      <div class="graph-modal-header">
        <h2>Adjust Fields</h2>
        <button type="button" class="btn-cancel" id="closeAdjustFieldsBtn">✕</button>
      </div>
      <p style="color:#aaaacc; font-size:13px; margin:-6px 0 16px" id="adjustFieldsExerciseName"></p>
      <div class="form-group">
        <label>Logging Fields</label>
        <p style="color:#aaaacc; font-size:12px; margin:-2px 0 8px">What to track when this exercise is logged - independent of Type, so any combination works (e.g. a weighted timed hold). Applies only to this workout - the exercise's own default in Exercise Library stays unchanged.</p>
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
        <button class="btn-cancel" id="cancelAdjustFieldsBtn">Cancel</button>
        <button class="btn-save" id="saveAdjustFieldsBtn">Save</button>
      </div>
    </div>
  </div>

  <!-- Set Alternative Exercise: opened from a card's kebab menu - picks a
       single coach-curated fallback the athlete can one-tap switch to if
       they can't do the prescribed exercise. See openSetAlternativeModal
       in training-builder.js. -->
  <div class="modal-overlay" id="setAlternativeModal">
    <div class="modal">
      <div class="graph-modal-header">
        <h2>Alternative Exercise</h2>
        <button type="button" class="btn-cancel" id="closeSetAlternativeBtn">✕</button>
      </div>
      <p style="color:#aaaacc; font-size:13px; margin-top:-8px" id="setAlternativeExerciseName"></p>
      <input type="text" id="setAlternativeSearchInput" class="exercise-search-input" placeholder="Search exercises..." />
      <div class="exercise-library-list" id="setAlternativeList" style="max-height:320px; overflow-y:auto; margin-top:10px"></div>
      <button type="button" class="btn-cancel" id="removeAlternativeBtn" style="margin-top:12px; width:100%">Remove Alternative</button>
    </div>
  </div>

  <!-- Field picker: opened from a card's kebab "+ Add Field" - pick from
       the coach's reusable extra_field_names library, or type a new one.
       See openExtraFieldPicker() in training-builder.js -->
  <div class="modal-overlay" id="extraFieldPickerModal">
    <div class="modal">
      <div class="graph-modal-header">
        <h2>Add Field</h2>
        <button type="button" class="btn-cancel" id="closeExtraFieldPickerBtn">✕</button>
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

  <!-- Shown only while linking a superset - see updatePickingModeBar() in
       training-builder.js -->
  <div class="picking-mode-bar" id="pickingModeBar" style="display:none">
    <span class="picking-mode-bar-count" id="pickingModeBarCount"></span>
    <div class="picking-mode-bar-actions">
      <button type="button" class="btn-cancel" id="pickingModeBarCancelBtn">Cancel</button>
      <button type="button" class="btn-save" id="pickingModeBarFinishBtn">✓ Finish Superset</button>
    </div>
  </div>
`

// ---- Which builder is open ----
let host = null // the element the builder is rendered into
let gen = 0 // bumped on every open/close, so a slow load from a closed builder never paints
let trainingId = null
let dayId = null
let isDayMode = false
let EXERCISE_TABLE = 'training_exercises'
let PARENT_FIELD = 'training_id'
let parentId = null
let onDocClickKebab = null
let hostResizeObserver = null

// Looks up an element of THIS builder by id - scoped to host, since the
// overlay version sits inside another screen's DOM
function $(id) {
  return host.querySelector('#' + CSS.escape(id))
}

// The element the open builder is rendered into, or null
export function builderHost() {
  return host
}

// Renders the builder into container and loads it. Pass { id } for a
// Workout Library training, or { dayId } for one scheduled day.
export async function openBuilder(container, opts) {
  if (host) closeBuilder()
  ensureCss('css/builders.css?v=__V__')
  gen++
  host = container
  trainingId = opts.id || null
  dayId = opts.dayId || null
  isDayMode = !!dayId
  EXERCISE_TABLE = isDayMode ? 'program_exercises' : 'training_exercises'
  PARENT_FIELD = isDayMode ? 'day_id' : 'training_id'
  parentId = isDayMode ? dayId : trainingId
  liveLink = { dayId: isDayMode ? dayId : null, linked: false }
  resetState()

  host.innerHTML = TEMPLATE
  host.scrollTop = 0
  // The side panels stay in frame while the exercise list scrolls - they
  // take their height from the builder's own visible area (see .tb-host in
  // builders.css), which this keeps current as the window resizes
  hostResizeObserver = new ResizeObserver(() => {
    if (host) host.style.setProperty('--tb-host-h', `${host.clientHeight}px`)
  })
  hostResizeObserver.observe(host)
  bindEvents()

  await Promise.all([loadTraining(), loadExercisesList(), loadAllExercises()])
}

// Sends the edits still waiting on their 800ms autosave. Await this before
// closing so what's shown next (a refreshed calendar, the program grid)
// already includes them.
export function flushBuilder() {
  if (!host) return Promise.resolve()
  return Promise.all(Object.keys(autosaveTimers).map(id => flushCardSave(id)))
}

export function closeBuilder() {
  if (!host) return
  if (onDocClickKebab) document.removeEventListener('click', onDocClickKebab)
  onDocClickKebab = null
  if (hostResizeObserver) hostResizeObserver.disconnect()
  hostResizeObserver = null
  // flushBuilder has normally sent everything already; a debounce left
  // running would fire against cards that are gone
  Object.values(autosaveTimers).forEach(clearTimeout)
  host.innerHTML = ''
  host = null
  trainingDropZone = null
  workoutOutlineList = null
  gen++
  resetState()
}

function resetState() {
  allExercises = []
  activeCategoryFilters = new Set()
  exercisesCache = []
  draggingCards = []
  draggingOutlineItem = null
  extraFieldNamesCache = null
  extraFieldPickerTeId = null
  autosaveTimers = {}
  pickingGroupIds = null
  adjustFieldsTeId = null
  setAlternativeTeId = null
  editingExerciseId = null
  cachedSections = null
  selectedSectionId = null
  selectedSectionName = null
  cachedTrainingsForDay = null
  selectedTrainingIdForDay = null
  selectedTrainingNameForDay = null
}

// ==========================================================================
// ---- ROUTE (Workout Library -> tap a workout) ----
// ==========================================================================
let routeRoot = null

// The route has to be exactly as tall as what's left under the sticky
// header, so the outer page never scrolls and the builder's own sticky side
// panels are what stay in frame. Measured instead of hard-coded: the
// header's height differs by safe-area inset and font scaling, and this has
// to hold on every monitor/window size the coach uses.
function sizeRouteToViewport() {
  if (!routeRoot) return
  const header = document.querySelector('.coach-app-header')
  const headerH = header ? header.offsetHeight : 0
  const route = routeRoot.querySelector('#trainingBuilderRoute')
  if (route) route.style.setProperty('--tb-route-h', `${window.innerHeight - headerH}px`)
}

export async function mount(container, params, ctx) {
  routeRoot = container
  ensureCss('css/builders.css?v=__V__')
  container.innerHTML = ROUTE_TEMPLATE
  container.querySelector('#trainingBuilderRouteBackBtn').addEventListener('click', function() { nav.back() })
  sizeRouteToViewport()
  ctx.on(window, 'resize', sizeRouteToViewport)
  await openBuilder(container.querySelector('#trainingBuilderRouteHost'), { id: params.id })
}

// The router awaits this before leaving (Back button, back gesture,
// sidebar), so an edit typed in the last 800ms is saved first
export async function beforeLeave() {
  await flushBuilder()
}

export function unmount() {
  closeBuilder()
  routeRoot = null
}

// ==========================================================================
// ---- EVENT BINDING ----
// Everything that was a top-level document.getElementById(...).addEventListener
// call in the old training-builder.js lives here now, bound once per
// openBuilder() against the freshly-rendered TEMPLATE. Order is unchanged.
// ==========================================================================
function bindEvents() {
  // Day mode gets a 4th header button, Add Workout - inserting a whole other
  // Workout Library entry's exercises only makes sense onto a scheduled day,
  // not into a training that IS one, so it's hidden outside day mode. The
  // Rename modal is repurposed to edit the day's label instead of a
  // training's name either way (see saveRenameTrainingBtn).
  if (isDayMode) {
    $('renameTrainingBtn').textContent = 'Rename Day'
    $('renameTrainingModalTitle').textContent = 'Rename Day'
    $('addWorkoutToDayBtn').style.display = ''
  }

  $('trainingTypeSelect').addEventListener('change', async function() {
    const { error } = await supabase.from(isDayMode ? 'program_days' : 'trainings').update({ workout_type: this.value }).eq('id', parentId)
    if (error) { console.log(error); customAlert('Something went wrong saving the workout type') }
  })

  $('exerciseCategoryChips').addEventListener('click', function(e) {
    const btn = e.target.closest('.chip-btn')
    if (!btn) return
    const cat = btn.dataset.category
    if (activeCategoryFilters.has(cat)) activeCategoryFilters.delete(cat)
    else activeCategoryFilters.add(cat)
    btn.classList.toggle('selected')
    renderLibraryPanel()
  })

  $('exerciseSearchInput').addEventListener('input', renderLibraryPanel)

  // ---- Drag from the library panel, drop onto the training's exercise list ----
  $('exerciseLibraryList').addEventListener('dragstart', function(e) {
    const card = e.target.closest('.exercise-lib-card')
    if (!card) return
    e.dataTransfer.setData('text/plain', card.dataset.id)
  })

  // ---- Tap-to-add: the "+" on each library card (native HTML5 drag-and-drop,
  // above, never fires from a touch gesture at all - there was previously no
  // way to add an exercise to a workout from a phone). Reuses the exact same
  // addExerciseToTraining() the drop handler calls, so both paths end up
  // identical - same insert, same card render, same outline update. ----
  $('exerciseLibraryList').addEventListener('click', async function(e) {
    const btn = e.target.closest('.exercise-lib-add-btn')
    if (!btn) return
    btn.disabled = true
    await addExerciseToTraining(btn.dataset.id)
    // The card list re-renders on filter/search, not on add, so the button
    // just needs re-enabling here rather than being torn down - a quick
    // checkmark flash confirms the tap actually did something, since there's
    // no drop animation to notice like there is on desktop.
    btn.disabled = false
    btn.textContent = '✓'
    setTimeout(function() { btn.textContent = '+' }, 700)
  })

  // Reordering the outline/card list is still mouse-drag only (see this
  // file's header comment on scope) - touch devices get "Order shown below"
  // instead of a "Drag to reorder" hint that can't actually be acted on.
  if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
    const hint = $('outlineOrderHint')
    if (hint) hint.textContent = 'Order shown below'
  }

  // Mobile-only collapse (see the (max-width:768px) block in builders.css) -
  // desktop's CSS keeps .exercise-library-body visible regardless of this
  // class, so this listener is harmless to leave wired there too.
  $('libraryToggleBtn').addEventListener('click', function() {
    $('exerciseLibraryPanel').classList.toggle('expanded')
  })
  trainingDropZone = $('trainingExercisesList')

  trainingDropZone.addEventListener('dragover', function(e) {
    e.preventDefault()
    if (!draggingCards.length) trainingDropZone.classList.add('drag-over') // a library card, not a reorder
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
  workoutOutlineList = $('workoutOutlineList')

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

  $('extraFieldPickerList').addEventListener('click', function(e) {
    const btn = e.target.closest('.chip-btn')
    if (btn) pickExtraField(btn.dataset.name)
  })

  $('createExtraFieldNameBtn').addEventListener('click', async function() {
    const name = $('newExtraFieldNameInput').value.trim()
    if (!name) return
    const { error } = await supabase.from('extra_field_names').upsert([{ coach_id: coachId(), name }], { onConflict: 'coach_id,name' })
    if (error) { console.log(error); customAlert('Something went wrong saving that field name - try again'); return }
    extraFieldNamesCache = null
    pickExtraField(name)
  })

  $('closeExtraFieldPickerBtn').addEventListener('click', function() {
    $('extraFieldPickerModal').classList.remove('active')
  })

  // Saves every exercise card on the page at once, then stays put and just
  // confirms - the coach app's own Done/Back button is what closes the
  // builder.
  $('saveTrainingBtn').addEventListener('click', async function() {
    const btn = this
    btn.disabled = true
    btn.textContent = 'Saving...'

    const ids = [...host.querySelectorAll('#trainingExercisesList .builder-exercise-card')].map(card => card.dataset.id)
    ids.forEach(id => { clearTimeout(autosaveTimers[id]); delete autosaveTimers[id] })
    const results = await Promise.all(ids.map(saveExerciseCard))

    if (results.some(ok => !ok)) {
      customAlert('Something went wrong saving one or more exercises - please try again')
      btn.disabled = false
      btn.textContent = 'Save'
      return
    }

    // Stays put and confirms - the host's own Done button closes the builder
    await loadExercisesList()
    btn.textContent = 'Saved!'
    setTimeout(function() { btn.disabled = false; btn.textContent = 'Save' }, 1200)
  })

  $('trainingExercisesList').addEventListener('click', async function(e) {
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
      scheduleAutosave(teId)
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
        scheduleAutosave(other.dataset.id)
      }
    } else if (btn.dataset.action === 'remove-set') {
      const row = btn.closest('.set-target-row')
      const setNumber = row.dataset.setNumber
      removeSetTargetRow(row)
      scheduleAutosave(teId)
      for (const other of linkedCardsFor(card)) {
        const otherRow = other.querySelector(`.set-target-row[data-set-number="${setNumber}"]`)
        // Never drop a linked card to zero rows even if counts had somehow
        // already drifted apart - same floor the remove button's own
        // disabled state already enforces for a single card
        if (otherRow && other.querySelectorAll('.set-target-row').length > 1) {
          removeSetTargetRow(otherRow)
          scheduleAutosave(other.dataset.id)
        }
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
      host.querySelectorAll('#trainingExercisesList .kebab-dropdown.active').forEach(d => d.classList.remove('active'))
      if (!wasActive) dropdown.classList.add('active')
    } else if (btn.dataset.action === 'adjust-fields') {
      btn.closest('.kebab-dropdown').classList.remove('active')
      await flushCardSave(teId)
      openAdjustFieldsModal(exercisesCache.find(t => t.id === teId))
    } else if (btn.dataset.action === 'set-alternative') {
      btn.closest('.kebab-dropdown').classList.remove('active')
      await flushCardSave(teId)
      openSetAlternativeModal(exercisesCache.find(t => t.id === teId))
    } else if (btn.dataset.action === 'edit-exercise') {
      btn.closest('.kebab-dropdown').classList.remove('active')
      if (te && te.exercises) openExerciseModal(te.exercises)
    }
  })

  // Kebab dropdowns (see toggle-kebab above) close on their own toggle or on
  // picking an item, but not yet on an outside click - add that here so one
  // left open doesn't linger while the coach works on other cards
  // (removed again in closeBuilder)
  onDocClickKebab = function(e) {
    if (e.target.closest('.builder-kebab-menu')) return
    host.querySelectorAll('#trainingExercisesList .kebab-dropdown.active').forEach(d => d.classList.remove('active'))
  }
  document.addEventListener('click', onDocClickKebab)

  $('closeAdjustFieldsBtn').addEventListener('click', function() {
    $('adjustFieldsModal').classList.remove('active')
  })

  $('cancelAdjustFieldsBtn').addEventListener('click', function() {
    $('adjustFieldsModal').classList.remove('active')
  })

  $('saveAdjustFieldsBtn').addEventListener('click', async function() {
    if (!adjustFieldsTeId) return
    const updates = {
      tracks_weight_override: $('adjustFieldsTracksWeight').checked,
      is_timed_override: $('adjustFieldsIsTimed').checked,
      is_unilateral_override: $('adjustFieldsIsUnilateral').checked,
      tracks_distance_override: $('adjustFieldsTracksDistance').checked
    }
    const { error } = await supabase.from(EXERCISE_TABLE).update(updates).eq('id', adjustFieldsTeId)
    if (error) { console.log(error); customAlert('Something went wrong saving those fields - try again'); return }
    await detachDayIfLive()

    const te = exercisesCache.find(t => t.id === adjustFieldsTeId)
    if (te) {
      Object.assign(te, updates)
      applyFieldOverrides(te)
      const card = host.querySelector(`.builder-exercise-card[data-id="${te.id}"]`)
      if (card) {
        card.outerHTML = renderExerciseCard(te)
        if (te.extra_fields) {
          for (const [k, v] of Object.entries(te.extra_fields)) addExtraFieldRow(`extraFields-${te.id}`, k, v)
        }
      }
    }

    $('adjustFieldsModal').classList.remove('active')
  })

  $('setAlternativeSearchInput').addEventListener('input', renderSetAlternativeList)

  $('setAlternativeList').addEventListener('click', async function(e) {
    const item = e.target.closest('.exercise-lib-card')
    if (item) await saveAlternativeExercise(setAlternativeTeId, item.dataset.id)
  })

  $('removeAlternativeBtn').addEventListener('click', async function() {
    await saveAlternativeExercise(setAlternativeTeId, null)
  })

  $('closeSetAlternativeBtn').addEventListener('click', function() {
    $('setAlternativeModal').classList.remove('active')
  })

  // mm:ss time boxes: strip anything non-digit as it's typed, then pad back
  // to 2 digits (and clamp seconds to 59) once the coach taps away. Selects
  // the "00" on focus so typing a digit replaces it instead of needing a
  // manual delete first
  $('trainingExercisesList').addEventListener('focusin', function(e) {
    if (e.target.matches('.set-time-mm, .set-time-ss')) {
      e.target.select()
    }
  })

  $('trainingExercisesList').addEventListener('input', function(e) {
    if (e.target.matches('.set-time-mm, .set-time-ss')) {
      e.target.value = e.target.value.replace(/\D/g, '').slice(0, 2)
    }
  })

  $('trainingExercisesList').addEventListener('focusout', function(e) {
    if (e.target.matches('.set-time-mm, .set-time-ss')) {
      const max = e.target.classList.contains('set-time-ss') ? 59 : 99
      const val = Math.min(parseInt(e.target.value) || 0, max)
      e.target.value = String(val).padStart(2, '0')
    }
  })

  $('trainingExercisesList').addEventListener('input', function(e) {
    if (!e.target.matches(AUTOSAVE_FIELD_SELECTOR)) return
    const card = e.target.closest('.builder-exercise-card')
    if (card) scheduleAutosave(card.dataset.id)
  })

  $('trainingExercisesList').addEventListener('change', function(e) {
    if (!e.target.matches('.set-type-select')) return
    const card = e.target.closest('.builder-exercise-card')
    if (card) scheduleAutosave(card.dataset.id)
  })

  $('tCreateExerciseCategory').addEventListener('change', toggleCreateNewCategoryField)

  $('tCreateExerciseType').addEventListener('change', function() {
    toggleCreateNewTypeField()
    applyTypeLoggingDefaults(this.value)
  })

  $('openCreateExerciseBtn').addEventListener('click', function() {
    editingExerciseId = null
    $('tCreateExerciseModalTitle').textContent = 'Create New Exercise'
    $('saveTCreateExerciseBtn').style.display = ''
    $('saveTEditExerciseBtn').style.display = 'none'
    $('tCreateExerciseName').value = ''
    $('tCreateExerciseNewCategory').value = ''
    populateCreateCategorySelect()
    $('tCreateExerciseNewType').value = ''
    populateCreateTypeSelect()
    $('tCreateExerciseTracksReps').checked = true
    $('tCreateExerciseTracksWeight').checked = true
    $('tCreateExerciseIsTimed').checked = false
    $('tCreateExerciseIsUnilateral').checked = false
    $('tCreateExerciseTracksDistance').checked = false
    $('tCreateExerciseVideoUrl').value = ''
    $('tCreateExerciseInstructions').value = ''
    $('tCreateExerciseModal').classList.add('active')
  })

  $('cancelTCreateExerciseBtn').addEventListener('click', function() {
    $('tCreateExerciseModal').classList.remove('active')
  })

  $('saveTCreateExerciseBtn').addEventListener('click', async function() {
    const name = $('tCreateExerciseName').value.trim()
    const categorySelect = $('tCreateExerciseCategory').value
    const category = categorySelect === '__new__'
      ? $('tCreateExerciseNewCategory').value.trim()
      : categorySelect
    const typeSelect = $('tCreateExerciseType').value
    const type = typeSelect === '__new__'
      ? $('tCreateExerciseNewType').value.trim() || 'weights'
      : typeSelect
    const videoUrl = $('tCreateExerciseVideoUrl').value.trim()
    const instructions = $('tCreateExerciseInstructions').value.trim()
    const tracksReps = $('tCreateExerciseTracksReps').checked
    const tracksWeight = $('tCreateExerciseTracksWeight').checked
    const isTimed = $('tCreateExerciseIsTimed').checked
    const isUnilateral = $('tCreateExerciseIsUnilateral').checked
    const tracksDistance = $('tCreateExerciseTracksDistance').checked

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
    $('tCreateExerciseModal').classList.remove('active')
    await addExerciseToTraining(data[0].id)
  })

  // Edits the real Exercise Library row in place (name/category/type/logging
  // fields/video/instructions) - every workout card using this exercise,
  // in this training and any other, sees the change immediately since they
  // all just reference the same exercises.id. foot_contacts/intensity_tier
  // (Plyometric-only fields, no UI in this modal) are deliberately left out
  // of the update payload so this never silently clears them.
  $('saveTEditExerciseBtn').addEventListener('click', async function() {
    if (!editingExerciseId) return
    const name = $('tCreateExerciseName').value.trim()
    const categorySelect = $('tCreateExerciseCategory').value
    const category = categorySelect === '__new__'
      ? $('tCreateExerciseNewCategory').value.trim()
      : categorySelect
    const typeSelect = $('tCreateExerciseType').value
    const type = typeSelect === '__new__'
      ? $('tCreateExerciseNewType').value.trim() || 'weights'
      : typeSelect
    const videoUrl = $('tCreateExerciseVideoUrl').value.trim()
    const instructions = $('tCreateExerciseInstructions').value.trim()
    const tracksReps = $('tCreateExerciseTracksReps').checked
    const tracksWeight = $('tCreateExerciseTracksWeight').checked
    const isTimed = $('tCreateExerciseIsTimed').checked
    const isUnilateral = $('tCreateExerciseIsUnilateral').checked
    const tracksDistance = $('tCreateExerciseTracksDistance').checked

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
    for (const te of exercisesCache) {
      if (te.exercises && te.exercises.id === editingExerciseId) Object.assign(te.exercises, updates)
    }

    renderCategoryChips()
    renderLibraryPanel()
    renderExercisesList()
    $('tCreateExerciseModal').classList.remove('active')
  })

  $('addSectionBtn').addEventListener('click', async function() {
    resetSectionPreview()
    const list = $('addSectionList')
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

    $('addSectionModal').classList.add('active')
  })

  $('insertSectionBtn').addEventListener('click', async function() {
    if (!selectedSectionId) return
    await insertSectionIntoTraining(selectedSectionId, selectedSectionName)
  })

  $('closeAddSectionBtn').addEventListener('click', function() {
    $('addSectionModal').classList.remove('active')
  })

  $('addWorkoutToDayBtn').addEventListener('click', async function() {
    resetWorkoutToDayPreview()
    const list = $('addWorkoutToDayList')
    const data = await getTrainingsListForDay()

    if (data === null) {
      list.innerHTML = '<p class="no-metrics">Something went wrong loading the Workout Library</p>'
    } else if (data.length === 0) {
      list.innerHTML = '<p class="no-metrics">No workouts saved yet - create one in the Workout Library first</p>'
    } else {
      list.innerHTML = data.map(t => `
        <div class="training-pick-row" data-id="${t.id}" data-name="${t.name}">
          <span>${t.name}</span>
        </div>
      `).join('')

      list.querySelectorAll('.training-pick-row').forEach(row => {
        row.addEventListener('click', function() {
          list.querySelectorAll('.training-pick-row').forEach(r => r.classList.remove('selected'))
          row.classList.add('selected')
          previewTrainingForDay(row.dataset.id, row.dataset.name)
        })
      })
    }

    $('addWorkoutToDayModal').classList.add('active')
  })

  $('insertWorkoutToDayBtn').addEventListener('click', async function() {
    if (!selectedTrainingIdForDay) return
    await insertTrainingIntoDayMode(selectedTrainingIdForDay, selectedTrainingNameForDay)
  })

  $('closeAddWorkoutToDayBtn').addEventListener('click', function() {
    $('addWorkoutToDayModal').classList.remove('active')
  })

  // ==========================================================================
  // ---- RENAME TRAINING ----
  // ==========================================================================
  $('renameTrainingBtn').addEventListener('click', function() {
    $('renameTrainingInput').value = $('trainingNameHeading').textContent
    $('renameTrainingModal').classList.add('active')
  })

  $('cancelRenameTrainingBtn').addEventListener('click', function() {
    $('renameTrainingModal').classList.remove('active')
  })

  $('saveRenameTrainingBtn').addEventListener('click', async function() {
    const name = $('renameTrainingInput').value.trim()
    if (!isDayMode && !name) { customAlert('Please enter a name'); return }

    // A day's label can be cleared (falls back to "Week X — Day Y", see
    // loadTraining) - a Workout Library training always needs a real name
    const { error } = isDayMode
      ? await supabase.from('program_days').update({ label: name || null }).eq('id', dayId)
      : await supabase.from('trainings').update({ name }).eq('id', trainingId)
    if (error) { console.log(error); customAlert('Something went wrong'); return }

    if (isDayMode && !name) await loadTraining()
    else $('trainingNameHeading').textContent = name
    $('renameTrainingModal').classList.remove('active')
  })
}

let allExercises = []
// Category chips narrow the library alongside the name search (AND) - no
// chip selected shows everything. Categories are freeform per-exercise
// text, not a fixed list, so the chip set is generated from whatever
// values are actually in use (see renderCategoryChips)
let activeCategoryFilters = new Set()
let exercisesCache = [] // last-loaded EXERCISE_TABLE rows for this training/day

// ==========================================================================
// ---- LIVE-LINKED WORKOUTS (day mode only) ----
// True when this day still tracks a Workout Library Training's current
// content - see sync_live_training_days in sql-history.sql, which is what
// actually keeps it in sync at read time; this file only ever detaches.
// Set from loadTraining()'s day-mode branch below. detachDayIfLive() is
// called after every hand-edit write in day mode (add/delete/reorder an
// exercise, Adjust Fields, Set Alternative, Add Section) - it only ever
// fires the actual write once (the first edit after load), since every
// edit after that has already detached.
//
// One object per opened builder (replaced by openBuilder), not a plain
// flag: an autosave can still be finishing after the builder closed, and
// it has to detach the day it was editing - never whatever day the coach
// opened next. saveExerciseCard holds on to its own builder's object.
// ==========================================================================
let liveLink = { dayId: null, linked: false }

async function detachDayIfLive(link = liveLink) {
  if (!link.dayId || !link.linked) return
  link.linked = false
  if (link === liveLink) paintLiveBadge()
  const { error } = await supabase.from('program_days').update({ source_training_id: null, source_training_synced_at: null }).eq('id', link.dayId)
  if (error) console.log('Error detaching live-link:', error)
}

function paintLiveBadge() {
  const badge = $('liveLinkBadge')
  if (badge) badge.style.display = (isDayMode && liveLink.linked) ? '' : 'none'
}

// ==========================================================================
// ---- LOAD HEADING (training name, or the scheduled day's context) ----
// ==========================================================================
async function loadTraining() {
  const myGen = gen
  if (isDayMode) {
    const { data, error } = await fetchWithRetry((signal) => supabase
      .from('program_days')
      .select('*, program_weeks(week_number, programs(name, is_adhoc))')
      .eq('id', dayId)
      .single()
      .abortSignal(signal)
    )

    if (myGen !== gen) return // builder closed or reopened meanwhile
    if (error) {
      console.log('Error loading day:', error)
      $('trainingNameHeading').textContent = 'Day not found'
      customAlert('Something went wrong loading this day - check your connection and try again')
      return
    }

    const week = data.program_weeks
    const program = week && week.programs
    $('trainingNameHeading').textContent = data.label
      || (program && program.is_adhoc ? program.name : null)
      || (week ? `Week ${week.week_number} — Day ${data.day_number}` : `Day ${data.day_number}`)
    $('trainingTypeSelect').value = data.workout_type || 'gym'
    liveLink.linked = !!data.source_training_id
    paintLiveBadge()
    return
  }

  const { data, error } = await fetchWithRetry((signal) => supabase
    .from('trainings')
    .select('*')
    .eq('id', trainingId)
    .single()
    .abortSignal(signal)
  )

  if (myGen !== gen) return
  if (error) {
    console.log('Error loading training:', error)
    $('trainingNameHeading').textContent = 'Workout not found'
    customAlert('Something went wrong loading this workout - check your connection and try again')
    return
  }

  $('trainingNameHeading').textContent = data.name
  $('trainingTypeSelect').value = data.workout_type || 'gym'
}

// ==========================================================================
// ---- EXERCISE LIBRARY PANEL (search + drag source) ----
// ==========================================================================
async function loadAllExercises() {
  const myGen = gen
  const { data, error } = await fetchWithRetry((signal) => supabase.from('exercises').select('*').eq('archived', false).order('name').abortSignal(signal))
  if (myGen !== gen) return
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
  const row = $('exerciseCategoryChips')
  row.innerHTML = categories.map(cat =>
    `<button type="button" class="chip-btn ${activeCategoryFilters.has(cat) ? 'selected' : ''}" data-category="${cat}">${cat}</button>`
  ).join('')
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
  const filter = $('exerciseSearchInput').value.trim().toLowerCase()
  let filtered = filter ? allExercises.filter(ex => ex.name.toLowerCase().includes(filter)) : allExercises
  if (activeCategoryFilters.size) filtered = filtered.filter(ex => activeCategoryFilters.has(ex.category))

  const list = $('exerciseLibraryList')

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
        <button type="button" class="exercise-lib-add-btn" data-id="${ex.id}" aria-label="Add ${ex.name.replace(/"/g, '&quot;')}">+</button>
      </div>
    `
  }).join('')
}

let trainingDropZone = null

// ---- Reorder exercises already in the training by dragging the ⠿ handle ----
// Purely a DOM reorder while dragging (no network call) - the new order is
// only written to order_index when the page's own Save button is pressed,
// same as every other edit on this page. Grabbing any member of a section
// drags the whole section together - see the dataset.sectionInstanceId
// grouping below - since the whole point of a section is that it stays
// together.
let draggingCards = []

// ---- Exercise order outline (right side panel) ----
// Just names, in order - a much quicker drag target than a whole tall
// exercise card. Dragging a row here reorders the outline first, then
// applies that same order to the real cards on the left (syncCardOrder
// below) - so either list can be dragged and they stay in sync. A section
// collapses into one row here ("🧩 Warm-up A (3)") since the whole point
// of a section is that it stays together - dragging that one row moves
// every exercise underneath it as a block.
function renderWorkoutOutline() {
  const panel = $('workoutOutlineList')
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
  host.querySelectorAll('#workoutOutlineList .workout-outline-item').forEach(function(item, i) {
    item.querySelector('.workout-outline-num').textContent = i + 1
  })
}

// Reorders the real exercise cards to match the outline's current order -
// a group row carries every member's id (comma-joined) instead of just one
function syncCardOrderToOutline() {
  host.querySelectorAll('#workoutOutlineList .workout-outline-item').forEach(function(item) {
    const ids = item.dataset.groupIds ? item.dataset.groupIds.split(',') : [item.dataset.id]
    ids.forEach(function(id) {
      const card = trainingDropZone.querySelector(`.builder-exercise-card[data-id="${id}"]`)
      if (card) trainingDropZone.appendChild(card)
    })
  })
}

let draggingOutlineItem = null
let workoutOutlineList = null

// Dropped in with no prescribed values yet - renders immediately as one
// blank, empty set row (see deriveSetTargets) ready to edit right there,
// no separate step needed. Appends just this one new card instead of
// reloading + re-rendering the whole list, so any unsaved edits sitting in
// other cards' rows aren't wiped out by the refresh.
async function addExerciseToTraining(exerciseId) {
  const nextOrder = exercisesCache.length ? Math.max(...exercisesCache.map(te => te.order_index)) + 1 : 0

  const { data, error } = await supabase.from(EXERCISE_TABLE).insert([{
    [PARENT_FIELD]: parentId,
    exercise_id: exerciseId,
    order_index: nextOrder
  }]).select('*, exercises!exercise_id(id, name, category, type, video_url, instructions, tracks_reps, tracks_weight, is_timed, is_unilateral, tracks_distance)')

  if (error) { console.log(error); customAlert('Something went wrong'); return }

  const newRow = data[0]
  exercisesCache.push(newRow)
  await detachDayIfLive()

  const container = $('trainingExercisesList')
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
  const container = $(containerId)
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
  const rows = host.querySelectorAll('#' + containerId + ' .extra-field-row')
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
  const list = $('extraFieldPickerList')
  list.innerHTML = names.length
    ? names.map(n => `<button type="button" class="chip-btn" data-name="${n.name}">${n.name}</button>`).join('')
    : '<p class="no-metrics">No fields created yet - add one below</p>'
  $('newExtraFieldNameInput').value = ''
  $('extraFieldPickerModal').classList.add('active')
}

function pickExtraField(name) {
  if (!extraFieldPickerTeId || !name) return
  const containerId = `extraFields-${extraFieldPickerTeId}`
  if (host.querySelector(`#${containerId} .extra-field-row[data-name="${name}"]`)) {
    $('extraFieldPickerModal').classList.remove('active')
    return // already on this card - avoid a silent duplicate that only the last one would save
  }
  addExtraFieldRow(containerId, name, '')
  $('extraFieldPickerModal').classList.remove('active')
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

async function loadExercisesList() {
  const myGen = gen
  const { data, error } = await fetchWithRetry((signal) => supabase
    .from(EXERCISE_TABLE)
    .select('*, exercises!exercise_id(id, name, category, type, video_url, instructions, tracks_reps, tracks_weight, is_timed, is_unilateral, tracks_distance)')
    .eq(PARENT_FIELD, parentId)
    .abortSignal(signal)
  )

  if (myGen !== gen) return
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
  const container = $('trainingExercisesList')

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
        <textarea class="exercise-notes-input" placeholder="e.g. Focus on controlled tempo">${te.notes || ''}</textarea>
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
  const card = host?.querySelector(`.builder-exercise-card[data-id="${teId}"]`)
  if (!card) return true
  const link = liveLink // this builder's day, even if it closes before the save returns

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

  const updates = {
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
  }

  const { error } = await supabase.from(EXERCISE_TABLE).update(updates).eq('id', teId)

  if (error) { console.log(error); return false }
  await detachDayIfLive(link)
  // Keeps exercisesCache in sync with what's actually saved, so any action
  // that re-renders a card from cache (Adjust Fields, Set Alternative,
  // Adjust Exercise) reflects what was just typed instead of overwriting it
  // with stale pre-edit data - see scheduleAutosave/flushCardSave below.
  if (te) Object.assign(te, updates)
  return true
}

// ==========================================================================
// ---- AUTOSAVE ----
// Every set/notes/extra-field edit and superset link/unlink used to only
// persist when the coach pressed the page's one big Save button - meaning
// any of the kebab actions below (which redraw a card straight from
// exercisesCache) would silently wipe out whatever was typed but not yet
// saved. Now every edit gets written to the database on its own, a moment
// after the coach stops typing (same "it just stays, unless you change it
// yourself" reliability the athlete's own logging screen already has) -
// the big Save button still exists for the final "I'm done" navigation,
// but nothing is ever actually waiting on it anymore.
// ==========================================================================
let autosaveTimers = {}

function scheduleAutosave(teId) {
  clearTimeout(autosaveTimers[teId])
  autosaveTimers[teId] = setTimeout(() => flushCardSave(teId), 800)
}

async function flushCardSave(teId) {
  clearTimeout(autosaveTimers[teId])
  delete autosaveTimers[teId]
  if (!host) return true
  const ids = [...host.querySelectorAll('#trainingExercisesList .builder-exercise-card')].map(c => c.dataset.id)
  const orderIndex = ids.indexOf(teId)
  if (orderIndex === -1) return true
  return saveExerciseCard(teId, orderIndex)
}

// Flushes every card at once - used right before an action rebuilds the
// WHOLE list from exercisesCache (Adjust Exercise, inserting a section),
// so nothing mid-edit on any other card gets lost in that rebuild.
async function flushAllPendingSaves() {
  const ids = [...host.querySelectorAll('#trainingExercisesList .builder-exercise-card')].map(c => c.dataset.id)
  await Promise.all(ids.map((id, i) => { clearTimeout(autosaveTimers[id]); delete autosaveTimers[id]; return saveExerciseCard(id, i) }))
}

// Removes just this one card instead of reloading + re-rendering the whole
// list, so any unsaved edits sitting in other cards' rows aren't wiped out
async function deleteExerciseRow(id) {
  if (!(await customConfirm('Remove this exercise from the workout?'))) return

  clearTimeout(autosaveTimers[id])
  delete autosaveTimers[id]
  const card = host.querySelector(`.builder-exercise-card[data-id="${id}"]`)
  if (card && card.dataset.supersetGroupId) removeFromSupersetGroup(id, trainingDropZone)

  const { error } = await supabase.from(EXERCISE_TABLE).delete().eq('id', id)
  if (error) { console.log(error); customAlert('Something went wrong'); return }
  await detachDayIfLive()

  exercisesCache = exercisesCache.filter(te => te.id !== id)
  if (card) card.remove()
  if (exercisesCache.length === 0) {
    $('trainingExercisesList').innerHTML = '<p class="no-metrics">No exercises yet — drag one in from the library on the left</p>'
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
  const bar = $('pickingModeBar')
  if (!bar) return
  if (!pickingGroupIds) { bar.style.display = 'none'; return }
  bar.style.display = 'flex'
  const n = pickingGroupIds.length
  $('pickingModeBarCount').textContent = `${n} exercise${n === 1 ? '' : 's'} selected`
  const finishBtn = $('pickingModeBarFinishBtn')
  finishBtn.disabled = n < 2
  finishBtn.onclick = () => finalizePicking(listScopeEl)
  $('pickingModeBarCancelBtn').onclick = () => exitPickingMode(listScopeEl)
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
  $('adjustFieldsExerciseName').textContent = te.exercises ? te.exercises.name : ''
  $('adjustFieldsTracksWeight').checked = !te.exercises || !!te.exercises.tracks_weight
  $('adjustFieldsIsTimed').checked = !!(te.exercises && te.exercises.is_timed)
  $('adjustFieldsIsUnilateral').checked = !!(te.exercises && te.exercises.is_unilateral)
  $('adjustFieldsTracksDistance').checked = !!(te.exercises && te.exercises.tracks_distance)
  $('adjustFieldsModal').classList.add('active')
}

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
  $('setAlternativeExerciseName').textContent = te.exercises ? `For: ${te.exercises.name}` : ''
  $('setAlternativeSearchInput').value = ''
  const removeBtn = $('removeAlternativeBtn')
  removeBtn.style.display = te.alternative_exercise_id ? '' : 'none'
  renderSetAlternativeList()
  $('setAlternativeModal').classList.add('active')
}

function renderSetAlternativeList() {
  const filter = $('setAlternativeSearchInput').value.trim().toLowerCase()
  const te = exercisesCache.find(t => t.id === setAlternativeTeId)
  const ownExerciseId = te ? te.exercise_id : null
  const filtered = (filter ? allExercises.filter(ex => ex.name.toLowerCase().includes(filter)) : allExercises)
    .filter(ex => ex.id !== ownExerciseId)

  const list = $('setAlternativeList')
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

async function saveAlternativeExercise(teId, altExerciseId) {
  if (!teId) return
  const { error } = await supabase.from(EXERCISE_TABLE).update({ alternative_exercise_id: altExerciseId }).eq('id', teId)
  if (error) { console.log(error); customAlert('Something went wrong saving that - try again'); return }
  await detachDayIfLive()

  const te = exercisesCache.find(t => t.id === teId)
  if (te) {
    te.alternative_exercise_id = altExerciseId
    const card = host.querySelector(`.builder-exercise-card[data-id="${te.id}"]`)
    if (card) {
      card.outerHTML = renderExerciseCard(te)
      if (te.extra_fields) {
        for (const [k, v] of Object.entries(te.extra_fields)) addExtraFieldRow(`extraFields-${te.id}`, k, v)
      }
    }
  }

  $('setAlternativeModal').classList.remove('active')
}

// Any set field, note, or extra-field value - autosave the owning card a
// moment after the coach stops typing (see scheduleAutosave above)
const AUTOSAVE_FIELD_SELECTOR = '.set-reps-input, .set-weight-input, .set-distance-input, .set-time-mm, .set-time-ss, .exercise-notes-input, .extra-field-value'

// ==========================================================================
// ---- CREATE NEW EXERCISE ----
// Opened from the Exercise Library panel. Saving adds it to both the
// searchable library and straight onto the training (it was made
// specifically to use here, no need for a separate drag step).
// ==========================================================================
const BUILT_IN_TYPES = { weights: 'Weightlifting (sets, reps, weight)', timed: 'Timed (sets, duration)', plyometric: 'Plyometric (sets, foot contacts, intensity)' }

function populateCreateCategorySelect() {
  const select = $('tCreateExerciseCategory')
  const categories = [...new Set(allExercises.map(ex => ex.category).filter(c => c && c.trim()))].sort()
  select.innerHTML = '<option value="">Choose Category</option>' +
    categories.map(c => `<option value="${c}">${c}</option>`).join('') +
    '<option value="__new__">+ Add New Category</option>'
  select.value = ''
  toggleCreateNewCategoryField()
}

function toggleCreateNewCategoryField() {
  const isNew = $('tCreateExerciseCategory').value === '__new__'
  $('tCreateExerciseNewCategoryGroup').style.display = isNew ? 'block' : 'none'
}

function populateCreateTypeSelect() {
  const select = $('tCreateExerciseType')
  const customTypes = [...new Set(allExercises.map(ex => ex.type).filter(t => t && !(t in BUILT_IN_TYPES)))].sort()
  select.innerHTML =
    Object.entries(BUILT_IN_TYPES).map(([value, label]) => `<option value="${value}">${label}</option>`).join('') +
    customTypes.map(t => `<option value="${t}">${t}</option>`).join('') +
    '<option value="__new__">+ Add New Type</option>'
  select.value = 'weights'
  toggleCreateNewTypeField()
}

function toggleCreateNewTypeField() {
  const isNew = $('tCreateExerciseType').value === '__new__'
  $('tCreateExerciseNewTypeGroup').style.display = isNew ? 'block' : 'none'
}

// Nudges the logging-field toggles to their common defaults when the coach
// actually picks a type - the coach can still flip either toggle back
// afterward for a less common combination (e.g. a weighted timed hold)
function applyTypeLoggingDefaults(type) {
  if (type === 'timed') {
    $('tCreateExerciseTracksReps').checked = false
    $('tCreateExerciseIsTimed').checked = true
    $('tCreateExerciseTracksWeight').checked = false
  } else if (type === 'weights') {
    $('tCreateExerciseTracksReps').checked = true
    $('tCreateExerciseIsTimed').checked = false
    $('tCreateExerciseTracksWeight').checked = true
  }
}

// null while creating a brand new exercise; the exercise's id while
// "Adjust Exercise" (a workout card's kebab menu) is editing an existing
// one in place - both share this one modal, just with different
// title/button and a different save handler (see openExerciseModal below
// and the two save button handlers)
let editingExerciseId = null

// Opened from a workout card's kebab "Adjust Exercise" - same modal as
// creating one, prefilled with the exercise's current real values (this
// edits the actual Exercise Library row, not just this one workout's
// instance of it - see openAdjustFieldsModal for the per-instance version).
function openExerciseModal(exercise) {
  editingExerciseId = exercise.id
  $('tCreateExerciseModalTitle').textContent = 'Adjust Exercise'
  $('saveTCreateExerciseBtn').style.display = 'none'
  $('saveTEditExerciseBtn').style.display = ''
  $('tCreateExerciseName').value = exercise.name || ''
  $('tCreateExerciseNewCategory').value = ''
  populateCreateCategorySelect()
  $('tCreateExerciseCategory').value = exercise.category || ''
  $('tCreateExerciseNewType').value = ''
  populateCreateTypeSelect()
  $('tCreateExerciseType').value = exercise.type || 'weights'
  toggleCreateNewCategoryField()
  toggleCreateNewTypeField()
  $('tCreateExerciseTracksReps').checked = exercise.tracks_reps !== false
  $('tCreateExerciseTracksWeight').checked = !!exercise.tracks_weight
  $('tCreateExerciseIsTimed').checked = !!exercise.is_timed
  $('tCreateExerciseIsUnilateral').checked = !!exercise.is_unilateral
  $('tCreateExerciseTracksDistance').checked = !!exercise.tracks_distance
  $('tCreateExerciseVideoUrl').value = exercise.video_url || ''
  $('tCreateExerciseInstructions').value = exercise.instructions || ''
  $('tCreateExerciseModal').classList.add('active')
}

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
  $('addSectionPreview').innerHTML = '<p class="no-metrics">Select a section to preview it</p>'
  $('insertSectionBtn').disabled = true
}

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
  $('insertSectionBtn').disabled = false

  const preview = $('addSectionPreview')
  preview.innerHTML = '<p class="no-metrics">Loading...</p>'

  const { data, error } = await supabase
    .from('section_exercises')
    .select('*, exercises!exercise_id(id, name, video_url)')
    .eq('section_id', sectionId)

  if (error) { console.log(error); preview.innerHTML = '<p class="no-metrics">Something went wrong loading this section</p>'; return }

  data.sort((a, b) => a.order_index - b.order_index)
  preview.innerHTML = data.length === 0
    ? '<p class="no-metrics">No exercises in this section</p>'
    : data.map(renderSectionPreviewExercise).join('')
}

async function insertSectionIntoTraining(sectionId, sectionName) {
  // copy_exercises (see shared/copy-exercises.js) gives the copied rows
  // fresh superset ids and one shared section instance id - what keeps the
  // section together as a single block in the drag-reorder UI - so
  // inserting the same section twice never merges the two copies
  const baseOrder = exercisesCache.length ? Math.max(...exercisesCache.map(te => te.order_index)) + 1 : 0
  const { data: inserted, error: insertError } = await copyExercises(supabase, {
    from: 'section', fromId: sectionId, to: isDayMode ? 'day' : 'training', toId: parentId,
    baseOrder, sectionLabel: sectionName,
    select: '*, exercises!exercise_id(id, name, category, type, video_url, instructions, tracks_reps, tracks_weight, is_timed, is_unilateral, tracks_distance)'
  })
  if (insertError) { console.log(insertError); customAlert('Something went wrong copying the exercises'); return }
  if (inserted.length === 0) { $('addSectionModal').classList.remove('active'); return }

  exercisesCache.push(...inserted)
  await flushAllPendingSaves()
  renderExercisesList()
  $('addSectionModal').classList.remove('active')
}

// ==========================================================================
// ---- ADD WORKOUT (day mode only) - bulk-copy a whole Workout Library
// entry's exercises onto this day, same list-then-preview pattern as Add
// Section above, just sourced from trainings/training_exercises instead of
// sections/section_exercises.
// ==========================================================================
let cachedTrainingsForDay = null
let selectedTrainingIdForDay = null
let selectedTrainingNameForDay = null

async function getTrainingsListForDay() {
  if (cachedTrainingsForDay) return cachedTrainingsForDay
  const { data, error } = await fetchWithRetry((signal) => supabase.from('trainings').select('*').order('name').abortSignal(signal))
  if (error) { console.log(error); customAlert('Something went wrong loading your Workout Library - check your connection and try again'); return null }
  cachedTrainingsForDay = data
  return cachedTrainingsForDay
}

function resetWorkoutToDayPreview() {
  selectedTrainingIdForDay = null
  selectedTrainingNameForDay = null
  $('addWorkoutToDayPreview').innerHTML = '<p class="no-metrics">Select a workout to preview it</p>'
  $('insertWorkoutToDayBtn').disabled = true
}

async function previewTrainingForDay(trainingIdForDay, name) {
  selectedTrainingIdForDay = trainingIdForDay
  selectedTrainingNameForDay = name
  $('insertWorkoutToDayBtn').disabled = false

  const preview = $('addWorkoutToDayPreview')
  preview.innerHTML = '<p class="no-metrics">Loading...</p>'

  const { data, error } = await supabase
    .from('training_exercises')
    .select('*, exercises!exercise_id(id, name, video_url)')
    .eq('training_id', trainingIdForDay)

  if (error) { console.log(error); preview.innerHTML = '<p class="no-metrics">Something went wrong loading this workout</p>'; return }

  data.sort((a, b) => a.order_index - b.order_index)
  preview.innerHTML = data.length === 0
    ? '<p class="no-metrics">No exercises in this workout</p>'
    : data.map(renderSectionPreviewExercise).join('')
}

async function insertTrainingIntoDayMode(trainingIdForDay, trainingName) {
  // Only when this Workout lands on a day that was completely empty does it
  // start tracking that Training live - see the LIVE-LINKED WORKOUTS block
  // above. Landing on a day with something already on it detaches instead
  // (handled below, via flushAllPendingSaves -> saveExerciseCard ->
  // detachDayIfLive on whatever pre-existing cards get flushed).
  const dayWasEmpty = exercisesCache.length === 0
  const baseOrder = exercisesCache.length ? Math.max(...exercisesCache.map(te => te.order_index)) + 1 : 0

  const { data: inserted, error: insertError } = await copyExercises(supabase, {
    from: 'training', fromId: trainingIdForDay, to: 'day', toId: parentId, baseOrder,
    select: '*, exercises!exercise_id(id, name, category, type, video_url, instructions, tracks_reps, tracks_weight, is_timed, is_unilateral, tracks_distance)'
  })
  if (insertError) { console.log(insertError); customAlert('Something went wrong copying the exercises'); return }
  if (inserted.length === 0) { $('addWorkoutToDayModal').classList.remove('active'); return }

  exercisesCache.push(...inserted)
  await flushAllPendingSaves()

  if (dayWasEmpty) {
    liveLink.linked = true
    const { error: linkError } = await supabase.from('program_days').update({ source_training_id: trainingIdForDay, source_training_synced_at: null }).eq('id', dayId)
    if (linkError) console.log('Error setting live-link:', linkError)
    paintLiveBadge()
  }

  renderExercisesList()
  $('addWorkoutToDayModal').classList.remove('active')
}