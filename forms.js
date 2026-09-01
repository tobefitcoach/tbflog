// ==========================================================================
// FORMS LIBRARY
// Lists the coach's reusable form templates (forms + nested form_questions).
// Same list-page pattern as trainings.js, just for the "forms" table
// instead of "trainings" - no labels here, that can be added later if
// forms end up needing the same filtering trainings does.
// ==========================================================================
import { supabase } from './coachClient.js'

const { data: { session } } = await supabase.auth.getSession()
if (!session) {
  window.location.href = 'login.html'
} else {
  loadForms()
}

let allForms = []

async function loadForms() {
  const { data, error } = await fetchWithRetry((signal) => supabase.from('forms').select('*, form_questions(id)').order('name').abortSignal(signal))

  if (error) {
    console.log('Error loading forms:', error)
    customAlert('Something went wrong loading your forms - check your connection and try again')
    return
  }

  allForms = data
  renderFormGrid()
}

function renderFormGrid() {
  const grid = document.getElementById('formGrid')
  grid.innerHTML = ''

  if (allForms.length === 0) {
    grid.innerHTML = '<p>No forms yet — create your first one!</p>'
    return
  }

  allForms.forEach(createFormCard)
}

function createFormCard(form) {
  const questionCount = form.form_questions.length

  const card = document.createElement('div')
  card.classList.add('athlete-card')
  card.innerHTML = `
    <div class="card-top">
      <div class="athlete-initials"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"></path><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path></svg></div>
      <div class="kebab-menu">
        <button class="kebab-btn" data-id="${form.id}">⋮</button>
        <div class="kebab-dropdown" id="dropdown-${form.id}">
          <button class="kebab-delete" data-id="${form.id}">Delete form</button>
        </div>
      </div>
    </div>
    <h3>${form.name}</h3>
    <p>${questionCount} question${questionCount === 1 ? '' : 's'}</p>
    ${form.gate_workout ? '<span class="workout-type-badge workout-type-badge-run">Gates that day\'s workout</span>' : ''}
  `

  card.addEventListener('click', function(e) {
    if (e.target.closest('.kebab-menu')) return
    window.location.href = `form-builder.html?id=${form.id}`
  })

  card.querySelector('.kebab-btn').addEventListener('click', function(e) {
    e.stopPropagation()
    document.getElementById(`dropdown-${form.id}`).classList.toggle('active')
  })

  card.querySelector('.kebab-delete').addEventListener('click', async function(e) {
    e.stopPropagation()
    if (!(await customConfirm(`Delete "${form.name}"? This cannot be undone.`))) return

    const { error } = await supabase.from('forms').delete().eq('id', form.id)
    if (error) {
      console.log('Error deleting form:', error)
      customAlert('Something went wrong')
      return
    }

    loadForms()
  })

  document.getElementById('formGrid').appendChild(card)
}

document.addEventListener('click', function() {
  document.querySelectorAll('#formGrid .kebab-dropdown.active').forEach(d => d.classList.remove('active'))
})

// ==========================================================================
// ---- NEW FORM MODAL ----
// ==========================================================================
document.getElementById('newFormBtn').addEventListener('click', function() {
  document.getElementById('newFormName').value = ''
  document.getElementById('newFormModal').classList.add('active')
})

document.getElementById('cancelNewFormBtn').addEventListener('click', function() {
  document.getElementById('newFormModal').classList.remove('active')
})

document.getElementById('saveNewFormBtn').addEventListener('click', async function() {
  const name = document.getElementById('newFormName').value.trim()
  if (!name) { customAlert('Please enter a name'); return }

  const { data, error } = await supabase
    .from('forms')
    .insert([{ coach_id: session.user.id, name }])
    .select()

  if (error) {
    console.log('Error creating form:', error)
    customAlert('Something went wrong')
    return
  }

  window.location.href = `form-builder.html?id=${data[0].id}`
})
