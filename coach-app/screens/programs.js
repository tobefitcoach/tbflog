// ==========================================================================
// PROGRAM LIBRARY — screen
// Converted from the repo-root programs.js + the .dashboard block of
// programs.html. Lists the coach's reusable program TEMPLATES (programs
// where is_template = true, athlete_id is null). Templates get built out in
// the Program Builder and later assigned to a specific athlete from that
// athlete's Calendar tab - assigning makes a full copy, it never links back
// to the template.
//
// The duplicate flow below is unchanged from the original, including its
// week-at-a-time inserts (each week/day needs its own id before its
// children can reference it) and the shared id remap for superset groups
// and section instances.
// ==========================================================================
import { supabase } from '../../coachClient.js'
import * as nav from '../nav.js'
import { go } from '../router.js'
import { coachId } from '../session.js'

const TEMPLATE = `
  <div class="dashboard-header">
    <h2>Program Library</h2>
    <button class="btn-add" id="newTemplateBtn">+ New Template</button>
  </div>
  <div class="athlete-grid" id="programGrid"></div>

  <!-- New Template Modal: name + week count - that many program_weeks rows
       get created immediately, so the builder opens with the weeks already
       there instead of clicking "+ Add Week" N times. -->
  <div class="modal-overlay" id="newTemplateModal">
    <div class="modal">
      <h2>New Program Template</h2>
      <div class="form-group">
        <label>Name</label>
        <input type="text" id="newTemplateName" placeholder="e.g. Push Pull Legs - Hypertrophy" />
      </div>
      <div class="form-group">
        <label>Number of Weeks</label>
        <input type="number" id="newTemplateWeeks" value="4" min="1" max="52" />
      </div>
      <div class="form-actions">
        <button class="btn-cancel" id="cancelNewTemplateBtn" data-modal-dismiss>Cancel</button>
        <button class="btn-save" id="saveNewTemplateBtn">Create &amp; Edit</button>
      </div>
    </div>
  </div>

  <!-- Duplicate Template Modal: pre-filled "Copy of X" name, then clones
       the whole template (every week/day/exercise) and jumps straight into
       editing the new copy - opened from the source card's kebab. -->
  <div class="modal-overlay" id="duplicateTemplateModal">
    <div class="modal">
      <h2>Duplicate Program</h2>
      <div class="form-group">
        <label>Name</label>
        <input type="text" id="duplicateTemplateName" placeholder="e.g. Push Pull Legs - Hypertrophy (Copy)" />
      </div>
      <div class="form-actions">
        <button class="btn-cancel" id="cancelDuplicateTemplateBtn" data-modal-dismiss>Cancel</button>
        <button class="btn-save" id="saveDuplicateTemplateBtn">Duplicate &amp; Edit</button>
      </div>
    </div>
  </div>
`

const SKELETON = `
  <div class="dashboard-header"><h2>Program Library</h2></div>
  <div class="athlete-grid">
    ${'<div class="skeleton-bar" style="height:132px"></div>'.repeat(4)}
  </div>
`

let root = null
let allTemplates = []
let onDocClick = null
let duplicateSourceTemplateId = null

export async function mount(container, params, token) {
  root = container
  container.innerHTML = SKELETON

  // Nested select pulls each template's weeks and days in one round trip,
  // so the card can show a "3 weeks, 9 days" summary without extra queries.
  const { data, error } = await window.fetchWithRetry((signal) => supabase
    .from('programs')
    .select('*, program_weeks(id, program_days(id))')
    .eq('is_template', true)
    .order('name')
    .abortSignal(signal)
  )
  if (!nav.isCurrent(token)) return

  if (error) {
    console.log('Error loading templates:', error)
    container.innerHTML = `
      <div class="screen-message">
        <h2>Couldn't load your programs</h2>
        <p>Check your connection and try again.</p>
      </div>`
    return
  }

  allTemplates = data || []
  container.innerHTML = TEMPLATE
  bindEvents()
  renderProgramGrid()
}

export function unmount() {
  if (onDocClick) document.removeEventListener('click', onDocClick)
  onDocClick = null
  root = null
  allTemplates = []
  duplicateSourceTemplateId = null
}

function bindEvents() {
  onDocClick = function() {
    root?.querySelectorAll('#programGrid .kebab-dropdown.active').forEach(d => d.classList.remove('active'))
  }
  document.addEventListener('click', onDocClick)

  root.querySelector('#newTemplateBtn').addEventListener('click', function() {
    root.querySelector('#newTemplateName').value = ''
    root.querySelector('#newTemplateWeeks').value = '4'
    root.querySelector('#newTemplateModal').classList.add('active')
  })

  root.querySelector('#cancelNewTemplateBtn').addEventListener('click', function() {
    root.querySelector('#newTemplateModal').classList.remove('active')
  })

  root.querySelector('#saveNewTemplateBtn').addEventListener('click', onCreateTemplate)

  root.querySelector('#cancelDuplicateTemplateBtn').addEventListener('click', function() {
    root.querySelector('#duplicateTemplateModal').classList.remove('active')
  })

  root.querySelector('#saveDuplicateTemplateBtn').addEventListener('click', onDuplicateTemplate)
}

