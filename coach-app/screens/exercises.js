// ==========================================================================
// EXERCISE LIBRARY — screen
// Converted from the repo-root exercises.js + the .dashboard block of
// exercises.html. Coach-owned, reusable list of exercises used when
// building programs and ad-hoc calendar trainings. RLS scopes every
// query/write to the logged-in coach automatically - no coach_id filter
// needed on selects, but inserts must set coach_id explicitly.
//
// Note: unlike the other library screens, this one never had a
// document-level "click outside closes the kebab dropdown" listener. That
// inconsistency is carried over as-is rather than quietly changed - it's a
// behaviour difference worth fixing deliberately, not as a side effect of
// a structural conversion.
// ==========================================================================
import { supabase } from '../../coachClient.js'
import * as nav from '../nav.js'
import { coachId } from '../session.js'

const BUILT_IN_TYPES = {
  weights: 'Weightlifting (sets, reps, weight)',
  timed: 'Timed (sets, duration)',
  plyometric: 'Plyometric (sets, foot contacts, intensity)',
}

const TEMPLATE = `
  <div class="dashboard-header">
    <h2>Exercise Library <span class="count-badge" id="exerciseTotalCount"></span></h2>
    <button class="btn-add" id="addExerciseBtn">+ Add Exercise</button>
  </div>
  <input type="text" id="exerciseSearchInput" class="exercise-search-input" placeholder="Search exercises..." style="margin-bottom:10px" />
  <div class="chip-row" id="exerciseCategoryChips" style="margin-bottom:16px"></div>
  <div id="exerciseList"></div>

  <!-- Add/Edit Exercise Modal - same modal serves both, driven by
       currentExercise below -->
  <div class="modal-overlay" id="exerciseModal">
    <div class="modal">
      <div class="graph-modal-header">
        <h2 id="exerciseModalTitle">Add Exercise</h2>
        <button class="btn-cancel" id="closeExerciseModalBtn" data-modal-dismiss>✕</button>
      </div>
      <div class="form-group">
        <label>Name</label>
        <input type="text" id="exerciseName" placeholder="e.g. Barbell Back Squat" />
      </div>
      <div class="form-group">
        <label>Category</label>
        <select id="exerciseCategory">
          <option value="__new__">+ Add New Category</option>
        </select>
      </div>
      <div class="form-group" id="exerciseNewCategoryGroup" style="display:none">
        <label>New Category Name</label>
        <input type="text" id="exerciseNewCategory" placeholder="e.g. Legs, Push, Cardio" />
      </div>
      <div class="form-group">
        <label>Type</label>
        <select id="exerciseType">
          <option value="weights">Weightlifting (sets, reps, weight)</option>
          <option value="timed">Timed (sets, duration)</option>
          <option value="plyometric">Plyometric (sets, foot contacts, intensity)</option>
          <option value="__new__">+ Add New Type</option>
        </select>
      </div>
      <div class="form-group" id="exerciseNewTypeGroup" style="display:none">
        <label>New Type Name</label>
        <input type="text" id="exerciseNewType" placeholder="e.g. Sprints" />
      </div>
      <div id="exercisePlyoFields" style="display:none">
        <div class="form-group">
          <label>Foot Contacts (per set)</label>
          <input type="number" id="exerciseFootContacts" min="0" placeholder="e.g. 20" />
        </div>
        <div class="form-group">
          <label>Intensity</label>
          <select id="exerciseIntensityTier">
            <option value="low">Low (×1)</option>
            <option value="moderate">Moderate (×1.5)</option>
            <option value="high">High (×2)</option>
          </select>
        </div>
      </div>
      <div class="form-group">
        <label>Logging Fields</label>
        <p class="form-group-hint">What to track when this exercise is logged - independent of Type above, so any combination works (e.g. reps AND a hold time, or a weighted timed hold).</p>
        <label class="bodyweight-toggle" style="margin-bottom:8px"><span>Track Reps</span>
          <span class="toggle-switch"><input type="checkbox" id="exerciseTracksReps" checked><span class="toggle-slider"></span></span>
        </label>
        <label class="bodyweight-toggle" style="margin-bottom:8px"><span>Track Weight (kg)</span>
          <span class="toggle-switch"><input type="checkbox" id="exerciseTracksWeight" checked><span class="toggle-slider"></span></span>
        </label>
        <label class="bodyweight-toggle" style="margin-bottom:8px"><span>Timed</span>
          <span class="toggle-switch"><input type="checkbox" id="exerciseIsTimed"><span class="toggle-slider"></span></span>
        </label>
        <label class="bodyweight-toggle" style="margin-bottom:8px"><span>Log Each Side (unilateral)</span>
          <span class="toggle-switch"><input type="checkbox" id="exerciseIsUnilateral"><span class="toggle-slider"></span></span>
        </label>
        <label class="bodyweight-toggle"><span>Track Distance (meters)</span>
          <span class="toggle-switch"><input type="checkbox" id="exerciseTracksDistance"><span class="toggle-slider"></span></span>
        </label>
      </div>
      <div class="form-group">
        <label>Video Link (optional)</label>
        <input type="url" id="exerciseVideoUrl" placeholder="https://youtube.com/..." />
      </div>
      <div class="form-group">
        <label>Instructions (optional)</label>
        <textarea id="exerciseInstructions" class="notes-textarea" placeholder="Cues, setup notes, form reminders..."></textarea>
      </div>
      <div class="form-actions">
        <button class="btn-cancel" id="cancelExerciseBtn">Cancel</button>
        <button class="btn-save" id="saveExerciseBtn">Save</button>
      </div>
    </div>
  </div>
`

