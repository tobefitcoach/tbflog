// ==========================================================================
// PROGRAM LIBRARY
// Lists the coach's reusable program TEMPLATES (programs where
// is_template = true, athlete_id is null). Templates get built out on
// program-builder.html and later assigned to a specific athlete from that
// athlete's Calendar tab (see athlete-calendar.js) - assigning makes a full
// copy, it never links back to the template.
// ==========================================================================
import { supabase } from './coachClient.js'

const { data: { session } } = await supabase.auth.getSession()
if (!session) {
  window.location.href = 'login.html'
} else {
  loadTemplates()
}

document.getElementById('logoutBtn').addEventListener('click', async function() {
  await supabase.auth.signOut()
  window.location.href = 'login.html'
})

// ==========================================================================
// ---- LOAD TEMPLATES ----
// Nested select pulls each template's weeks and days in one round trip, so
// the card can show a "3 weeks, 9 days" summary without extra queries.
// ==========================================================================
async function loadTemplates() {
  const grid = document.getElementById('programGrid')
  grid.innerHTML = ''

  const { data, error } = await supabase
    .from('programs')
    .select('*, program_weeks(id, program_days(id))')
    .eq('is_template', true)
    .order('name')

  if (error) {
    console.log('Error loading templates:', error)
    return
  }

  if (data.length === 0) {
    grid.innerHTML = '<p>No program templates yet — create your first one!</p>'
    return
  }

  data.forEach(createTemplateCard)
}

function createTemplateCard(template) {
  const weekCount = template.program_weeks.length
  const dayCount = template.program_weeks.reduce((sum, w) => sum + w.program_days.length, 0)

  const card = document.createElement('div')
  card.classList.add('athlete-card')
  card.innerHTML = `
    <div class="card-top">
      <div class="athlete-initials">📋</div>
      <div class="kebab-menu">
        <button class="kebab-btn" data-id="${template.id}">⋮</button>
        <div class="kebab-dropdown" id="dropdown-${template.id}">
          <button class="kebab-delete" data-id="${template.id}">🗑 Delete template</button>
        </div>
      </div>
    </div>
    <h3>${template.name}</h3>
    <p>${weekCount} week${weekCount === 1 ? '' : 's'}, ${dayCount} day${dayCount === 1 ? '' : 's'}</p>
  `

  card.addEventListener('click', function(e) {
    if (e.target.classList.contains('kebab-btn') ||
        e.target.classList.contains('kebab-delete')) return
    window.location.href = `program-builder.html?id=${template.id}`
  })

  card.querySelector('.kebab-btn').addEventListener('click', function(e) {
    e.stopPropagation()
    document.getElementById(`dropdown-${template.id}`).classList.toggle('active')
  })

  card.querySelector('.kebab-delete').addEventListener('click', async function(e) {
    e.stopPropagation()
    if (!(await customConfirm(`Delete "${template.name}"? This cannot be undone.`))) return

    const { error } = await supabase
      .from('programs')
      .delete()
      .eq('id', template.id)

    if (error) {
      console.log('Error deleting template:', error)
      customAlert('Something went wrong')
      return
    }

    loadTemplates()
  })

  document.getElementById('programGrid').appendChild(card)
}

// ==========================================================================
// ---- NEW TEMPLATE MODAL ----
// Just collects a name, then redirects straight into the builder - weeks/
// days/exercises all get added there.
// ==========================================================================
document.getElementById('newTemplateBtn').addEventListener('click', function() {
  document.getElementById('newTemplateName').value = ''
  document.getElementById('newTemplateModal').classList.add('active')
})

document.getElementById('cancelNewTemplateBtn').addEventListener('click', function() {
  document.getElementById('newTemplateModal').classList.remove('active')
})

document.getElementById('saveNewTemplateBtn').addEventListener('click', async function() {
  const name = document.getElementById('newTemplateName').value.trim()
  if (!name) { customAlert('Please enter a name'); return }

  const { data, error } = await supabase
    .from('programs')
    .insert([{ coach_id: session.user.id, is_template: true, athlete_id: null, name }])
    .select()

  if (error) {
    console.log('Error creating template:', error)
    customAlert('Something went wrong')
    return
  }

  window.location.href = `program-builder.html?id=${data[0].id}`
})
