// ==========================================================================
// ATHLETE APP - day preview
// Read-only preview of a day, the Move Workout modal (gated by
// athlete.can_reschedule_workouts) and the Log Weight modal.
// ==========================================================================
import { supabase } from '../athleteClient.js?v=__V__'
import * as nav from '../nav.js?v=__V__'
import { escapeHtml } from '../../escape.js?v=__V__'
import { toDateStr, parseDateStr, startOfWeek } from '../../shared/dates.js?v=__V__'
import { pageContent, athlete } from '../state.js?v=__V__'
import { completedSessionsByDayId, entriesByDate, formAssignmentsByDate, loadTrainingData } from '../data.js?v=__V__'
import { CHEVRON_LEFT, formatDisplayDate, weightToKg } from '../format.js?v=__V__'
import { insertOnce, loadPendingQueue, saveWithRetry } from '../outbox.js?v=__V__'
import { renderDayPreviewGroup, renderFormFill } from './form-fill.js?v=__V__'
import { currentWeekStart, playInlineVideo, renderSyncBannerHtml, renderWeekView, wireSyncBanner } from './home.js?v=__V__'
import { renderMobilityAreaPicker } from './mobility.js?v=__V__'
import { renderAddWorkoutChoice } from './own-workout.js?v=__V__'
import { renderRestDayCard } from './stats.js?v=__V__'
import { loadLatestBodyweight } from './tournaments.js?v=__V__'
import { startWorkout } from '../workout/active.js?v=__V__'
import { renderWorkoutSummary } from '../workout/swipe.js?v=__V__'

// ==========================================================================
// ---- DAY PREVIEW (read-only, no logging inputs) ----
// ==========================================================================
export function renderDayPreview(dateStr) {
  nav.enter('dayPreview', { dateStr })

  const isToday = dateStr === toDateStr(new Date())
  const entries = entriesByDate[dateStr] || []
  const forms = formAssignmentsByDate[dateStr] || []

  // Forms render first - if one of them gates the day's workout, the
  // athlete should see it before (not below) the locked workout it's
  // blocking
  const formsHtml = forms.map(fa => renderFormPreviewCard(fa, dateStr)).join('')

  // A flag, not a scroll hint - each card below is collapsed by default
  // (see renderDayPreviewGroup), so a second workout is already visible
  // without scrolling; this just confirms there's more than one before the
  // athlete starts reading either card.
  const multiWorkoutNoticeHtml = entries.length > 1
    ? `<p class="day-preview-count">${entries.length} workouts today</p>`
    : ''

  const bodyHtml = (entries.length === 0 && forms.length === 0)
    ? renderRestDayCard(dateStr, isToday)
    : formsHtml + multiWorkoutNoticeHtml + entries.map(entry => renderDayPreviewGroup(entry, isToday, dateStr)).join('')

  pageContent.innerHTML = `
    <div class="day-view-header">
      <button class="icon-btn" id="backToWeekBtn" aria-label="Back">${CHEVRON_LEFT}</button>
      <h2>${isToday ? 'Today' : formatDisplayDate(dateStr)}</h2>
    </div>
    ${isToday ? `<p class="day-view-date">${formatDisplayDate(dateStr)}</p>` : ''}
    ${renderSyncBannerHtml(loadPendingQueue().length)}
    <div id="dayPreviewBody">${bodyHtml}</div>
  `

  document.getElementById('backToWeekBtn').addEventListener('click', nav.back)

  wireSyncBanner(function() { renderDayPreview(dateStr) })

  const restMobilityBtn = document.getElementById('restMobilityBtn')
  if (restMobilityBtn) restMobilityBtn.addEventListener('click', function() { renderMobilityAreaPicker() })
  const restOwnWorkoutBtn = document.getElementById('restOwnWorkoutBtn')
  if (restOwnWorkoutBtn) restOwnWorkoutBtn.addEventListener('click', function() { renderAddWorkoutChoice() })

  document.getElementById('dayPreviewBody').addEventListener('click', function(e) {
    const thumbBtn = e.target.closest('[data-video-url]')
    if (thumbBtn) { playInlineVideo(thumbBtn, thumbBtn.dataset.videoUrl); return }

    // Expands/collapses one workout's exercise list in place - every card
    // starts collapsed (see renderDayPreviewGroup), so this is the only way
    // to reach it. Toggling a class rather than re-rendering means the
    // video-playing state of any already-expanded card elsewhere on the
    // page survives the click.
    const toggleBtn = e.target.closest('[data-toggle-exercises]')
    if (toggleBtn) {
      const detail = document.getElementById('exercisesDetail-' + toggleBtn.dataset.toggleExercises)
      const expanded = detail.classList.toggle('expanded')
      toggleBtn.classList.toggle('expanded', expanded)
      toggleBtn.setAttribute('aria-expanded', expanded ? 'true' : 'false')
    }
  })

  entries.forEach(entry => {
    const startBtn = document.getElementById('startWorkoutBtn-' + entry.day.id)
    if (startBtn) startBtn.addEventListener('click', function() { startWorkout(entry, dateStr) })

    const summaryBtn = document.getElementById('viewSummaryBtn-' + entry.day.id)
    if (summaryBtn) summaryBtn.addEventListener('click', function() {
      renderWorkoutSummary(completedSessionsByDayId[entry.day.id], entry)
    })

    const moveBtn = document.getElementById('moveWorkoutBtn-' + entry.day.id)
    if (moveBtn) moveBtn.addEventListener('click', function() { openMoveWorkoutModal(entry.day.id, dateStr) })
  })

  forms.forEach(fa => {
    const fillBtn = document.getElementById('formFillBtn-' + fa.id)
    if (fillBtn) fillBtn.addEventListener('click', function() { renderFormFill(fa, dateStr) })
  })
}

