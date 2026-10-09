// ==========================================================================
// ATHLETE DETAIL - calendar: "+" on a day
// The add popup (Workout tab) and the Tournament tab.
// ==========================================================================
import { supabase } from '../../../../coachClient.js?v=__V__'
import { getYouTubeThumbnail } from '../../../../shared/video.js?v=__V__'
import { applyFieldOverrides } from '../../../../shared/exercise-fields.js?v=__V__'
import { root, athleteId, cal } from '../state.js?v=__V__'
import { TOURNAMENT_IMPORTANCE_DESCRIPTIONS_CAL, formatDisplayDateCal, loadCalendarMonth } from './grid.js?v=__V__'
import { loadDayAddFormListCal, loadDayAddProgramList, loadDayAddSectionListCal, resetFormPreviewCal, resetSectionPreviewCal } from './pickers.js?v=__V__'
import { showToast } from '../toast.js?v=__V__'
import { customAlert } from '../../../../confirm-modal.js?v=__V__'
import { fetchWithRetry } from '../../../../network-retry.js?v=__V__'

// ==========================================================================
// ---- ADD TRAINING (hover "+" on a calendar day) ----
// findOrCreateAdHocDay reuses the same ad-hoc day container across the
// Single Workout and Section tabs within ONE popup session (so adding a
// Section then a Training in one sitting combines into one day), but always
// creates a fresh one on a new "+" click - see adHocDayIdForThisSession.
// Only way to put exercises on a day is via a saved Training - no more
// "add one loose exercise" flow, that's what the Workout Library / Workout
// Builder is for. Two tabs share this one popup: a single
// saved Training onto just this day, or a whole Program starting on this
// day (see switchDayAddTab below).
// ==========================================================================
async function getTrainingsList() {
  if (cal.cachedTrainings) return cal.cachedTrainings
  const { data, error } = await fetchWithRetry((signal) => supabase.from('trainings').select('*').order('created_at', { ascending: false }).abortSignal(signal))
  if (error) { console.log(error); customAlert('Something went wrong loading your workouts - check your connection and try again'); return null }
  cal.cachedTrainings = data
  return cal.cachedTrainings
}

export async function getProgramTemplates() {
  if (cal.cachedTemplates) return cal.cachedTemplates
  const { data, error } = await fetchWithRetry((signal) => supabase.from('programs').select('*').eq('is_template', true).order('name').abortSignal(signal))
  if (error) { console.log(error); customAlert('Something went wrong loading your programs - check your connection and try again'); return null }
  cal.cachedTemplates = data
  return cal.cachedTemplates
}

// Selecting a row in the list previews it here rather than applying it
// straight away - selectedTraining* remembers what's currently previewed so
// the "Select" button (disabled until something's picked) knows what to
// apply. cachedTrainingExercises avoids re-fetching a preview already seen
// once in this session (e.g. clicking back and forth between two rows).
export async function openDayAddTrainingModal(dateStr) {
  cal.currentDayDateForAddTraining = dateStr
  root.querySelector('#dayAddTrainingTitle').textContent = 'Add to Calendar — ' + formatDisplayDateCal(dateStr)
  switchDayAddTab('workout')
  resetTrainingPreview()
  resetSectionPreviewCal()
  resetFormPreviewCal()
  resetCoachTournamentForm(dateStr)

  const data = await getTrainingsList()
  const list = root.querySelector('#dayAddTrainingList')

  if (data === null) {
    list.innerHTML = '<p class="no-metrics">Something went wrong loading the Workout Library</p>'
  } else if (data.length === 0) {
    list.innerHTML = '<p class="no-metrics">No workouts saved yet - create one in the Workout Library first</p>'
  } else {
    list.innerHTML = data.map(t => `
      <div class="training-pick-row" data-id="${t.id}" data-name="${t.name}">
        <span>${t.name}</span>
      </div>
    `).join('')

    list.querySelectorAll('.training-pick-row').forEach(row => {
      row.addEventListener('click', function() {
        list.querySelectorAll('.training-pick-row').forEach(r => r.classList.remove('selected'))
        row.classList.add('selected')
        previewTraining(row.dataset.id, row.dataset.name)
      })
    })
  }

  await loadDayAddProgramList()
  await loadDayAddSectionListCal()
  await loadDayAddFormListCal()

  root.querySelector('#dayAddTrainingModal').classList.add('active')
}

function resetTrainingPreview() {
  cal.selectedTrainingId = null
  cal.selectedTrainingName = null
  root.querySelector('#dayAddTrainingPreview').innerHTML = '<p class="no-metrics">Select a workout to preview it</p>'
  root.querySelector('#selectTrainingForDayBtn').disabled = true
}

