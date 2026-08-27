// ==========================================================================
// EXERCISE LIBRARY
// Coach-owned, reusable list of exercises (name/category/instructions) used
// when building program templates and ad-hoc calendar trainings. RLS scopes
// every query/write to the logged-in coach automatically - no coach_id
// filter needed on selects, but inserts must set coach_id explicitly.
// ==========================================================================
import { supabase } from './coachClient.js'

let currentExercise = null // exercise being edited, or null when adding new
let allExercisesCache = [] // used to build the "existing categories" dropdown
// Search + category-chip filtering, same pattern as the builders' exercise
// library panel - no chip selected shows everything, one or more narrows
// it (OR between chips, AND with the search box)
let activeCategoryFilters = new Set()

const { data: { session } } = await supabase.auth.getSession()
if (!session) {
  window.location.href = 'login.html'
} else {
  loadExercises()
}

// ==========================================================================
// ---- LOAD + RENDER ----
// ==========================================================================
async function loadExercises() {
  const { data, error } = await fetchWithRetry((signal) => supabase
    .from('exercises')
    .select('*')
    .order('name')
    .abortSignal(signal)
  )

  if (error) {
    console.log('Error loading exercises:', error)
    customAlert('Something went wrong loading your exercises - check your connection and try again')
    return
  }

  allExercisesCache = data
  document.getElementById('exerciseTotalCount').textContent = `(${data.length})`
  renderCategoryChips()
  applyLibraryFilters()
}

// Rebuilds the chip row from whatever Category values are actually present
// right now - same technique populateCategorySelect already uses to fill
// the category dropdown in the Add/Edit Exercise modal
function renderCategoryChips() {
  const categories = [...new Set(allExercisesCache.map(ex => ex.category).filter(c => c && c.trim()))].sort()
  const row = document.getElementById('exerciseCategoryChips')
  row.innerHTML = categories.map(cat =>
    `<button type="button" class="chip-btn ${activeCategoryFilters.has(cat) ? 'selected' : ''}" data-category="${cat}">${cat}</button>`
  ).join('')
}

function applyLibraryFilters() {
  const search = document.getElementById('exerciseSearchInput').value.trim().toLowerCase()
  let filtered = search ? allExercisesCache.filter(ex => ex.name.toLowerCase().includes(search)) : allExercisesCache
  if (activeCategoryFilters.size) filtered = filtered.filter(ex => activeCategoryFilters.has((ex.category || '').trim()))
  renderExercises(filtered)
}

document.getElementById('exerciseSearchInput').addEventListener('input', applyLibraryFilters)

document.getElementById('exerciseCategoryChips').addEventListener('click', function(e) {
  const btn = e.target.closest('.chip-btn')
  if (!btn) return
  const cat = btn.dataset.category
  if (activeCategoryFilters.has(cat)) activeCategoryFilters.delete(cat)
  else activeCategoryFilters.add(cat)
  btn.classList.toggle('selected')
  applyLibraryFilters()
})

// Distinct, already-used categories - populates the "Category" dropdown so
// picking one is a click instead of retyping the same word every time
function populateCategorySelect(selectedCategory) {
  const select = document.getElementById('exerciseCategory')
  const categories = [...new Set(allExercisesCache.map(ex => ex.category).filter(c => c && c.trim()))].sort()

  select.innerHTML = '<option value="">Choose Category</option>' +
    categories.map(c => `<option value="${c}">${c}</option>`).join('') +
    '<option value="__new__">+ Add New Category</option>'

  // Default to the neutral placeholder - not "+ Add New Category" - so the
  // new-category text field doesn't show up until the coach actually picks
  // that option
  select.value = (selectedCategory && categories.includes(selectedCategory)) ? selectedCategory : ''

  toggleNewCategoryField()
}

function toggleNewCategoryField() {
  const isNew = document.getElementById('exerciseCategory').value === '__new__'
  document.getElementById('exerciseNewCategoryGroup').style.display = isNew ? 'block' : 'none'
}

document.getElementById('exerciseCategory').addEventListener('change', toggleNewCategoryField)

// Type dropdown: always offers the built-in types, plus any custom type a
// coach has already made up, plus "+ Add New Type" - same extensible
// pattern as Category
const BUILT_IN_TYPES = { weights: 'Weightlifting (sets, reps, weight)', timed: 'Timed (sets, duration)', plyometric: 'Plyometric (sets, foot contacts, intensity)' }

function populateTypeSelect(selectedType) {
  const select = document.getElementById('exerciseType')
  const customTypes = [...new Set(allExercisesCache.map(ex => ex.type).filter(t => t && !(t in BUILT_IN_TYPES)))].sort()

  select.innerHTML =
    Object.entries(BUILT_IN_TYPES).map(([value, label]) => `<option value="${value}">${label}</option>`).join('') +
    customTypes.map(t => `<option value="${t}">${t}</option>`).join('') +
    '<option value="__new__">+ Add New Type</option>'

  if (selectedType && (selectedType in BUILT_IN_TYPES || customTypes.includes(selectedType))) {
    select.value = selectedType
  } else {
    select.value = 'weights'
  }

  toggleNewTypeField()
}

