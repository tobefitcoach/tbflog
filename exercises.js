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

const { data: { session } } = await supabase.auth.getSession()
if (!session) {
  window.location.href = 'login.html'
} else {
  loadExercises()
}

document.getElementById('logoutBtn').addEventListener('click', async function() {
  await supabase.auth.signOut()
  window.location.href = 'login.html'
})

// ==========================================================================
// ---- LOAD + RENDER ----
// ==========================================================================
async function loadExercises() {
  const { data, error } = await supabase
    .from('exercises')
    .select('*')
    .order('name')

  if (error) {
    console.log('Error loading exercises:', error)
    return
  }

  allExercisesCache = data
  renderExercises(data)
}

// Distinct, already-used categories - populates the "Category" dropdown so
// picking one is a click instead of retyping the same word every time
function populateCategorySelect(selectedCategory) {
  const select = document.getElementById('exerciseCategory')
  const categories = [...new Set(allExercisesCache.map(ex => ex.category).filter(c => c && c.trim()))].sort()

  select.innerHTML = categories.map(c => `<option value="${c}">${c}</option>`).join('') +
    '<option value="__new__">+ Add New Category</option>'

  if (selectedCategory && categories.includes(selectedCategory)) {
    select.value = selectedCategory
  } else {
    select.value = '__new__'
  }

  toggleNewCategoryField()
}

function toggleNewCategoryField() {
  const isNew = document.getElementById('exerciseCategory').value === '__new__'
  document.getElementById('exerciseNewCategoryGroup').style.display = isNew ? 'block' : 'none'
}

document.getElementById('exerciseCategory').addEventListener('change', toggleNewCategoryField)

// Type dropdown: always offers the two built-in types, plus any custom
// type a coach has already made up, plus "+ Add New Type" - same
// extensible pattern as Category
const BUILT_IN_TYPES = { weights: 'Weightlifting (sets, reps, weight)', timed: 'Timed (sets, duration)' }

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
  const isNew = document.getElementById('exerciseType').value === '__new__'
  document.getElementById('exerciseNewTypeGroup').style.display = isNew ? 'block' : 'none'
}

document.getElementById('exerciseType').addEventListener('change', toggleNewTypeField)

function renderExercises(exercises) {
  const container = document.getElementById('exerciseList')

  if (exercises.length === 0) {
    container.innerHTML = '<p class="no-metrics">No exercises yet — add your first one!</p>'
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

  container.innerHTML = categoryNames.map(cat => `
    <div class="metric-category">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px">
        <h3 class="category-title" style="margin-bottom:0">${cat}</h3>
        ${cat === 'Uncategorized' ? '' : `<button class="btn-delete-metric btn-delete-category" data-category="${cat}">🗑 Delete Category</button>`}
      </div>
      <div class="exercise-grid">
        ${byCategory[cat].map(ex => `
          <div class="exercise-item">
            <div class="metric-item-header">
              <h4>${ex.name}</h4>
              <div style="display:flex; gap:8px">
                <button class="btn-edit-entry" data-id="${ex.id}">✏</button>
                <button class="btn-delete-metric" data-id="${ex.id}">🗑</button>
              </div>
            </div>
            <p class="exercise-instructions" style="color:#4a4a8e; margin-bottom:4px">${BUILT_IN_TYPES[ex.type] ? BUILT_IN_TYPES[ex.type].split(' (')[0] : (ex.type || 'Weightlifting')}</p>
            ${ex.instructions ? `<p class="exercise-instructions">${ex.instructions}</p>` : ''}
            ${ex.video_url ? `<p class="exercise-instructions"><a href="${ex.video_url}" target="_blank" style="color:#4a4a8e">🎥 Watch video</a></p>` : ''}
          </div>
        `).join('')}
      </div>
    </div>
  `).join('')

  container.querySelectorAll('.btn-edit-entry').forEach(btn => {
    btn.addEventListener('click', function() {
      const exercise = exercises.find(e => e.id === btn.dataset.id)
      openExerciseModal(exercise)
    })
  })

  container.querySelectorAll('.exercise-item .btn-delete-metric').forEach(btn => {
    btn.addEventListener('click', function() {
      deleteExercise(btn.dataset.id)
    })
  })

  container.querySelectorAll('.btn-delete-category').forEach(btn => {
    btn.addEventListener('click', function() {
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

  if (!name) { alert('Please enter a name'); return }

  let error
  if (currentExercise) {
    ({ error } = await supabase
      .from('exercises')
      .update({ name, category, type, video_url: videoUrl, instructions })
      .eq('id', currentExercise.id))
  } else {
    ({ error } = await supabase
      .from('exercises')
      .insert([{ coach_id: session.user.id, name, category, type, video_url: videoUrl, instructions }]))
  }

  if (error) { console.log(error); alert('Something went wrong'); return }

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
  if (!confirm('Delete this exercise?')) return

  const { error } = await supabase
    .from('exercises')
    .delete()
    .eq('id', id)

  if (error) {
    console.log(error)
    if (error.code === '23503') {
      alert("This exercise is used in one or more programs and can't be deleted. Remove it from those programs first.")
    } else {
      alert('Something went wrong')
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

  if (!confirm(`Remove the "${categoryName}" category from ${count} exercise${count === 1 ? '' : 's'}? They'll become Uncategorized - this doesn't delete the exercises themselves.`)) return

  const { error } = await supabase
    .from('exercises')
    .update({ category: null })
    .eq('category', categoryName)

  if (error) { console.log(error); alert('Something went wrong'); return }

  loadExercises()
}