async function previewTraining(trainingId, trainingName) {
  cal.selectedTrainingId = trainingId
  cal.selectedTrainingName = trainingName
  root.querySelector('#selectTrainingForDayBtn').disabled = false

  const preview = root.querySelector('#dayAddTrainingPreview')
  preview.innerHTML = '<p class="no-metrics">Loading…</p>'

  let exercises = cal.cachedTrainingExercises[trainingId]
  if (!exercises) {
    const { data, error } = await supabase
      .from('training_exercises')
      .select('*, exercises!exercise_id(name, type, video_url, tracks_reps, tracks_weight, is_timed, is_unilateral, tracks_distance)')
      .eq('training_id', trainingId)
      .order('order_index')
    if (error) { console.log(error); preview.innerHTML = '<p class="no-metrics">Something went wrong loading this preview</p>'; return }
    exercises = data
    exercises.forEach(applyFieldOverrides)
    cal.cachedTrainingExercises[trainingId] = exercises
  }

  // A different row may have been clicked while this was still loading -
  // don't overwrite that newer preview with this now-stale one
  if (cal.selectedTrainingId !== trainingId) return

  preview.innerHTML = `
    <div class="workout-preview-header">
      <h3>${trainingName}</h3>
      <span class="workout-preview-count">${exercises.length} Exercise${exercises.length === 1 ? '' : 's'}</span>
    </div>
    ${exercises.length === 0
      ? '<p class="no-metrics">No exercises in this workout</p>'
      : exercises.map(renderWorkoutPreviewExercise).join('')}
  `
}

export function renderWorkoutPreviewExercise(te) {
  const thumb = getYouTubeThumbnail((te.exercises && te.exercises.video_url) || '')
  const target = targetLineForTraining(te)

  return `
    <div class="workout-preview-exercise">
      <div class="workout-preview-thumb">${thumb ? `<img src="${thumb}" alt="" loading="lazy">` : '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="4" cy="12" r="2"></circle><circle cx="20" cy="12" r="2"></circle><line x1="6" y1="12" x2="18" y2="12"></line><line x1="9" y1="8" x2="9" y2="16"></line><line x1="15" y1="8" x2="15" y2="16"></line></svg>'}</div>
      <div class="workout-preview-info">
        <div class="workout-preview-name">${te.exercises ? te.exercises.name : 'Unknown exercise'}</div>
        ${target ? `<div class="workout-preview-target">${target}</div>` : ''}
      </div>
    </div>
  `
}

// A timed set's reps field is free text (the coach could type "45", "45s",
// "1 min", etc) - only append "sec" when it's a plain number, so we don't
// double up on a unit that was already typed in
function formatTimedRepsCal(val) {
  if (!val && val !== 0) return '-'
  return /^\d+(\.\d+)?$/.test(String(val).trim()) ? `${val} sec` : val
}

// "12/10/8 reps @ 50kg" when only reps vary across sets, "12@40kg, 10@45kg,
// 8@50kg" for a real pyramid. Returns null when this exercise has no
// per-set targets yet, so callers fall back to the old single-value summary.
// A distance-tracking exercise gets a " · 400m" (or per-set "400m/300m")
// suffix appended, independent of the reps/weight branch above it.
function formatSetTargetsCal(setTargets, isTimed, tracksWeight, tracksDistance) {
  if (!setTargets || setTargets.length === 0) return null
  let text
  if (isTimed && !tracksWeight) {
    text = setTargets.map(s => formatTimedRepsCal(s.reps)).join(' / ')
  } else if (isTimed && tracksWeight) {
    text = setTargets.map(s => `${formatTimedRepsCal(s.reps)}${s.weight != null ? ' @ ' + s.weight + 'kg' : ''}`).join(', ')
  } else {
    const sameWeight = setTargets.every(s => s.weight === setTargets[0].weight)
    if (sameWeight) {
      const reps = setTargets.map(s => s.reps || '-').join('/')
      text = `${reps} reps${setTargets[0].weight != null ? ' @ ' + setTargets[0].weight + 'kg' : ''}`
    } else {
      text = setTargets.map(s => `${s.reps || '-'}${s.weight != null ? '@' + s.weight + 'kg' : ''}`).join(', ')
    }
  }
  if (tracksDistance && setTargets.some(s => s.distance != null)) {
    const sameDistance = setTargets.every(s => s.distance === setTargets[0].distance)
    text += ' · ' + (sameDistance ? `${setTargets[0].distance}m` : setTargets.map(s => s.distance != null ? `${s.distance}m` : '-').join('/'))
  }
  return text
}