function toggleNewTypeField() {
  const type = document.getElementById('exerciseType').value
  document.getElementById('exerciseNewTypeGroup').style.display = type === '__new__' ? 'block' : 'none'
  document.getElementById('exercisePlyoFields').style.display = type === 'plyometric' ? 'block' : 'none'
}

// Nudges the logging-field toggles to their common defaults when the coach
// actually picks a type - only wired to the change event below, never
// called when the modal is just being opened/populated (populateTypeSelect
// calls toggleNewTypeField directly, not this), so it never silently
// overwrites an exercise's real saved values (e.g. a deliberately weighted
// timed hold). The coach can still flip either toggle back afterward.
function applyTypeLoggingDefaults(type) {
  if (type === 'timed') {
    document.getElementById('exerciseIsTimed').checked = true
    document.getElementById('exerciseTracksWeight').checked = false
  } else if (type === 'weights') {
    document.getElementById('exerciseIsTimed').checked = false
    document.getElementById('exerciseTracksWeight').checked = true
  }
}

document.getElementById('exerciseType').addEventListener('change', function() {
  toggleNewTypeField()
  applyTypeLoggingDefaults(this.value)
})

// YouTube's thumbnail images are available at a predictable URL from just
// the video id, no API key needed - other hosts (Vimeo etc.) fall back to
// a placeholder icon. Same helper as training-builder.js's library panel.
function getYouTubeThumbnail(url) {
  if (!url) return null
  const match = url.match(/(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/)
  return match ? `https://img.youtube.com/vi/${match[1]}/mqdefault.jpg` : null
}

function renderExercises(exercises) {
  const container = document.getElementById('exerciseList')

  if (exercises.length === 0) {
    container.innerHTML = allExercisesCache.length === 0
      ? '<p class="no-metrics">No exercises yet — add your first one!</p>'
      : '<p class="no-metrics">No exercises match your search/filter</p>'
    return
  }

  // Group by category (blank/null category becomes "Uncategorized"),
  // categories sorted alphabetically with Uncategorized always last
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
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px">
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
            <p class="exercise-instructions" style="color:#4a4a8e; margin-bottom:4px">${BUILT_IN_TYPES[ex.type] ? BUILT_IN_TYPES[ex.type].split(' (')[0] : (ex.type || 'Weightlifting')}</p>
            ${ex.instructions ? `<p class="exercise-instructions">${ex.instructions}</p>` : ''}
          </div>
        `
        }).join('')}
      </div>
    </div>
  `).join('')

  // Click the title to edit - the pencil icon is gone, editing is now just
  // "click the exercise"
  container.querySelectorAll('.exercise-item-title').forEach(title => {
    title.addEventListener('click', function() {
      const exercise = exercises.find(e => e.id === title.dataset.id)
      openExerciseModal(exercise)
    })
  })

  // Kebab (⋮) button toggles that card's delete dropdown open/closed
  container.querySelectorAll('.exercise-item .kebab-btn').forEach(btn => {
    btn.addEventListener('click', function(e) {
      e.stopPropagation()
      document.getElementById(`exercise-dropdown-${btn.dataset.id}`).classList.toggle('active')
    })
  })

  container.querySelectorAll('.exercise-item .kebab-delete').forEach(btn => {
    btn.addEventListener('click', function(e) {
      e.stopPropagation()
      deleteExercise(btn.dataset.id)
    })
  })

  // Category kebab (⋮) button toggles that category's dropdown open/closed
  container.querySelectorAll('.kebab-btn[data-index]').forEach(btn => {
    btn.addEventListener('click', function(e) {
      e.stopPropagation()
      document.getElementById(`category-dropdown-${btn.dataset.index}`).classList.toggle('active')
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
// ---- ADD / EDIT MODAL ----
// ==========================================================================
function openExerciseModal(exercise) {
  currentExercise = exercise || null

  document.getElementById('exerciseModalTitle').textContent = exercise ? 'Edit Exercise' : 'Add Exercise'
  document.getElementById('exerciseName').value = exercise ? exercise.name : ''
  document.getElementById('exerciseNewCategory').value = ''
  populateCategorySelect(exercise ? exercise.category : null)
  document.getElementById('exerciseNewType').value = ''
  populateTypeSelect(exercise ? exercise.type : null)
  document.getElementById('exerciseFootContacts').value = exercise ? (exercise.foot_contacts ?? '') : ''
  document.getElementById('exerciseIntensityTier').value = (exercise && exercise.intensity_tier) || 'low'
  // Independent of Type - defaults for a brand-new exercise match the old
  // 'weights' behavior (weight tracked, not timed, not unilateral)
  document.getElementById('exerciseTracksWeight').checked = exercise ? !!exercise.tracks_weight : true
  document.getElementById('exerciseIsTimed').checked = exercise ? !!exercise.is_timed : false
  document.getElementById('exerciseIsUnilateral').checked = exercise ? !!exercise.is_unilateral : false
  document.getElementById('exerciseTracksDistance').checked = exercise ? !!exercise.tracks_distance : false
  document.getElementById('exerciseVideoUrl').value = exercise ? (exercise.video_url || '') : ''
  document.getElementById('exerciseInstructions').value = exercise ? (exercise.instructions || '') : ''

  document.getElementById('exerciseModal').classList.add('active')
}

document.getElementById('addExerciseBtn').addEventListener('click', function() {
  openExerciseModal(null)
})

document.getElementById('closeExerciseModalBtn').addEventListener('click', function() {
  document.getElementById('exerciseModal').classList.remove('active')
})

document.getElementById('cancelExerciseBtn').addEventListener('click', function() {
  document.getElementById('exerciseModal').classList.remove('active')
})

document.getElementById('saveExerciseBtn').addEventListener('click', async function() {
  const name = document.getElementById('exerciseName').value.trim()
  const categorySelect = document.getElementById('exerciseCategory').value
  const category = categorySelect === '__new__'
    ? document.getElementById('exerciseNewCategory').value.trim()
    : categorySelect
  const typeSelect = document.getElementById('exerciseType').value
  const type = typeSelect === '__new__'
    ? document.getElementById('exerciseNewType').value.trim() || 'weights'
    : typeSelect
  const videoUrl = document.getElementById('exerciseVideoUrl').value.trim()
  const instructions = document.getElementById('exerciseInstructions').value.trim()
  // Only kept when the exercise is actually plyometric - switching a type
  // away from plyometric clears these instead of leaving stale values
  // sitting behind a hidden field
  const isPlyo = type === 'plyometric'
  const footContacts = isPlyo ? (parseInt(document.getElementById('exerciseFootContacts').value) || null) : null
  const intensityTier = isPlyo ? document.getElementById('exerciseIntensityTier').value : null
  // Independent of Type - any combination is valid (e.g. a weighted timed hold)
  const tracksWeight = document.getElementById('exerciseTracksWeight').checked
  const isTimed = document.getElementById('exerciseIsTimed').checked
  const isUnilateral = document.getElementById('exerciseIsUnilateral').checked
  const tracksDistance = document.getElementById('exerciseTracksDistance').checked

  if (!name) { customAlert('Please enter a name'); return }

  let error
  if (currentExercise) {
    ({ error } = await supabase
      .from('exercises')
      .update({ name, category, type, video_url: videoUrl, instructions, foot_contacts: footContacts, intensity_tier: intensityTier, tracks_weight: tracksWeight, is_timed: isTimed, is_unilateral: isUnilateral, tracks_distance: tracksDistance })
      .eq('id', currentExercise.id))
  } else {
    ({ error } = await supabase
      .from('exercises')
      .insert([{ coach_id: session.user.id, name, category, type, video_url: videoUrl, instructions, foot_contacts: footContacts, intensity_tier: intensityTier, tracks_weight: tracksWeight, is_timed: isTimed, is_unilateral: isUnilateral, tracks_distance: tracksDistance }]))
  }

  if (error) { console.log(error); customAlert('Something went wrong'); return }

  document.getElementById('exerciseModal').classList.remove('active')
  loadExercises()
})

// ==========================================================================
// ---- DELETE ----
// exercise_id on program_exercises has no cascade, so deleting an exercise
// that's used in a program fails with Postgres error 23503 (foreign key
// violation) - caught below and shown as a friendly message instead of the
// generic "Something went wrong"
// ==========================================================================
async function deleteExercise(id) {
  if (!(await customConfirm('Delete this exercise?'))) return

  const { error } = await supabase
    .from('exercises')
    .delete()
    .eq('id', id)

  if (error) {
    console.log(error)
    if (error.code === '23503') {
      customAlert("This exercise is used in one or more programs and can't be deleted. Remove it from those programs first.")
    } else {
      customAlert('Something went wrong')
    }
    return
  }

  loadExercises()
}

// ==========================================================================
// ---- DELETE CATEGORY ----
// Categories aren't their own table - they're just whatever string value
// exercises.category happens to hold. "Deleting" one clears it (back to
// blank/Uncategorized) on every exercise currently using it, which is what
// makes it disappear from the category dropdown going forward.
// ==========================================================================
async function deleteCategory(categoryName, exercises) {
  const count = exercises.filter(ex => (ex.category || '').trim() === categoryName).length

  if (!(await customConfirm(`Remove the "${categoryName}" category from ${count} exercise${count === 1 ? '' : 's'}? They'll become Uncategorized - this doesn't delete the exercises themselves.`))) return

  const { error } = await supabase
    .from('exercises')
    .update({ category: null })
    .eq('category', categoryName)

  if (error) { console.log(error); customAlert('Something went wrong'); return }

  loadExercises()
}
