// ==========================================================================
// SECTION LIBRARY
// Lists the coach's reusable exercise groups (sections + nested
// section_exercises). Mirrors trainings.js's list-page pattern exactly -
// a section is really "a training-shaped block that gets pasted into
// something else" (see the "+ Add Section" flows in training-builder.js/
// program-builder.js/athlete-calendar.js).
// ==========================================================================
import { supabase } from './coachClient.js'

const { data: { session } } = await supabase.auth.getSession()
if (!session) {
  window.location.href = 'login.html'
} else {
  loadSections()
}

// ==========================================================================
// ---- LOAD SECTIONS ----
// ==========================================================================
async function loadSections() {
  const grid = document.getElementById('sectionGrid')
  grid.innerHTML = ''

  const { data, error } = await fetchWithRetry((signal) => supabase
    .from('sections')
    .select('*, section_exercises(id)')
    .order('name')
    .abortSignal(signal)
  )

  if (error) {
    console.log('Error loading sections:', error)
    customAlert('Something went wrong loading your sections - check your connection and try again')
    return
  }

  if (data.length === 0) {
    grid.innerHTML = '<p>No sections yet — create your first one!</p>'
    return
  }

  data.forEach(createSectionCard)
}

function createSectionCard(section) {
  const exerciseCount = section.section_exercises.length

  const card = document.createElement('div')
  card.classList.add('athlete-card')
  card.innerHTML = `
    <div class="card-top">
      <div class="athlete-initials"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"></polygon><polyline points="2 17 12 22 22 17"></polyline><polyline points="2 12 12 17 22 12"></polyline></svg></div>
      <div class="kebab-menu">
        <button class="kebab-btn" data-id="${section.id}">⋮</button>
        <div class="kebab-dropdown" id="dropdown-${section.id}">
          <button class="kebab-delete" data-id="${section.id}">Delete section</button>
        </div>
      </div>
    </div>
    <h3>${section.name}</h3>
    <p>${exerciseCount} exercise${exerciseCount === 1 ? '' : 's'}</p>
  `

  card.addEventListener('click', function(e) {
    if (e.target.classList.contains('kebab-btn') ||
        e.target.classList.contains('kebab-delete')) return
    window.location.href = `section-builder.html?id=${section.id}`
  })

  card.querySelector('.kebab-btn').addEventListener('click', function(e) {
    e.stopPropagation()
    document.getElementById(`dropdown-${section.id}`).classList.toggle('active')
  })

  card.querySelector('.kebab-delete').addEventListener('click', async function(e) {
    e.stopPropagation()
    if (!(await customConfirm(`Delete "${section.name}"? This cannot be undone.`))) return

    const { error } = await supabase
      .from('sections')
      .delete()
      .eq('id', section.id)

    if (error) {
      console.log('Error deleting section:', error)
      customAlert('Something went wrong')
      return
    }

    loadSections()
  })

  document.getElementById('sectionGrid').appendChild(card)
}

// ==========================================================================
// ---- NEW SECTION MODAL ----
// ==========================================================================
document.getElementById('newSectionBtn').addEventListener('click', function() {
  document.getElementById('newSectionName').value = ''
  document.getElementById('newSectionModal').classList.add('active')
})

document.getElementById('cancelNewSectionBtn').addEventListener('click', function() {
  document.getElementById('newSectionModal').classList.remove('active')
})

document.getElementById('saveNewSectionBtn').addEventListener('click', async function() {
  const name = document.getElementById('newSectionName').value.trim()
  if (!name) { customAlert('Please enter a name'); return }

  const { data, error } = await supabase
    .from('sections')
    .insert([{ coach_id: session.user.id, name }])
    .select()

  if (error) {
    console.log('Error creating section:', error)
    customAlert('Something went wrong')
    return
  }

  window.location.href = `section-builder.html?id=${data[0].id}`
})