const SKELETON = `
  <div class="dashboard-header"><h2>Exercise Library</h2></div>
  <div class="skeleton-bar" style="height:38px; margin-bottom:16px"></div>
  ${'<div class="skeleton-bar" style="height:96px; margin-bottom:12px"></div>'.repeat(5)}
`

let root = null
let currentExercise = null   // exercise being edited, or null when adding new
let allExercisesCache = []   // also used to build the category/type dropdowns
let activeCategoryFilters = new Set()

export async function mount(container, params, token) {
  root = container
  container.innerHTML = SKELETON
  if (!(await loadExercises(token))) return

  container.innerHTML = TEMPLATE
  bindEvents()
  paint()
}

export function unmount() {
  root = null
  currentExercise = null
  allExercisesCache = []
  activeCategoryFilters = new Set()
}

// Returns false if the screen should stop (error, or navigated away mid-load).
async function loadExercises(token) {
  const { data, error } = await window.fetchWithRetry((signal) => supabase
    .from('exercises')
    .select('*')
    .eq('archived', false)
    .order('name')
    .abortSignal(signal)
  )
  if (token !== undefined && !nav.isCurrent(token)) return false

  if (error) {
    console.log('Error loading exercises:', error)
    if (root) root.innerHTML = `
      <div class="screen-message">
        <h2>Couldn't load your exercises</h2>
        <p>Check your connection and try again.</p>
      </div>`
    return false
  }

  allExercisesCache = data || []
  return true
}

// Reload from the server and repaint - used after every write.
async function reloadAndRepaint() {
  if (!(await loadExercises())) return
  if (!root) return
  paint()
}

function paint() {
  root.querySelector('#exerciseTotalCount').textContent = `(${allExercisesCache.length})`
  renderCategoryChips()
  applyLibraryFilters()
}

function bindEvents() {
  root.querySelector('#exerciseSearchInput').addEventListener('input', applyLibraryFilters)

  root.querySelector('#exerciseCategoryChips').addEventListener('click', function(e) {
    const btn = e.target.closest('.chip-btn')
    if (!btn) return
    const cat = btn.dataset.category
    if (activeCategoryFilters.has(cat)) activeCategoryFilters.delete(cat)
    else activeCategoryFilters.add(cat)
    btn.classList.toggle('selected')
    applyLibraryFilters()
  })

  root.querySelector('#exerciseCategory').addEventListener('change', toggleNewCategoryField)

  root.querySelector('#exerciseType').addEventListener('change', function() {
    toggleNewTypeField()
    applyTypeLoggingDefaults(this.value)
  })

  root.querySelector('#addExerciseBtn').addEventListener('click', function() {
    openExerciseModal(null)
  })

  root.querySelector('#closeExerciseModalBtn').addEventListener('click', closeExerciseModal)
  root.querySelector('#cancelExerciseBtn').addEventListener('click', closeExerciseModal)
  root.querySelector('#saveExerciseBtn').addEventListener('click', onSaveExercise)
}

