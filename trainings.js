// ==========================================================================
// TRAINING LIBRARY
// Lists the coach's reusable single-day trainings (trainings + nested
// training_exercises). Mirrors programs.js's list-page pattern, just for
// the flat "trainings" table instead of the multi-week "programs" table.
// ==========================================================================
import { supabase } from './coachClient.js'

const { data: { session } } = await supabase.auth.getSession()
if (!session) {
  window.location.href = 'login.html'
} else {
  loadTrainings()
}

// ==========================================================================
// ---- LOAD TRAININGS ----
// ==========================================================================
async function loadTrainings() {
  const grid = document.getElementById('trainingGrid')
  grid.innerHTML = ''

  const { data, error } = await fetchWithRetry((signal) => supabase
    .from('trainings')
    .select('*, training_exercises(id)')
    .order('name')
    .abortSignal(signal)
  )

  if (error) {
    console.log('Error loading trainings:', error)
    customAlert('Something went wrong loading your workouts - check your connection and try again')
    return
  }

  if (data.length === 0) {
    grid.innerHTML = '<p>No workouts yet — create your first one!</p>'
    return
  }

  data.forEach(createTrainingCard)
}

function createTrainingCard(training) {
  const exerciseCount = training.training_exercises.length

  const card = document.createElement('div')
  card.classList.add('athlete-card')
  card.innerHTML = `
    <div class="card-top">
      <div class="athlete-initials"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="4" cy="12" r="2"></circle><circle cx="20" cy="12" r="2"></circle><line x1="6" y1="12" x2="18" y2="12"></line><line x1="9" y1="8" x2="9" y2="16"></line><line x1="15" y1="8" x2="15" y2="16"></line></svg></div>
      <div class="kebab-menu">
        <button class="kebab-btn" data-id="${training.id}">⋮</button>
        <div class="kebab-dropdown" id="dropdown-${training.id}">
          <button class="kebab-delete" data-id="${training.id}">Delete workout</button>
        </div>
      </div>
    </div>
    <h3>${training.name}</h3>
    <p>${exerciseCount} exercise${exerciseCount === 1 ? '' : 's'}</p>
  `

  card.addEventListener('click', function(e) {
    if (e.target.classList.contains('kebab-btn') ||
        e.target.classList.contains('kebab-delete')) return
    window.location.href = `training-builder.html?id=${training.id}`
  })

  card.querySelector('.kebab-btn').addEventListener('click', function(e) {
    e.stopPropagation()
    document.getElementById(`dropdown-${training.id}`).classList.toggle('active')
  })

  card.querySelector('.kebab-delete').addEventListener('click', async function(e) {
    e.stopPropagation()
    if (!(await customConfirm(`Delete "${training.name}"? This cannot be undone.`))) return

    const { error } = await supabase
      .from('trainings')
      .delete()
      .eq('id', training.id)

    if (error) {
      console.log('Error deleting training:', error)
      customAlert('Something went wrong')
      return
    }

    loadTrainings()
  })

  document.getElementById('trainingGrid').appendChild(card)
}

// ==========================================================================
// ---- NEW TRAINING MODAL ----
// ==========================================================================
document.getElementById('newTrainingBtn').addEventListener('click', function() {
  document.getElementById('newTrainingName').value = ''
  document.getElementById('newTrainingModal').classList.add('active')
})

document.getElementById('cancelNewTrainingBtn').addEventListener('click', function() {
  document.getElementById('newTrainingModal').classList.remove('active')
})

document.getElementById('saveNewTrainingBtn').addEventListener('click', async function() {
  const name = document.getElementById('newTrainingName').value.trim()
  if (!name) { customAlert('Please enter a name'); return }

  const { data, error } = await supabase
    .from('trainings')
    .insert([{ coach_id: session.user.id, name }])
    .select()

  if (error) {
    console.log('Error creating training:', error)
    customAlert('Something went wrong')
    return
  }

  window.location.href = `training-builder.html?id=${data[0].id}`
})