async function onCreateTemplate() {
  const name = root.querySelector('#newTemplateName').value.trim()
  const weekCount = Math.max(1, Math.min(52, parseInt(root.querySelector('#newTemplateWeeks').value) || 1))
  if (!name) { customAlert('Please enter a name'); return }

  const { data, error } = await supabase
    .from('programs')
    .insert([{ coach_id: coachId(), is_template: true, athlete_id: null, name }])
    .select()

  if (error) {
    console.log('Error creating template:', error)
    customAlert('Something went wrong')
    return
  }

  const { error: weeksError } = await supabase
    .from('program_weeks')
    .insert(Array.from({ length: weekCount }, (_, i) => ({ program_id: data[0].id, week_number: i + 1 })))

  // Non-fatal - the builder's own "+ Add Week" still works if this failed.
  if (weeksError) console.log('Error creating weeks:', weeksError)

  go('program-builder', { id: data[0].id })
}

function renderProgramGrid() {
  const grid = root.querySelector('#programGrid')
  grid.innerHTML = ''

  if (allTemplates.length === 0) {
    grid.innerHTML = '<p>No program templates yet — create your first one!</p>'
    return
  }

  allTemplates.forEach(t => grid.appendChild(createTemplateCard(t)))
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
    if (e.target.closest('.kebab-menu')) return
    go('program-builder', { id: template.id })
  })

  card.querySelector('.kebab-btn').addEventListener('click', function(e) {
    e.stopPropagation()
    card.querySelector(`#dropdown-${template.id}`).classList.toggle('active')
  })

  card.querySelector('.kebab-duplicate').addEventListener('click', function(e) {
    e.stopPropagation()
    duplicateSourceTemplateId = template.id
    root.querySelector('#duplicateTemplateName').value = `${template.name} (Copy)`
    root.querySelector('#duplicateTemplateModal').classList.add('active')
  })

  card.querySelector('.kebab-delete').addEventListener('click', async function(e) {
    e.stopPropagation()
    if (!(await customConfirm(`Delete "${template.name}"? This cannot be undone.`))) return

    const { error } = await supabase.from('programs').delete().eq('id', template.id)
    if (error) {
      console.log('Error deleting template:', error)
      customAlert('Something went wrong')
      return
    }

    allTemplates = allTemplates.filter(t => t.id !== template.id)
    renderProgramGrid()
  })

  return card
}

// ==========================================================================
// DUPLICATE
// Clones the source template's own row plus every week/day/exercise under
// it (fresh superset/section-instance ids), then jumps straight into the
// builder for the new copy. Weeks and days are created one at a time - each
// needs its own id before its children can reference it - while exercises
// are batch-inserted per day, since nothing downstream references them
// individually.
// ==========================================================================
async function onDuplicateTemplate() {
  const btn = root.querySelector('#saveDuplicateTemplateBtn')
  const name = root.querySelector('#duplicateTemplateName').value.trim()
  if (!name) { customAlert('Please enter a name'); return }

  btn.disabled = true
  btn.textContent = 'Duplicating...'
  const fail = function(msg, err) {
    console.log(msg, err)
    customAlert('Something went wrong')
    btn.disabled = false
    btn.textContent = 'Duplicate & Edit'
  }

  const { data: sourceWeeks, error: weeksError } = await supabase
    .from('program_weeks')
    .select('*, program_days(*, program_exercises(*))')
    .eq('program_id', duplicateSourceTemplateId)
    .order('week_number')
  if (weeksError) return fail('Error loading source program:', weeksError)

  const { data: newProgram, error: programError } = await supabase
    .from('programs')
    .insert([{ coach_id: coachId(), is_template: true, athlete_id: null, name }])
    .select()
    .single()
  if (programError) return fail('Error creating duplicate:', programError)

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
        .insert([{
          week_id: newWeek.id, day_number: day.day_number, label: day.label, workout_type: day.workout_type,
          // Carries the live-link forward if the source day still had one -
          // see setDayLiveLink's comment in athlete-detail.js/program-builder.js.
          // synced_at always starts null so the next read performs the first
          // real sync itself.
          source_training_id: day.source_training_id || null,
          source_training_synced_at: null
        }])
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

  go('program-builder', { id: newProgram.id })
}