// ---- Assigned form preview card (Fill Out / View Answers) ----
function renderFormPreviewCard(fa, dateStr) {
  const done = !!fa.completed_at
  const formName = fa.forms ? fa.forms.name : 'Form'
  return `
    <div class="detail-group">
      <div class="day-preview-group-header">
        <h4 class="detail-group-title">${escapeHtml(formName)}</h4>
        ${done ? '<span class="workout-type-badge workout-type-badge-field">Completed</span>' : ''}
      </div>
      ${!done && fa.forms && fa.forms.gate_workout ? '<p class="form-gate-notice"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4"></path><path d="M12 17h.01"></path><path d="M10.29 3.86l-8.18 14.18A2 2 0 0 0 4 21h16a2 2 0 0 0 1.89-2.96L13.71 3.86a2 2 0 0 0-3.42 0z"></path></svg> Completing this unlocks today\'s workout</p>' : ''}
      <button type="button" class="start-workout-btn" id="formFillBtn-${fa.id}">${done ? 'View Answers' : 'Fill Out Form'}</button>
    </div>
  `
}

// ==========================================================================
// ---- MOVE WORKOUT (reschedule a day, gated by athlete.can_reschedule_workouts) ----
// Sets program_days.date_override, which every dateStr-resolving query in
// this app (loadTrainingData here, plus the coach's own calendar/Overview/
// PDF report) checks first, ahead of the normal start_date + week_number +
// day_number computation - see resolveDate()'s call site above.
// ==========================================================================
let moveWorkoutDayId = null

function openMoveWorkoutModal(dayId, currentDateStr) {
  moveWorkoutDayId = dayId
  document.getElementById('moveWorkoutDateInput').value = currentDateStr
  document.getElementById('moveWorkoutModal').classList.add('active')
}

// Move Workout modal buttons. Called once from dashboard.js at startup.
export function wireMoveWorkoutModal() {
  document.getElementById('closeMoveWorkoutBtn').addEventListener('click', function() {
    document.getElementById('moveWorkoutModal').classList.remove('active')
  })

  document.getElementById('cancelMoveWorkoutBtn').addEventListener('click', function() {
    document.getElementById('moveWorkoutModal').classList.remove('active')
  })

  document.getElementById('saveMoveWorkoutBtn').addEventListener('click', async function() {
    const newDate = document.getElementById('moveWorkoutDateInput').value
    if (!newDate) { customAlert('Please pick a date'); return }

    // moved_by_athlete puts the "Moved by athlete" badge on the coach's
    // calendar (see sql-history.sql). PGRST204 = that column isn't
    // installed yet: move the day without it.
    const move = (fields) => saveWithRetry((signal) => supabase
      .from('program_days')
      .update(fields)
      .eq('id', moveWorkoutDayId)
      .abortSignal(signal)
    )
    let { error } = await move({ date_override: newDate, moved_by_athlete: true })
    if (error && error.code === 'PGRST204') ({ error } = await move({ date_override: newDate }))

    if (error) { console.log(error); customAlert('Something went wrong moving this workout'); return }

    document.getElementById('moveWorkoutModal').classList.remove('active')
    await loadTrainingData()
    renderWeekView(startOfWeek(parseDateStr(newDate)))
  })
}

// Log a bodyweight entry from the Log Weight tile on Home - writes straight
// to the same `bodyweight` table the coach's "Log weight" button uses (see
// athlete-detail/overview.js's bindBodyweightEvents), so it shows up identically on
// both sides. Always stored in kg, typed in whatever unit the athlete has
// picked in Profile > Weight units.
export function openLogWeightModal() {
  document.getElementById('logWeightDate').valueAsDate = new Date()
  document.getElementById('logWeightValue').value = ''
  document.getElementById('logWeightUnitLabel').textContent = athlete.weight_unit || 'kg'
  document.getElementById('logWeightModal').classList.add('active')
}

// Log Weight modal buttons. Called once from dashboard.js at startup.
export function wireLogWeightModal() {
  document.getElementById('closeLogWeightBtn').addEventListener('click', function() {
    document.getElementById('logWeightModal').classList.remove('active')
  })

  document.getElementById('cancelLogWeightBtn').addEventListener('click', function() {
    document.getElementById('logWeightModal').classList.remove('active')
  })

  document.getElementById('saveLogWeightBtn').addEventListener('click', async function() {
    const date = document.getElementById('logWeightDate').value
    const rawWeight = parseFloat(document.getElementById('logWeightValue').value)
    if (!date || !rawWeight) { customAlert('Please fill in date and weight'); return }
    const weight = weightToKg(rawWeight, athlete.weight_unit)

    // bodyweight ids are numbers the database assigns, so a retry looks for
    // this same entry (athlete, date, weight) instead of an id
    const { error } = await insertOnce('bodyweight', { athlete_id: athlete.id, date, weight }, { matchOn: ['athlete_id', 'date', 'weight'] })

    if (error) { console.log(error); customAlert('Something went wrong saving that - try again'); return }

    document.getElementById('logWeightModal').classList.remove('active')
    await loadLatestBodyweight()
    renderWeekView(currentWeekStart)
  })
}