function closeExerciseModal() {
  root.querySelector('#exerciseModal').classList.remove('active')
}

// Rebuilds the chip row from whatever Category values are actually present
// right now - same technique populateCategorySelect uses for the dropdown.
function renderCategoryChips() {
  const categories = [...new Set(allExercisesCache.map(ex => ex.category).filter(c => c && c.trim()))].sort()
  root.querySelector('#exerciseCategoryChips').innerHTML = categories.map(cat =>
    `<button type="button" class="chip-btn ${activeCategoryFilters.has(cat) ? 'selected' : ''}" data-category="${cat}">${cat}</button>`
  ).join('')
}

function applyLibraryFilters() {
  const search = root.querySelector('#exerciseSearchInput').value.trim().toLowerCase()
  let filtered = search ? allExercisesCache.filter(ex => ex.name.toLowerCase().includes(search)) : allExercisesCache
  if (activeCategoryFilters.size) filtered = filtered.filter(ex => activeCategoryFilters.has((ex.category || '').trim()))
  renderExercises(filtered)
}

// Distinct, already-used categories - populates the "Category" dropdown so
// picking one is a click instead of retyping the same word every time.
function populateCategorySelect(selectedCategory) {
  const select = root.querySelector('#exerciseCategory')
  const categories = [...new Set(allExercisesCache.map(ex => ex.category).filter(c => c && c.trim()))].sort()

  select.innerHTML = '<option value="">Choose Category</option>' +
    categories.map(c => `<option value="${c}">${c}</option>`).join('') +
    '<option value="__new__">+ Add New Category</option>'

  // Default to the neutral placeholder - not "+ Add New Category" - so the
  // new-category text field doesn't show up until the coach picks it.
  select.value = (selectedCategory && categories.includes(selectedCategory)) ? selectedCategory : ''
  toggleNewCategoryField()
}

function toggleNewCategoryField() {
  const isNew = root.querySelector('#exerciseCategory').value === '__new__'
  root.querySelector('#exerciseNewCategoryGroup').style.display = isNew ? 'block' : 'none'
}

// Always offers the built-in types, plus any custom type a coach has
// already made up, plus "+ Add New Type" - same extensible pattern as
// Category.
function populateTypeSelect(selectedType) {
  const select = root.querySelector('#exerciseType')
  const customTypes = [...new Set(allExercisesCache.map(ex => ex.type).filter(t => t && !(t in BUILT_IN_TYPES)))].sort()

  select.innerHTML =
    Object.entries(BUILT_IN_TYPES).map(([value, label]) => `<option value="${value}">${label}</option>`).join('') +
    customTypes.map(t => `<option value="${t}">${t}</option>`).join('') +
    '<option value="__new__">+ Add New Type</option>'

  select.value = (selectedType && (selectedType in BUILT_IN_TYPES || customTypes.includes(selectedType)))
    ? selectedType
    : 'weights'

  toggleNewTypeField()
}

function toggleNewTypeField() {
  const type = root.querySelector('#exerciseType').value
  root.querySelector('#exerciseNewTypeGroup').style.display = type === '__new__' ? 'block' : 'none'
  root.querySelector('#exercisePlyoFields').style.display = type === 'plyometric' ? 'block' : 'none'
}

// Nudges the logging-field toggles to their common defaults when the coach
// actually picks a type - only wired to the change event, never called when
// the modal is just being opened/populated (populateTypeSelect calls
// toggleNewTypeField directly, not this), so it never silently overwrites
// an exercise's real saved values (e.g. a deliberately weighted timed
// hold). The coach can still flip either toggle back afterward.
function applyTypeLoggingDefaults(type) {
  if (type === 'timed') {
    root.querySelector('#exerciseTracksReps').checked = false
    root.querySelector('#exerciseIsTimed').checked = true
    root.querySelector('#exerciseTracksWeight').checked = false
  } else if (type === 'weights') {
    root.querySelector('#exerciseTracksReps').checked = true
    root.querySelector('#exerciseIsTimed').checked = false
    root.querySelector('#exerciseTracksWeight').checked = true
  }
}

