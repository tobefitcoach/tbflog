// ==========================================================================
// ATHLETE APP - form fill-out screen
// ==========================================================================
import { supabase } from '../athleteClient.js?v=__V__'
import * as nav from '../nav.js?v=__V__'
import { escapeHtml } from '../../escape.js?v=__V__'
import { getYouTubeThumbnail } from '../../shared/video.js?v=__V__'
import { pageContent, athlete } from '../state.js?v=__V__'
import { completedSessionsByDayId, formsGatingDate, loadTrainingData, logSetsByPE, openSessionsByDayId } from '../data.js?v=__V__'
import { CHEVRON_LEFT, WORKOUT_TYPE_LABELS_ATH, trainingDisplayName } from '../format.js?v=__V__'
import { renderDayPreview } from './day-preview.js?v=__V__'
import { summarizeWorkout, targetLine } from './home.js?v=__V__'
import { customAlert } from '../../confirm-modal.js?v=__V__'

// ==========================================================================
// ---- FORM FILL-OUT SCREEN ----
// Read-only once completed (the Submit button is just gone) - editing an
// already-submitted answer isn't supported yet, same "keep v1 simple, add
// more later" scope as everything else about forms.
// ==========================================================================
export async function renderFormFill(fa, dateStr) {
  const myToken = nav.enter('formFill', { fa, dateStr })

  const formName = fa.forms ? fa.forms.name : 'Form'
  const done = !!fa.completed_at

  pageContent.innerHTML = `
    <div class="day-view-header">
      <button type="button" class="icon-btn" id="formFillBackBtn" aria-label="Back">${CHEVRON_LEFT}</button>
      <h2 class="day-view-date">${escapeHtml(formName)}</h2>
    </div>
    <div id="formFillQuestions"><p class="no-metrics">Loading...</p></div>
    ${done ? '' : '<button type="button" class="btn-save start-workout-btn" id="formFillSubmitBtn" style="margin-top:16px">Submit</button>'}
  `

  document.getElementById('formFillBackBtn').addEventListener('click', nav.back)

  const [{ data: questions, error }, { data: existingAnswers, error: answersError }] = await Promise.all([
    supabase.from('form_questions').select('*').eq('form_id', fa.form_id).order('order_index'),
    supabase.from('form_answers').select('*').eq('assignment_id', fa.id)
  ])
  if (!nav.isCurrent(myToken)) return // navigated away while the form loaded - #formFillQuestions is gone

  if (error) { console.log(error); document.getElementById('formFillQuestions').innerHTML = '<p class="no-metrics">Something went wrong loading this form - check your connection and try again</p>'; return }
  if (answersError) console.log(answersError)

  const answersByQuestion = {}
  for (const a of (existingAnswers || [])) answersByQuestion[a.question_id] = a

  const questionsEl = document.getElementById('formFillQuestions')
  questionsEl.innerHTML = questions.length === 0
    ? '<p class="no-metrics">This form has no questions yet</p>'
    : questions.map(renderFormFillQuestion).join('')

  // Pre-fill existing answers via property assignment (never through
  // innerHTML interpolation) - an athlete's own free-text answer could
  // contain a stray " or < that would otherwise break out of the markup
  for (const q of questions) {
    const existing = answersByQuestion[q.id]
    if (!existing) continue
    const card = questionsEl.querySelector(`.form-question-card[data-question-id="${q.id}"]`)
    if (!card) continue
    if (q.type === 'scale_1_5') {
      if (existing.answer_scale != null) {
        const btn = card.querySelector(`.form-fill-scale-btn[data-value="${existing.answer_scale}"]`)
        if (btn) btn.classList.add('selected')
      }
    } else {
      const input = card.querySelector('.form-fill-answer')
      if (input) input.value = existing.answer_text || ''
    }
    if (done) {
      card.querySelectorAll('.form-fill-answer').forEach(el => { el.disabled = true })
      card.querySelectorAll('.form-fill-scale-btn').forEach(el => { el.disabled = true })
    }
  }

  questionsEl.querySelectorAll('.form-fill-scale-row').forEach(row => {
    row.addEventListener('click', function(e) {
      const btn = e.target.closest('.form-fill-scale-btn')
      if (!btn) return
      row.querySelectorAll('.form-fill-scale-btn').forEach(b => b.classList.remove('selected'))
      btn.classList.add('selected')
    })
  })

  const submitBtn = document.getElementById('formFillSubmitBtn')
  if (submitBtn) submitBtn.addEventListener('click', function() { submitForm(fa, dateStr, questions) })
}

function renderFormFillQuestion(q) {
  if (q.type === 'scale_1_5') {
    return `
      <div class="form-question-card" data-question-id="${q.id}" data-type="scale_1_5">
        <p style="margin-bottom:10px">${escapeHtml(q.question_text)}</p>
        <div class="form-fill-scale-row">
          ${[1, 2, 3, 4, 5].map(n => `<button type="button" class="form-fill-scale-btn" data-value="${n}">${n}</button>`).join('')}
        </div>
      </div>
    `
  }
  if (q.type === 'long_text') {
    return `
      <div class="form-question-card" data-question-id="${q.id}" data-type="long_text">
        <p style="margin-bottom:10px">${escapeHtml(q.question_text)}</p>
        <textarea class="form-fill-answer"></textarea>
      </div>
    `
  }
  return `
    <div class="form-question-card" data-question-id="${q.id}" data-type="short_text">
      <p style="margin-bottom:10px">${escapeHtml(q.question_text)}</p>
      <input type="text" class="form-fill-answer" />
    </div>
  `
}