function targetLineForTraining(te) {
  const isTimed = te.exercises && te.exercises.is_timed
  const tracksWeight = !te.exercises || te.exercises.tracks_weight
  const tracksDistance = te.exercises && te.exercises.tracks_distance
  const setTargetsText = formatSetTargetsCal(te.set_targets, isTimed, tracksWeight, tracksDistance)
  const parts = []
  if (setTargetsText) {
    parts.push(setTargetsText)
  } else {
    if (te.prescribed_sets) parts.push(`${te.prescribed_sets} sets`)
    if (te.prescribed_reps) parts.push(isTimed ? formatTimedRepsCal(te.prescribed_reps) : `${te.prescribed_reps} reps`)
    if (te.prescribed_weight && tracksWeight) parts.push(`${te.prescribed_weight}kg`)
  }
  if (te.extra_fields) {
    for (const [k, v] of Object.entries(te.extra_fields)) parts.push(`${k}: ${v}`)
  }
  return parts.join(' × ')
}

// ---- TOURNAMENT TAB ------------------------------------------------------
// The start/end dates are pre-filled with the day whose "+" was clicked, so
// "she said the 14th" is one click on the 14th and a name. Picking a start
// date pulls the end date along with it unless the coach already set a later
// one (same behaviour as the athlete's own form).
let coachTournamentImportance = null

function resetCoachTournamentForm(dateStr) {
  root.querySelector('#coachTournamentName').value = ''
  root.querySelector('#coachTournamentStart').value = dateStr
  const endInput = root.querySelector('#coachTournamentEnd')
  endInput.value = dateStr
  endInput.min = dateStr
  coachTournamentImportance = null
  root.querySelectorAll('.coach-importance-btn').forEach(b => b.classList.remove('selected'))
  root.querySelector('#coachTournamentImportanceHint').textContent = 'Tap a number to see what it means'
}

export function wireCoachTournamentForm() {
  const startInput = root.querySelector('#coachTournamentStart')
  const endInput = root.querySelector('#coachTournamentEnd')

  startInput.addEventListener('change', function() {
    endInput.min = startInput.value
    if (!endInput.value || endInput.value < startInput.value) endInput.value = startInput.value
  })

  root.querySelectorAll('.coach-importance-btn').forEach(btn => {
    btn.addEventListener('click', function() {
      root.querySelectorAll('.coach-importance-btn').forEach(b => b.classList.remove('selected'))
      btn.classList.add('selected')
      coachTournamentImportance = parseInt(btn.dataset.importance)
      root.querySelector('#coachTournamentImportanceHint').textContent = TOURNAMENT_IMPORTANCE_DESCRIPTIONS_CAL[coachTournamentImportance]
    })
  })

  root.querySelector('#saveCoachTournamentBtn').addEventListener('click', async function() {
    const btn = this
    const name = root.querySelector('#coachTournamentName').value.trim()
    const date = startInput.value
    const endDate = endInput.value || date
    if (!name) { customAlert('Please enter a name for this tournament'); return }
    if (!date) { customAlert('Please pick a start date'); return }
    if (endDate < date) { customAlert("End date can't be before the start date"); return }
    if (!coachTournamentImportance) { customAlert('Please rate how important this tournament is'); return }

    btn.disabled = true
    btn.textContent = 'Adding...'

    // One attempt only (no retry): this inserts a row, so a retry after a
    // dropped response could add the same tournament twice
    const { error } = await fetchWithRetry((signal) => supabase
      .rpc('coach_add_tournament', {
        p_athlete_id: athleteId, p_name: name, p_date: date, p_end_date: endDate, p_importance: coachTournamentImportance
      })
      .abortSignal(signal), 1
    )

    if (!root) return
    btn.disabled = false
    btn.textContent = 'Add Tournament'

    if (error) {
      console.log('Error adding tournament:', error)
      // PGRST202 = the database function isn't installed yet
      customAlert(error.code === 'PGRST202'
        ? 'Tournaments need a one-time database update first - run the newest block in sql-history.sql.'
        : 'Something went wrong adding that tournament - try again')
      return
    }

    root.querySelector('#dayAddTrainingModal').classList.remove('active')
    await loadCalendarMonth(cal.currentViewYear, cal.currentViewMonth)
    showToast(`Added ${name} to the calendar`)
  })
}

export function switchDayAddTab(tab) {
  root.querySelector('#dayAddTabWorkout').classList.toggle('active', tab === 'workout')
  root.querySelector('#dayAddTabProgram').classList.toggle('active', tab === 'program')
  root.querySelector('#dayAddTabSection').classList.toggle('active', tab === 'section')
  root.querySelector('#dayAddTabForm').classList.toggle('active', tab === 'form')
  root.querySelector('#dayAddTabTournament').classList.toggle('active', tab === 'tournament')
  root.querySelector('#dayAddWorkoutPanel').classList.toggle('active', tab === 'workout')
  root.querySelector('#dayAddProgramPanel').classList.toggle('active', tab === 'program')
  root.querySelector('#dayAddSectionPanel').classList.toggle('active', tab === 'section')
  root.querySelector('#dayAddFormPanel').classList.toggle('active', tab === 'form')
  root.querySelector('#dayAddTournamentPanel').classList.toggle('active', tab === 'tournament')
}