// YouTube thumbnails are available at a predictable URL from just the video
// id, no API key needed - other hosts fall back to a placeholder icon.
function getYouTubeThumbnail(url) {
  if (!url) return null
  const match = url.match(/(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/)
  return match ? `https://img.youtube.com/vi/${match[1]}/mqdefault.jpg` : null
}

function renderExercises(exercises) {
  const container = root.querySelector('#exerciseList')

  if (exercises.length === 0) {
    container.innerHTML = allExercisesCache.length === 0
      ? '<p class="no-metrics">No exercises yet — add your first one!</p>'
      : '<p class="no-metrics">No exercises match your search/filter</p>'
    return
  }

  // Group by category (blank/null becomes "Uncategorized"), categories
  // sorted alphabetically with Uncategorized always last.
  const byCategory = {}
  for (const ex of exercises) {
    const cat = ex.category && ex.category.trim() ? ex.category.trim() : 'Uncategorized'
    if (!byCategory[cat]) byCategory[cat] = []
    byCategory[cat].push(ex)
  }
  const categoryNames = Object.keys(byCategory).sort((a, b) => {
    if (a === 'Uncategorized') return 1
    if (b === 'Uncategorized') return -1
    return a.localeCompare(b)
  })

  container.innerHTML = categoryNames.map((cat, i) => `
    <div class="metric-category">
      <div class="category-header-row">
        <h3 class="category-title" style="margin-bottom:0">${cat} <span class="count-badge">(${byCategory[cat].length})</span></h3>
        ${cat === 'Uncategorized' ? '' : `
          <div class="kebab-menu">
            <button class="kebab-btn" data-index="${i}">⋮</button>
            <div class="kebab-dropdown" id="category-dropdown-${i}">
              <button class="kebab-delete btn-delete-category" data-category="${cat}">Delete Category</button>
            </div>
          </div>
        `}
      </div>
      <div class="exercise-grid">
        ${byCategory[cat].map(ex => {
          const thumb = getYouTubeThumbnail(ex.video_url)
          const thumbInner = thumb
            ? `<img src="${thumb}" alt="" loading="lazy">`
            : '<span class="exercise-item-thumb-placeholder"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="4" cy="12" r="2"></circle><circle cx="20" cy="12" r="2"></circle><line x1="6" y1="12" x2="18" y2="12"></line><line x1="9" y1="8" x2="9" y2="16"></line><line x1="15" y1="8" x2="15" y2="16"></line></svg></span>'

          return `
          <div class="exercise-item">
            ${ex.video_url
              ? `<a href="${ex.video_url}" target="_blank" class="exercise-item-thumb">${thumbInner}</a>`
              : `<div class="exercise-item-thumb">${thumbInner}</div>`}
            <div class="card-top">
              <h4 class="exercise-item-title" data-id="${ex.id}">${ex.name}</h4>
              <div class="kebab-menu">
                <button class="kebab-btn" data-id="${ex.id}">⋮</button>
                <div class="kebab-dropdown" id="exercise-dropdown-${ex.id}">
                  <button class="kebab-delete" data-id="${ex.id}">Delete exercise</button>
                </div>
              </div>
            </div>
            <p class="exercise-instructions exercise-type-line">${BUILT_IN_TYPES[ex.type] ? BUILT_IN_TYPES[ex.type].split(' (')[0] : (ex.type || 'Weightlifting')}</p>
            ${ex.instructions ? `<p class="exercise-instructions">${ex.instructions}</p>` : ''}
          </div>
        `
        }).join('')}
      </div>
    </div>
  `).join('')

  // Click the title to edit - editing is just "click the exercise".
  container.querySelectorAll('.exercise-item-title').forEach(title => {
    title.addEventListener('click', function() {
      openExerciseModal(exercises.find(e => e.id === title.dataset.id))
    })
  })

  container.querySelectorAll('.exercise-item .kebab-btn').forEach(btn => {
    btn.addEventListener('click', function(e) {
      e.stopPropagation()
      container.querySelector(`#exercise-dropdown-${btn.dataset.id}`).classList.toggle('active')
    })
  })

  container.querySelectorAll('.exercise-item .kebab-delete').forEach(btn => {
    btn.addEventListener('click', function(e) {
      e.stopPropagation()
      deleteExercise(btn.dataset.id)
    })
  })

  container.querySelectorAll('.kebab-btn[data-index]').forEach(btn => {
    btn.addEventListener('click', function(e) {
      e.stopPropagation()
      container.querySelector(`#category-dropdown-${btn.dataset.index}`).classList.toggle('active')
    })
  })

  container.querySelectorAll('.btn-delete-category').forEach(btn => {
    btn.addEventListener('click', function(e) {
      e.stopPropagation()
      deleteCategory(btn.dataset.category, exercises)
    })
  })
}

// ==========================================================================
// ADD / EDIT
// ==========================================================================
function openExerciseModal(exercise) {
  currentExercise = exercise || null
  const q = sel => root.querySelector(sel)

  q('#exerciseModalTitle').textContent = exercise ? 'Edit Exercise' : 'Add Exercise'
  q('#exerciseName').value = exercise ? exercise.name : ''
  q('#exerciseNewCategory').value = ''
  populateCategorySelect(exercise ? exercise.category : null)
  q('#exerciseNewType').value = ''
  populateTypeSelect(exercise ? exercise.type : null)
  q('#exerciseFootContacts').value = exercise ? (exercise.foot_contacts ?? '') : ''
  q('#exerciseIntensityTier').value = (exercise && exercise.intensity_tier) || 'low'
  // Independent of Type - defaults for a brand-new exercise match the old
  // 'weights' behaviour (reps + weight tracked, not timed, not unilateral).
  q('#exerciseTracksReps').checked = exercise ? exercise.tracks_reps !== false : true
  q('#exerciseTracksWeight').checked = exercise ? !!exercise.tracks_weight : true
  q('#exerciseIsTimed').checked = exercise ? !!exercise.is_timed : false
  q('#exerciseIsUnilateral').checked = exercise ? !!exercise.is_unilateral : false
  q('#exerciseTracksDistance').checked = exercise ? !!exercise.tracks_distance : false
  q('#exerciseVideoUrl').value = exercise ? (exercise.video_url || '') : ''
  q('#exerciseInstructions').value = exercise ? (exercise.instructions || '') : ''

  q('#exerciseModal').classList.add('active')
}

async function onSaveExercise() {
  const q = sel => root.querySelector(sel)
  const name = q('#exerciseName').value.trim()
  const categorySelect = q('#exerciseCategory').value
  const category = categorySelect === '__new__' ? q('#exerciseNewCategory').value.trim() : categorySelect
  const typeSelect = q('#exerciseType').value
  const type = typeSelect === '__new__' ? (q('#exerciseNewType').value.trim() || 'weights') : typeSelect
  const videoUrl = q('#exerciseVideoUrl').value.trim()
  const instructions = q('#exerciseInstructions').value.trim()
  // Only kept when the exercise is actually plyometric - switching a type
  // away from plyometric clears these instead of leaving stale values
  // sitting behind a hidden field.
  const isPlyo = type === 'plyometric'
  const footContacts = isPlyo ? (parseInt(q('#exerciseFootContacts').value) || null) : null
  const intensityTier = isPlyo ? q('#exerciseIntensityTier').value : null

  if (!name) { customAlert('Please enter a name'); return }

  const fields = {
    name, category, type, video_url: videoUrl, instructions,
    foot_contacts: footContacts, intensity_tier: intensityTier,
    tracks_reps: q('#exerciseTracksReps').checked,
    tracks_weight: q('#exerciseTracksWeight').checked,
    is_timed: q('#exerciseIsTimed').checked,
    is_unilateral: q('#exerciseIsUnilateral').checked,
    tracks_distance: q('#exerciseTracksDistance').checked,
  }

  const { error } = currentExercise
    ? await supabase.from('exercises').update(fields).eq('id', currentExercise.id)
    : await supabase.from('exercises').insert([{ coach_id: coachId(), ...fields }])

  if (error) { console.log(error); customAlert('Something went wrong'); return }

  closeExerciseModal()
  await reloadAndRepaint()
}

// ==========================================================================
// DELETE
// Never a hard delete of the exercises row itself (archived instead) - a
// scheduled instance that already has logged sets keeps referencing this
// row for its history to display correctly, so the row has to keep
// existing. What DOES get removed outright: template rows (the Workout and
// Section libraries have no "done" concept) and scheduled rows with zero
// logged sets (nothing to lose - the athlete never touched it). Archived
// exercises are filtered out of the Library and every "add exercise"
// picker, which is functionally the same as being deleted.
// ==========================================================================
async function deleteExercise(id) {
  const [
    { count: trainingCount, error: trainingErr },
    { count: sectionCount, error: sectionErr },
    { data: scheduledRows, error: scheduledErr }
  ] = await Promise.all([
    supabase.from('training_exercises').select('id', { count: 'exact', head: true }).eq('exercise_id', id),
    supabase.from('section_exercises').select('id', { count: 'exact', head: true }).eq('exercise_id', id),
    supabase.from('program_exercises').select('id, exercise_log_sets(id)').eq('exercise_id', id)
  ])
  if (trainingErr || sectionErr || scheduledErr) {
    console.log(trainingErr || sectionErr || scheduledErr)
    customAlert('Something went wrong')
    return
  }

  const scheduledWithLogs = scheduledRows.filter(pe => pe.exercise_log_sets && pe.exercise_log_sets.length > 0)
  const scheduledWithoutLogs = scheduledRows.filter(pe => !pe.exercise_log_sets || pe.exercise_log_sets.length === 0)
  const templateCount = (trainingCount || 0) + (sectionCount || 0)

  let message = 'Delete this exercise?'
  if (templateCount > 0 || scheduledWithoutLogs.length > 0 || scheduledWithLogs.length > 0) {
    const usedParts = []
    if (templateCount > 0) usedParts.push(`${templateCount} template${templateCount === 1 ? '' : 's'}`)
    if (scheduledWithoutLogs.length > 0) usedParts.push(`${scheduledWithoutLogs.length} upcoming workout${scheduledWithoutLogs.length === 1 ? '' : 's'}`)
    message = usedParts.length
      ? `This exercise is used in ${usedParts.join(' and ')} - it'll be removed from ${usedParts.length === 1 ? 'there' : 'those'} too.${scheduledWithLogs.length ? ' It\'ll stay in athlete history for anything already logged.' : ''} Delete it?`
      : `This exercise has logged history with one or more athletes - it'll stay in their history, but won't be usable for new workouts anymore. Delete it?`
  }
  if (!(await customConfirm(message))) return

  if (trainingCount > 0) {
    const { error } = await supabase.from('training_exercises').delete().eq('exercise_id', id)
    if (error) { console.log(error); customAlert('Something went wrong'); return }
  }
  if (sectionCount > 0) {
    const { error } = await supabase.from('section_exercises').delete().eq('exercise_id', id)
    if (error) { console.log(error); customAlert('Something went wrong'); return }
  }
  if (scheduledWithoutLogs.length > 0) {
    const { error } = await supabase.from('program_exercises').delete().in('id', scheduledWithoutLogs.map(pe => pe.id))
    if (error) { console.log(error); customAlert('Something went wrong'); return }
  }

  const { error } = await supabase.from('exercises').update({ archived: true }).eq('id', id)
  if (error) { console.log(error); customAlert('Something went wrong'); return }

  await reloadAndRepaint()
}

// Categories aren't their own table - they're just whatever string value
// exercises.category happens to hold. "Deleting" one clears it (back to
// blank/Uncategorized) on every exercise currently using it, which is what
// makes it disappear from the dropdown going forward.
async function deleteCategory(categoryName, exercises) {
  const count = exercises.filter(ex => (ex.category || '').trim() === categoryName).length

  if (!(await customConfirm(`Remove the "${categoryName}" category from ${count} exercise${count === 1 ? '' : 's'}? They'll become Uncategorized - this doesn't delete the exercises themselves.`))) return

  const { error } = await supabase.from('exercises').update({ category: null }).eq('category', categoryName)
  if (error) { console.log(error); customAlert('Something went wrong'); return }

  activeCategoryFilters.delete(categoryName)
  await reloadAndRepaint()
}
