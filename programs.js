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

// ==========================================================================
// ---- LOAD TEMPLATES ----
// Nested select pulls each template's weeks and days in one round trip, so
// the card can show a "3 weeks, 9 days" summary without extra queries.
// ==========================================================================
async function loadTemplates() {
  const grid = document.getElementById('programGrid')
  grid.innerHTML = ''

  const { data, error } = await fetchWithRetry((signal) => supabase
    .from('programs')
    .select('*, program_weeks(id, program_days(id))')
    .eq('is_template', true)
    .order('name')
    .abortSignal(signal)
  )

  if (error) {
    console.log('Error loading templates:', error)
    customAlert('Something went wrong loading your programs - check your connection and try again')
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
      <div class="athlete-initials"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"></path><rect x="8" y="2" width="8" height="4" rx="1" ry="1"></rect></svg></div>
      <div class="kebab-menu">
        <button class="kebab-btn" data-id="${template.id}">⋮</button>
        <div class="kebab-dropdown" id="dropdown-${template.id}">
          <button class="kebab-item kebab-duplicate" data-id="${template.id}">Duplicate</button>
          <button class="kebab-delete" data-id="${template.id}">Delete template</button>
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

  card.querySelector('.kebab-duplicate').addEventListener('click', function(e) {
    e.stopPropagation()
    openDuplicateTemplateModal(template.id, template.name)
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
  document.getElementById('newTemplateWeeks').value = '4'
  document.getElementById('newTemplateModal').classList.add('active')
})

document.getElementById('cancelNewTemplateBtn').addEventListener('click', function() {
  document.getElementById('newTemplateModal').classList.remove('active')
})

document.getElementById('saveNewTemplateBtn').addEventListener('click', async function() {
  const name = document.getElementById('newTemplateName').value.trim()
  const weekCount = Math.max(1, Math.min(52, parseInt(document.getElementById('newTemplateWeeks').value) || 1))
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

  const { error: weeksError } = await supabase
    .from('program_weeks')
    .insert(Array.from({ length: weekCount }, (_, i) => ({ program_id: data[0].id, week_number: i + 1 })))

  if (weeksError) { console.log('Error creating weeks:', weeksError) } // non-fatal - the builder's own "+ Add Week" still works if this failed

  window.location.href = `program-builder.html?id=${data[0].id}`
})

// ==========================================================================
// ---- DUPLICATE TEMPLATE ----
// Clones the source template's own row plus every week/day/exercise under
// it (fresh superset/section-instance ids, same remap pattern trainings.js's
// duplicate uses), then jumps straight into program-builder.html for the
// new copy. Weeks/days are created one at a time (need each one's own id
// before its children can reference it) - exercises are batch-inserted per
// day since nothing downstream needs to reference them individually.
// ==========================================================================
let duplicateSourceTemplateId = null

function openDuplicateTemplateModal(templateId, templateName) {
  duplicateSourceTemplateId = templateId
  document.getElementById('duplicateTemplateName').value = `${templateName} (Copy)`
  document.getElementById('duplicateTemplateModal').classList.add('active')
}

document.getElementById('cancelDuplicateTemplateBtn').addEventListener('click', function() {
  document.getElementById('duplicateTemplateModal').classList.remove('active')
})

document.getElementById('saveDuplicateTemplateBtn').addEventListener('click', async function() {
  const name = document.getElementById('duplicateTemplateName').value.trim()
  if (!name) { customAlert('Please enter a name'); return }

  const btn = this
  btn.disabled = true
  btn.textContent = 'Duplicating...'

  const { data: sourceWeeks, error: weeksError } = await supabase
    .from('program_weeks')
    .select('*, program_days(*, program_exercises(*))')
    .eq('program_id', duplicateSourceTemplateId)
    .order('week_number')

  if (weeksError) {
    console.log('Error loading source program:', weeksError)
    customAlert('Something went wrong')
    btn.disabled = false; btn.textContent = 'Duplicate & Edit'
    return
  }

  const { data: newProgram, error: programError } = await supabase
    .from('programs')
    .insert([{ coach_id: session.user.id, is_template: true, athlete_id: null, name }])
    .select()
    .single()

  if (programError) {
    console.log('Error creating duplicate:', programError)
    customAlert('Something went wrong')
    btn.disabled = false; btn.textContent = 'Duplicate & Edit'
    return
  }

  // Keyed by the ORIGINAL id, so one shared map for the whole program is
  // fine - those originals were already unique, nothing to collide with
  // across different days/weeks.
  const groupIdMap = {}
  const sectionInstanceMap = {}
  for (const week of sourceWeeks) {
    for (const day of week.program_days) {
      for (const pe of day.program_exercises) {
        if (pe.superset_group_id && !groupIdMap[pe.superset_group_id]) groupIdMap[pe.superset_group_id] = crypto.randomUUID()
        if (pe.section_instance_id && !sectionInstanceMap[pe.section_instance_id]) sectionInstanceMap[pe.section_instance_id] = crypto.randomUUID()
      }
    }
  }

  for (const week of sourceWeeks) {
    const { data: newWeek, error: weekError } = await supabase
      .from('program_weeks')
      .insert([{ program_id: newProgram.id, week_number: week.week_number }])
      .select()
      .single()
    if (weekError) { console.log('Error copying week:', weekError); continue }

    for (const day of week.program_days) {
      const { data: newDay, error: dayError } = await supabase
        .from('program_days')
        .insert([{ week_id: newWeek.id, day_number: day.day_number, label: day.label, workout_type: day.workout_type }])
        .select()
        .single()
      if (dayError) { console.log('Error copying day:', dayError); continue }
      if (day.program_exercises.length === 0) continue

      const { error: exercisesError } = await supabase.from('program_exercises').insert(
        day.program_exercises.map(pe => ({
          day_id: newDay.id, exercise_id: pe.exercise_id, order_index: pe.order_index,
          prescribed_sets: pe.prescribed_sets, prescribed_reps: pe.prescribed_reps, prescribed_weight: pe.prescribed_weight,
          rest_seconds: pe.rest_seconds, extra_fields: pe.extra_fields, set_targets: pe.set_targets, notes: pe.notes,
          section_label: pe.section_label,
          section_instance_id: pe.section_instance_id ? sectionInstanceMap[pe.section_instance_id] : null,
          superset_group_id: pe.superset_group_id ? groupIdMap[pe.superset_group_id] : null,
          tracks_weight_override: pe.tracks_weight_override, is_timed_override: pe.is_timed_override,
          is_unilateral_override: pe.is_unilateral_override, tracks_distance_override: pe.tracks_distance_override,
          alternative_exercise_id: pe.alternative_exercise_id
        }))
      )
      if (exercisesError) console.log('Error copying exercises for a day:', exercisesError)
    }
  }

  window.location.href = `program-builder.html?id=${newProgram.id}`
})