async function submitForm(fa, dateStr, questions) {
  const btn = document.getElementById('formFillSubmitBtn')
  btn.disabled = true
  btn.textContent = 'Submitting...'

  const rows = questions.map(q => {
    const card = document.querySelector(`.form-question-card[data-question-id="${q.id}"]`)
    if (q.type === 'scale_1_5') {
      const selected = card ? card.querySelector('.form-fill-scale-btn.selected') : null
      return { assignment_id: fa.id, question_id: q.id, answer_scale: selected ? parseInt(selected.dataset.value) : null }
    }
    const input = card ? card.querySelector('.form-fill-answer') : null
    return { assignment_id: fa.id, question_id: q.id, answer_text: input ? input.value.trim() : '' }
  })

  if (rows.length > 0) {
    const { error: answersError } = await supabase.from('form_answers').upsert(rows, { onConflict: 'assignment_id,question_id' })
    if (answersError) { console.log(answersError); customAlert('Something went wrong saving your answers'); btn.disabled = false; btn.textContent = 'Submit'; return }
  }

  const completedAt = new Date().toISOString()
  const { error: completeError } = await supabase.from('form_assignments').update({ completed_at: completedAt }).eq('id', fa.id)
  if (completeError) { console.log(completeError); customAlert('Something went wrong'); btn.disabled = false; btn.textContent = 'Submit'; return }

  fa.completed_at = completedAt
  await loadTrainingData()
  renderDayPreview(dateStr)
}

