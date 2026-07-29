// ==========================================================================
// EXERCISE LIBRARY
// Coach-owned, reusable list of exercises (name/category/instructions) used
// when building program templates and ad-hoc calendar trainings. RLS scopes
// every query/write to the logged-in coach automatically - no coach_id
// filter needed on selects, but inserts must set coach_id explicitly.
// ==========================================================================
import { supabase } from './coachClient.js'

let currentExercise = null // exercise being edited, or null when adding new

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

  renderExercises(data)
}

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
      <h3 class="category-title">${cat}</h3>
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
            ${ex.instructions ? `<p class="exercise-instructions">${ex.instructions}</p>` : ''}
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

  container.querySelectorAll('.btn-delete-metric').forEach(btn => {
    btn.addEventListener('click', function() {
      deleteExercise(btn.dataset.id)
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
  document.getElementById('exerciseCategory').value = exercise ? (exercise.category || '') : ''
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
  const category = document.getElementById('exerciseCategory').value.trim()
  const instructions = document.getElementById('exerciseInstructions').value.trim()

  if (!name) { alert('Please enter a name'); return }

  let error
  if (currentExercise) {
    ({ error } = await supabase
      .from('exercises')
      .update({ name, category, instructions })
      .eq('id', currentExercise.id))
  } else {
    ({ error } = await supabase
      .from('exercises')
      .insert([{ coach_id: session.user.id, name, category, instructions }]))
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