export function renderDayPreviewGroup(entry, isToday, dateStr) {
  const exercises = [...entry.day.program_exercises].sort((a, b) => a.order_index - b.order_index)
  const openSession = openSessionsByDayId[entry.day.id]
  const completedSession = completedSessionsByDayId[entry.day.id]

  // "Active" = today, with nothing ended yet - keep the preview clean (no
  // logged-value clutter) right up until Start/Continue is pressed. Once a
  // session's been explicitly ended, or the day's in the past, show what
  // was actually logged instead - that's the useful thing to see by then.
  const isActive = isToday && !completedSession
  const showLoggedValues = !isActive

  // completedSession's View Summary isn't gated on exercises.length - a
  // self-logged Field/Training day has zero program_exercises by design
  // (see saveFieldTraining) but still has a real summary to show. A
  // self-logged Strength day can also be genuinely empty (backed out of
  // "Add Own Workout" before adding an exercise) and still needs a way
  // back in - Field/Training never reaches here with 0 exercises since it
  // always has a completedSession the instant it's saved, so this can't
  // wrongly offer "Continue" on a Field/Training entry.
  // An open session (started, never ended) keeps showing "Continue
  // Workout" no matter how many days have passed since - it used to only
  // show on the day it was started, so forgetting to tap "End Workout"
  // meant the very next day the button just vanished with no way back in
  // short of hunting the day down manually.
  // A form with gate_workout on, still not completed, blocks STARTING this
  // day's workout - an already-open session is never blocked by a gate
  // that shows up later, only the initial Start.
  const gatingForm = !openSession ? formsGatingDate(dateStr) : null

  let actionButton = ''
  if (completedSession && !openSession) {
    actionButton = `<button type="button" class="start-workout-btn" id="viewSummaryBtn-${entry.day.id}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"></path><rect x="8" y="2" width="8" height="4" rx="1" ry="1"></rect></svg> View Summary</button>`
  } else if (gatingForm && (isToday && (exercises.length > 0 || entry.program.created_by_athlete))) {
    actionButton = `<p class="form-gate-notice"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4"></path><path d="M12 17h.01"></path><path d="M10.29 3.86l-8.18 14.18A2 2 0 0 0 4 21h16a2 2 0 0 0 1.89-2.96L13.71 3.86a2 2 0 0 0-3.42 0z"></path></svg> Complete "${escapeHtml(gatingForm.forms.name)}" first to unlock this workout</p>`
  } else if (openSession || (isToday && (exercises.length > 0 || entry.program.created_by_athlete))) {
    actionButton = `<button type="button" class="start-workout-btn" id="startWorkoutBtn-${entry.day.id}">${openSession ? '▶ Continue Workout' : '▶ Start Workout'}</button>`
  }

  // One header per run of consecutive exercises sharing the same non-null
  // section_label (exercises is already sorted by order_index above) -
  // reuses the same .builder-section-header class the coach's builders use
  let exercisesHtml = ''
  let lastLabel
  let exerciseIndex = 0
  for (const pe of exercises) {
    if (pe.section_label !== lastLabel) {
      if (pe.section_label) exercisesHtml += `<div class="builder-section-header">${pe.section_label}</div>`
      lastLabel = pe.section_label
    }
    exerciseIndex++
    exercisesHtml += renderDayPreviewExercise(pe, showLoggedValues, exerciseIndex)
  }

  // A self-logged Field/Training entry has zero program_exercises by design
  // (see saveFieldTraining) - no list to summarize or expand, so the
  // summary row/toggle is skipped entirely rather than showing "0
  // exercises · 0 sets" over an empty expandable area.
  // Same big-number/small-label tile the post-workout summary screen uses
  // (.workout-summary-stat-value/-label) - reused here at a smaller scale
  // rather than inventing a second "stat" visual language for one card.
  const summary = summarizeWorkout(exercises)
  const summaryHtml = exercises.length === 0 ? '' : `
      <button type="button" class="day-preview-summary-row" data-toggle-exercises="${entry.day.id}" aria-expanded="false">
        <div class="day-preview-stats">
          <div class="day-preview-stat">
            <div class="day-preview-stat-value">${summary.exerciseCount}</div>
            <div class="day-preview-stat-label">Exercises</div>
          </div>
          <div class="day-preview-stat">
            <div class="day-preview-stat-value">${summary.setCount}</div>
            <div class="day-preview-stat-label">Sets</div>
          </div>
          <div class="day-preview-stat">
            <div class="day-preview-stat-value">~${summary.estMinutes}m</div>
            <div class="day-preview-stat-label">Duration</div>
          </div>
        </div>
        <svg class="day-preview-summary-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
      </button>
      <div class="day-preview-exercises-detail" id="exercisesDetail-${entry.day.id}">${exercisesHtml}</div>
  `

  return `
    <div class="detail-group">
      <div class="day-preview-group-header">
        <h4 class="detail-group-title">${trainingDisplayName(entry)}</h4>
        <div style="display:flex; align-items:center; gap:8px">
          ${entry.day.workout_type ? `<span class="workout-type-badge workout-type-badge-${entry.day.workout_type}">${WORKOUT_TYPE_LABELS_ATH[entry.day.workout_type]}</span>` : ''}
          ${athlete.can_reschedule_workouts ? `<button type="button" class="exercise-history-btn day-preview-move-btn" id="moveWorkoutBtn-${entry.day.id}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg> Move</button>` : ''}
        </div>
      </div>
      ${summaryHtml}
      ${actionButton}
    </div>
  `
}

function renderDayPreviewExercise(pe, showLogged, index) {
  const videoUrl = (pe.exercises && pe.exercises.video_url) || ''
  const thumb = getYouTubeThumbnail(videoUrl)
  const target = targetLine(pe)

  // Day Preview is meant to stay a quick, glanceable overview - it used to
  // list every logged set's actual reps/weight run together on one line
  // ("8 reps @ 80kg, 8 reps @ 80kg, ..."), which for an 8-set exercise was
  // no shorter than the full workout. That level of detail now lives one
  // tap away on View Summary (see its per-set breakdown, renderWorkoutSummary)
  // - here, a done exercise just needs to say so.
  let doneCount = 0
  let totalCount = 0
  if (showLogged) {
    doneCount = (logSetsByPE[pe.id] || []).filter(s => s.completed_at).length
    totalCount = (pe.set_targets && pe.set_targets.length) ? pe.set_targets.length : (pe.prescribed_sets || 1)
  }

  // Target only shows as a fallback if this exercise was skipped entirely
  // (showLogged true, nothing logged) so the athlete can still see what was
  // scheduled.
  const hasLoggedData = showLogged && doneCount > 0
  const loggedText = doneCount >= totalCount ? 'Completed' : `${doneCount} of ${totalCount} set${totalCount === 1 ? '' : 's'}`

  // A plain numbered badge instead of a dead, unclickable gray box for any
  // exercise with no video - that box used to carry the same visual weight
  // as a real (tappable) video thumbnail while doing nothing when tapped.
  // Same 56px-wide column as .day-preview-thumb either way, so exercise
  // names still line up whether or not a given row has a video.
  const thumbHtml = videoUrl
    ? `<button type="button" class="day-preview-thumb" data-video-url="${videoUrl}">
        ${thumb ? `<img src="${thumb}" alt="" loading="lazy">` : '<span class="day-preview-thumb-placeholder"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="4" cy="12" r="2"></circle><circle cx="20" cy="12" r="2"></circle><line x1="6" y1="12" x2="18" y2="12"></line><line x1="9" y1="8" x2="9" y2="16"></line><line x1="15" y1="8" x2="15" y2="16"></line></svg></span>'}
      </button>`
    : `<div class="day-preview-index"><span class="day-preview-index-badge">${index}</span></div>`

  const infoLineHtml = hasLoggedData
    ? `<div class="day-preview-logged"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg> ${loggedText}</div>`
    : (target ? `<div class="day-preview-target">${target}</div>` : '')

  return `
    <div class="day-preview-exercise">
      ${thumbHtml}
      <div class="day-preview-info">
        <div class="day-preview-name">${pe.exercises ? pe.exercises.name : 'Unknown exercise'}</div>
        ${infoLineHtml}
      </div>
    </div>
  `
}
