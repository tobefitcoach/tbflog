// ==========================================================================
// ATHLETE DETAIL - calendar: month grid
// Date helpers, live-linked workout refresh, loading and painting the month
// grid, drag-to-move, and the per-badge actions (view / copy / delete).
// ==========================================================================
import { supabase } from '../../../../coachClient.js?v=__V__'
import * as nav from '../../../nav.js?v=__V__'
import { escapeHtml } from '../../../../escape.js?v=__V__'
import { toDateStr, parseDateStr } from '../../../../shared/dates.js?v=__V__'
import { applyFieldOverrides } from '../../../../shared/exercise-fields.js?v=__V__'
import { root, mountToken, athleteId, cal } from '../state.js?v=__V__'
import { openDayAddTrainingModal } from './add-day.js?v=__V__'
import { armCopyWorkout, armMoveWorkout } from './copy.js?v=__V__'
import { deleteFormAssignment, deleteMobilitySession, deleteTraining, openFormDetailModal, openMobilityDetailModal, openTournamentDetailModal, openWorkoutDetailModal } from './day-modal.js?v=__V__'
import { fetchAllRows, fetchAllRowsForIds } from '../../../../shared/fetch-all.js?v=__V__'
import { fetchScheduleRange } from '../../../../shared/schedule-range.js?v=__V__'

// ==========================================================================
// ---- CALENDAR TAB: DATE HELPERS ----
// Same timezone-safe parsing convention as formatDisplayDate() in the
// Overview/Notes half (new Date(dateStr + 'T00:00:00')) - building
// YYYY-MM-DD strings by hand rather than via .toISOString(), which
// re-introduces an off-by-one bug for local dates.
// ==========================================================================

export function formatDisplayDateCal(dateStr) {
  return parseDateStr(dateStr).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' })
}

export function formatShortDateCal(dateStr) {
  return parseDateStr(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

// All the calendar-day dates a tournament covers, inclusive of both ends -
// a single-day tournament (date === end_date) is just a one-element range
function eachDateStrInRangeCal(startStr, endStr) {
  const dates = []
  const cursor = parseDateStr(startStr)
  while (toDateStr(cursor) <= endStr) {
    dates.push(toDateStr(cursor))
    cursor.setDate(cursor.getDate() + 1)
  }
  return dates
}

export function resolveDate(startDateStr, weekNumber, dayNumber) {
  const start = parseDateStr(startDateStr)
  const result = new Date(start)
  result.setDate(result.getDate() + (weekNumber - 1) * 7 + (dayNumber - 1))
  return toDateStr(result)
}

export const WORKOUT_TYPE_LABELS_CAL = { gym: 'Gym', field: 'Field', run: 'Run' }

export function trainingDisplayName(entry) {
  if (entry.program.is_adhoc) return entry.program.name || 'Training'
  return entry.day.label || ('Day ' + entry.day.day_number)
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

// Same 1-5 scale/anchors as TOURNAMENT_IMPORTANCE_DESCRIPTIONS in the
// athlete app's dashboard.js (where the athlete picks their own rating) -
// duplicated here, and used both to display an athlete-added tournament's
// rating and for the coach's own picker when adding one (Tournament tab).
export const TOURNAMENT_IMPORTANCE_DESCRIPTIONS_CAL = {
  1: 'Not important at all - just for fun or experience',
  2: 'Low priority - a tune-up event',
  3: 'Moderately important - worth some focused prep',
  4: 'Important - a key event this season',
  5: 'Most important tournament of the year - tapering needed'
}

// ==========================================================================
// ---- LIVE-LINKED WORKOUTS ----
// A day still tracking a Workout Library Training (source_training_id set -
// see the LIVE-LINKED WORKOUTS block in sql-history.sql) gets refreshed
// here, right after the main load below and before anything renders, so
// the calendar always reflects the coach's latest Workout Builder edit for
// any day not yet started. sync_live_training_days does the actual work
// server-side; this just re-fetches whichever days it touched, once. Same
// helper, duplicated, as athlete-app/data.js's syncLiveTrainingDays.
// ==========================================================================
async function syncLiveTrainingDaysCal(programs) {
  const linkedDayIds = []
  for (const program of programs) {
    for (const week of program.program_weeks) {
      for (const day of week.program_days) {
        if (day.source_training_id) linkedDayIds.push(day.id)
      }
    }
  }
  if (linkedDayIds.length === 0) return

  const { error: syncError } = await window.fetchWithRetry((signal) => supabase.rpc('sync_live_training_days', { p_day_ids: linkedDayIds }).abortSignal(signal))
  if (syncError) { console.log('Error syncing live-linked days:', syncError); return }

  // In batches - the day ids go into the request URL, and the list grows
  // with every live-linked day the athlete has ever had
  const { data: freshExercises, error: fetchError } = await fetchAllRowsForIds(window.fetchWithRetry, linkedDayIds, (batch) => supabase
    .from('program_exercises')
    .select('*, exercises!exercise_id(name, category, type, video_url, tracks_reps, tracks_weight, is_timed, is_unilateral, tracks_distance)')
    .in('day_id', batch)
  )
  if (fetchError) { console.log('Error refreshing synced days:', fetchError); return }

  const freshByDayId = {}
  for (const pe of freshExercises) { (freshByDayId[pe.day_id] ||= []).push(pe) }

  for (const program of programs) {
    for (const week of program.program_weeks) {
      for (const day of week.program_days) {
        if (day.source_training_id && freshByDayId[day.id]) {
          day.program_exercises = freshByDayId[day.id]
        }
      }
    }
  }
}

// ==========================================================================
// ---- LOAD + RENDER MONTH GRID ----
// Only the 6 weeks the grid shows are loaded for a month, not the athlete's
// whole history (see athlete_schedule_range in sql-history.sql). Each month
// loaded is remembered in cal.monthCache for a couple of minutes, and the
// months either side load in the background, so Prev/Next is usually
// instant. Any other reload (after an add/copy/move/delete) forgets every
// remembered month first, since an edit can touch more than the one shown.
// Until the SQL function is installed, each month falls back to the old
// download of everything.
// ==========================================================================
const MONTH_CACHE_MS = 2 * 60 * 1000
let rangeFunctionMissing = false

// The grid always shows 42 days starting on the Monday on/before the 1st -
// see renderCalendarGrid
function gridRange(year, month) {
  const startWeekday = (new Date(year, month, 1).getDay() + 6) % 7
  return { from: toDateStr(new Date(year, month, 1 - startWeekday)), to: toDateStr(new Date(year, month, 42 - startWeekday)) }
}

async function fetchMonthData(id, from, to) {
  const [schedule, { data: tournaments, error: tournamentsError }, { data: formAssignments, error: formAssignmentsError }] = await Promise.all([
    rangeFunctionMissing ? { missing: true } : fetchScheduleRange(supabase, window.fetchWithRetry, id, from, to),
    fetchAllRows(window.fetchWithRetry, () => supabase
      .from('tournaments')
      .select('*')
      .eq('athlete_id', id)
      .lte('date', to)
      .gte('end_date', from)
    ),
    fetchAllRows((factory) => window.fetchWithRetry(factory, 1), () => supabase
      .from('form_assignments')
      .select('*, forms(name, gate_workout), form_answers(id)')
      .eq('athlete_id', id)
      .gte('date', from)
      .lte('date', to)
    )
  ])
  if (tournamentsError) console.log('Error loading tournaments for calendar:', tournamentsError)
  if (formAssignmentsError) console.log('Error loading form assignments for calendar:', formAssignmentsError)

  let { programs, logSets, sessions } = schedule
  if (schedule.missing) {
    if (!rangeFunctionMissing) console.log('athlete_schedule_range is not installed yet - run it from sql-history.sql. Loading full history instead.')
    rangeFunctionMissing = true
    const [
      { data, error },
      { data: allSessions, error: sessionsError },
      { data: allSets, error: logSetsError }
    ] = await Promise.all([
      fetchAllRows(window.fetchWithRetry, () => supabase
        .from('programs')
        .select('*, program_weeks(*, program_days(*, program_exercises(*, exercises!exercise_id(name, category, type, video_url, tracks_reps, tracks_weight, is_timed, is_unilateral, tracks_distance))))')
        .eq('athlete_id', id)
        .eq('is_template', false)
      ),
      fetchAllRows(window.fetchWithRetry, () => supabase
        .from('workout_sessions')
        .select('*') // '*' (not a column list) so athlete_note comes through once its migration has run, without breaking this query before then
        .eq('athlete_id', id)
      ),
      fetchAllRows(window.fetchWithRetry, () => supabase
        .from('exercise_log_sets')
        .select('*')
        .eq('athlete_id', id)
      )
    ])
    if (error) return { error }
    if (sessionsError) console.log('Error loading sessions for calendar:', sessionsError)
    if (logSetsError) console.log('Error loading logged sets for calendar:', logSetsError)
    programs = data
    sessions = allSessions || []
    logSets = allSets || []
  } else if (schedule.error) {
    return { error: schedule.error }
  }

  await syncLiveTrainingDaysCal(programs)

  // A coach-added tournament carries no rating on its own row (the athlete
  // can read that row) - the coach's private rating is in
  // tournament_coach_ratings. Fetched separately, and only when there's
  // something to look up, so a problem there (or the table not existing
  // yet) can't take the athlete's own tournaments off the calendar.
  const coachAddedTournaments = (tournaments || []).filter(t => t.created_by_coach)
  if (coachAddedTournaments.length > 0) {
    const { data: ratings, error: ratingsError } = await window.fetchWithRetry((signal) => supabase
      .from('tournament_coach_ratings')
      .select('tournament_id, importance')
      .in('tournament_id', coachAddedTournaments.map(t => t.id))
      .abortSignal(signal), 1
    )
    if (ratingsError) console.log('Error loading tournament ratings:', ratingsError)
    const ratingById = Object.fromEntries((ratings || []).map(r => [r.tournament_id, r.importance]))
    for (const t of coachAddedTournaments) t.importance = ratingById[t.id] ?? null
  }

  return { programs, logSets, sessions, tournaments: tournaments || [], formAssignments: formAssignments || [] }
}

// The month's data, from cal.monthCache when it's fresh. The promise goes
// into the cache straight away, so clicking onto a month whose background
// load is still running waits for that one instead of asking twice.
function fetchMonth(year, month) {
  const key = `${year}-${month}`
  const hit = cal.monthCache[key]
  if (hit && Date.now() - hit.at < MONTH_CACHE_MS) return hit.promise
  const { from, to } = gridRange(year, month)
  const promise = fetchMonthData(athleteId, from, to)
  const cache = cal.monthCache
  cache[key] = { at: Date.now(), promise }
  promise.then(result => { if (result.error && cache[key]?.promise === promise) delete cache[key] })
  return promise
}

// fromCache: only Prev/Next pass it - every other caller is reloading
// because something just changed
export async function loadCalendarMonth(year, month, { fromCache = false } = {}) {
  const token = mountToken
  root.querySelector('#calMonthLabel').textContent = `${MONTH_NAMES[month]} ${year}`
  if (!fromCache) cal.monthCache = {}

  const monthData = await fetchMonth(year, month)
  if (!nav.isCurrent(token)) return
  // Clicked on to another month while this one loaded - that load paints instead
  if (cal.currentViewYear !== year || cal.currentViewMonth !== month) return
  if (monthData.error) { console.log('Error loading calendar:', monthData.error); customAlert('Something went wrong loading the calendar - check your connection and try again'); return }

  const { programs, logSets, sessions, tournaments, formAssignments } = monthData

  cal.tournamentsByDateCal = {}
  for (const t of tournaments) {
    for (const dateStr of eachDateStrInRangeCal(t.date, t.end_date)) cal.tournamentsByDateCal[dateStr] = t
  }

  cal.formAssignmentsByDateCal = {}
  for (const fa of formAssignments) {
    (cal.formAssignmentsByDateCal[fa.date] ||= []).push(fa)
  }

  cal.calendarEntriesByDate = {}
  for (const program of programs) {
    for (const week of program.program_weeks) {
      for (const day of week.program_days) {
        day.program_exercises.forEach(applyFieldOverrides)
        const dateStr = day.date_override || resolveDate(program.start_date, week.week_number, day.day_number)
        if (!cal.calendarEntriesByDate[dateStr]) cal.calendarEntriesByDate[dateStr] = []
        cal.calendarEntriesByDate[dateStr].push({ program, week, day })
      }
    }
  }

  // A day can in theory have more than one session (e.g. the athlete started
  // it, it got abandoned, and they started again later) - in-progress always
  // wins if any session is still open, otherwise the most recently ended one
  // decides "done"
  cal.sessionByDayId = {}
  cal.mobilityEntriesByDateCal = {}
  for (const s of sessions) {
    if (s.session_type === 'mobility') {
      cal.mobilityEntriesByDateCal[s.local_date] = s
      continue
    }
    if (!s.ended_at) {
      cal.sessionByDayId[s.program_day_id] = s
      continue
    }
    const existing = cal.sessionByDayId[s.program_day_id]
    if (existing && !existing.ended_at) continue
    if (!existing || new Date(s.ended_at) > new Date(existing.ended_at)) {
      cal.sessionByDayId[s.program_day_id] = s
    }
  }

  cal.logSetsByPECal = {}
  for (const row of logSets) {
    if (!cal.logSetsByPECal[row.program_exercise_id]) cal.logSetsByPECal[row.program_exercise_id] = []
    cal.logSetsByPECal[row.program_exercise_id].push(row)
  }
  for (const peId in cal.logSetsByPECal) {
    cal.logSetsByPECal[peId].sort((a, b) => a.set_number - b.set_number)
  }

  renderCalendarGrid(year, month)

  // Get the months either side ready for Prev/Next (failures are just
  // forgotten - the click will try again)
  fetchMonth(month === 0 ? year - 1 : year, (month + 11) % 12)
  fetchMonth(month === 11 ? year + 1 : year, (month + 1) % 12)
}

export function renderCalendarGrid(year, month) {
  const grid = root.querySelector('#calendarGrid')
  // getDay() is 0=Sun..6=Sat - remapped so the grid's rows start on Monday
  // instead (0=Mon..6=Sun), matching the athlete's own week view
  const startWeekday = (new Date(year, month, 1).getDay() + 6) % 7
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const prevMonthDays = new Date(year, month, 0).getDate()

  const cells = []
  for (let i = startWeekday - 1; i >= 0; i--) {
    cells.push({ date: new Date(year, month - 1, prevMonthDays - i), outside: true })
  }
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ date: new Date(year, month, d), outside: false })
  }
  let nextMonthDay = 1
  while (cells.length < 42) {
    cells.push({ date: new Date(year, month + 1, nextMonthDay), outside: true })
    nextMonthDay++
  }

  const todayStr = toDateStr(new Date())

  let html = ''
  cells.forEach((cell, i) => {
    // Rows always start on Monday (see startWeekday above), so the row's
    // own first cell IS that week's Monday - one small copy icon per row,
    // in its own gutter column to the left of the 7 day columns (see the
    // #calendarGrid/#calendarWeekdayHeader grid-template-columns overrides
    // in app.css). Clicking it arms week-copy, see wireCalendarCopyArming.
    if (i % 7 === 0) {
      const weekMonday = toDateStr(cell.date)
      html += `<div class="calendar-week-gutter-cell"><button type="button" class="calendar-week-copy-btn" data-action="arm-copy-week" data-week-monday="${weekMonday}" title="Copy this week">⧉</button></div>`
    }
    const weekMonday = toDateStr(cells[i - (i % 7)].date)
    html += renderCalendarDayCell(cell, weekMonday, todayStr)
  })
  grid.innerHTML = html

  // The cell background itself is not clickable - with two workouts back
  // to back it was never clear which one you'd land on. Only a specific
  // badge/dot opens anything (see wireCalendarBadgeKebabs' view-workout/
  // view-mobility/view-tournament handling below).
  grid.querySelectorAll('.calendar-day-add-btn').forEach(btn => {
    btn.addEventListener('click', function(e) {
      e.stopPropagation()
      cal.adHocDayIdForThisSession = null
      cal.adHocDayDateForThisSession = null
      openDayAddTrainingModal(btn.dataset.date)
    })
  })
}

function renderCalendarDayCell(cell, weekMonday, todayStr) {
    const dateStr = toDateStr(cell.date)
    const entries = cal.calendarEntriesByDate[dateStr] || []
    // One badge per training (keyed by day.id, always unique - two different
    // trainings that happen to share a display name used to incorrectly
    // collapse into one badge here). Color shows where it's at: blue for
    // planned (no session yet), orange while the athlete's in the middle of
    // it, green once they've finished it.
    const badges = [...new Map(entries.map(entry => [entry.day.id, entry])).values()]
    const mobility = cal.mobilityEntriesByDateCal[dateStr]
    const tournament = cal.tournamentsByDateCal[dateStr]

    const classes = ['calendar-day']
    if (cell.outside) classes.push('calendar-day-outside')
    if (dateStr === todayStr) classes.push('calendar-day-today')

    // One shared list of "what's on this day", rendered two ways: small
    // fixed-size dots (phone-width screens - a busy day used to blow the
    // cell's height or width out showing one full-name badge per item, see
    // git history) and full-name badges (desktop, where a column is wide
    // enough that showing real names is more useful than a dot). CSS picks
    // which one is visible per viewport width - see .calendar-day-dots/
    // .calendar-day-badges in app.css. Clicking a specific badge/dot opens
    // that ONE item's own detail modal (view-workout/view-mobility/
    // view-tournament, see wireCalendarBadgeKebabs) - the day cell's blank
    // background does nothing.
    const items = badges.map(entry => {
      const session = cal.sessionByDayId[entry.day.id]
      const status = session ? (session.ended_at ? 'done' : 'in-progress') : 'planned'
      const glyph = status === 'done' ? '✓' : (status === 'in-progress' ? '▶' : '')
      // dayId marks this as a real, draggable workout with its own kebab
      // menu (copy/delete, see the badgesHtml build below) - tournament
      // items never get one (nothing to delete/copy from the calendar),
      // mobility gets a delete-only kebab (see mobilitySessionId below)
      // Small colored dot (not part of the escaped label text, since it's
      // real markup) - status is already the badge's background color, so
      // type gets its own separate marker instead of competing for it
      const typeDot = entry.day.workout_type ? `<span class="workout-type-dot workout-type-dot-${entry.day.workout_type}"></span>` : ''
      // Still tracking a Workout Library Training (see the LIVE-LINKED
      // WORKOUTS block in sql-history.sql) - a small dot in the compact
      // dot-only view, the full "Live" pill where there's room for it
      // (desktop badge row and the Workout Builder heading itself).
      const liveDot = entry.day.source_training_id ? '<span class="live-link-dot" title="Still tracking its Workout Library Training - editing that workout updates this day automatically, until it\'s started or hand-edited"></span>' : ''
      return { status, glyph, typeDot, liveDot, label: trainingDisplayName(entry), dayId: entry.day.id, programId: entry.program.id, isAdhoc: entry.program.is_adhoc }
    })
    if (mobility) items.push({ status: 'mobility', glyph: '', label: 'Mobility', mobilitySessionId: mobility.id })
    if (tournament) items.push({ status: 'tournament', glyph: '', label: tournament.name, importance: tournament.importance })
    for (const fa of (cal.formAssignmentsByDateCal[dateStr] || [])) {
      items.push({ status: fa.completed_at ? 'done' : 'form', glyph: fa.completed_at ? '✓' : '', label: (fa.forms ? fa.forms.name : 'Form'), formAssignmentId: fa.id })
    }

    const visibleItems = items.slice(0, 4)
    const extraCount = items.length - visibleItems.length
    // Real workouts (dayId set) get copy+delete, mobility (mobilitySessionId
    // set) gets delete only - no "copy" makes sense for a logged mobility
    // session - and tournament/"+N more" stay plain with no menu at all.
    // Dots (mobile) trigger the same kebab by tapping the dot itself, since
    // there's no room for a separate ⋮ button at this size - see
    // wireCalendarBadgeKebabs, which handles any [data-action] element
    // generically so this needed no JS changes beyond the markup.
    const dotsHtml = visibleItems.map(it => {
      if (it.dayId) {
        const deleteAttrs = it.isAdhoc
          ? `data-mode="adhoc" data-program-id="${it.programId}" data-program-day-id="${it.dayId}"`
          : `data-mode="day" data-program-day-id="${it.dayId}"`
        return `
          <div class="kebab-menu calendar-dot-kebab">
            <span class="calendar-day-dot calendar-day-dot-${it.status}" data-action="toggle-kebab">${it.glyph}</span>
            <div class="kebab-dropdown">
              <button type="button" class="kebab-item" data-action="view-workout" data-program-day-id="${it.dayId}" data-date="${dateStr}">View Workout</button>
              <button type="button" class="kebab-item" data-action="copy-training" data-program-day-id="${it.dayId}" data-name="${escapeHtml(it.label)}">Copy to another day</button>
              <button type="button" class="kebab-item" data-action="move-training" data-program-day-id="${it.dayId}" data-name="${escapeHtml(it.label)}">Move to another day</button>
              <button type="button" class="kebab-item" data-action="delete-training" ${deleteAttrs}>Delete Workout</button>
            </div>
          </div>
        `
      }
      if (it.mobilitySessionId) {
        return `
          <div class="kebab-menu calendar-dot-kebab">
            <span class="calendar-day-dot calendar-day-dot-${it.status}" data-action="toggle-kebab">${it.glyph}</span>
            <div class="kebab-dropdown">
              <button type="button" class="kebab-item" data-action="view-mobility" data-date="${dateStr}">View Mobility</button>
              <button type="button" class="kebab-item" data-action="delete-mobility" data-session-id="${it.mobilitySessionId}">Delete Mobility Session</button>
            </div>
          </div>
        `
      }
      if (it.formAssignmentId) {
        return `
          <div class="kebab-menu calendar-dot-kebab">
            <span class="calendar-day-dot calendar-day-dot-${it.status}" data-action="toggle-kebab">${it.glyph}</span>
            <div class="kebab-dropdown">
              <button type="button" class="kebab-item" data-action="view-form" data-assignment-id="${it.formAssignmentId}">View Form</button>
              <button type="button" class="kebab-item" data-action="delete-form" data-assignment-id="${it.formAssignmentId}">Delete Form</button>
            </div>
          </div>
        `
      }
      return `<span class="calendar-day-dot calendar-day-dot-${it.status}" data-action="view-tournament" data-date="${dateStr}" title="${it.importance != null ? `Importance ${it.importance}/5` : 'Tournament'}">${it.importance != null ? it.importance : it.glyph}</span>`
    }).join('')
      + (extraCount > 0 ? `<span class="calendar-day-dot calendar-day-dot-more">+${extraCount}</span>` : '')
    const badgesHtml = visibleItems.map(it => {
      if (it.dayId) {
        const deleteAttrs = it.isAdhoc
          ? `data-mode="adhoc" data-program-id="${it.programId}" data-program-day-id="${it.dayId}"`
          : `data-mode="day" data-program-day-id="${it.dayId}"`
        return `
          <div class="calendar-day-badge-row">
            <span class="calendar-day-badge calendar-day-badge-${it.status}" draggable="true" data-day-id="${it.dayId}" data-action="view-workout" data-date="${dateStr}">${it.typeDot || ''}${it.glyph ? it.glyph + ' ' : ''}${escapeHtml(it.label)}${it.liveDot || ''}</span>
            <div class="kebab-menu calendar-badge-kebab">
              <button type="button" class="kebab-btn" data-action="toggle-kebab">⋮</button>
              <div class="kebab-dropdown">
                <button type="button" class="kebab-item" data-action="copy-training" data-program-day-id="${it.dayId}" data-name="${escapeHtml(it.label)}">Copy to another day</button>
                <button type="button" class="kebab-item" data-action="move-training" data-program-day-id="${it.dayId}" data-name="${escapeHtml(it.label)}">Move to another day</button>
                <button type="button" class="kebab-item" data-action="delete-training" ${deleteAttrs}>Delete Workout</button>
              </div>
            </div>
          </div>
        `
      }
      if (it.mobilitySessionId) {
        return `
          <div class="calendar-day-badge-row">
            <span class="calendar-day-badge calendar-day-badge-${it.status}" data-action="view-mobility" data-date="${dateStr}">${escapeHtml(it.label)}</span>
            <div class="kebab-menu calendar-badge-kebab">
              <button type="button" class="kebab-btn" data-action="toggle-kebab">⋮</button>
              <div class="kebab-dropdown">
                <button type="button" class="kebab-item" data-action="delete-mobility" data-session-id="${it.mobilitySessionId}">Delete Mobility Session</button>
              </div>
            </div>
          </div>
        `
      }
      if (it.formAssignmentId) {
        return `
          <div class="calendar-day-badge-row">
            <span class="calendar-day-badge calendar-day-badge-${it.status}" data-action="view-form" data-assignment-id="${it.formAssignmentId}">${it.glyph ? it.glyph + ' ' : ''}${escapeHtml(it.label)}</span>
            <div class="kebab-menu calendar-badge-kebab">
              <button type="button" class="kebab-btn" data-action="toggle-kebab">⋮</button>
              <div class="kebab-dropdown">
                <button type="button" class="kebab-item" data-action="delete-form" data-assignment-id="${it.formAssignmentId}">Delete Form</button>
              </div>
            </div>
          </div>
        `
      }
      return `<span class="calendar-day-badge calendar-day-badge-${it.status}" data-action="view-tournament" data-date="${dateStr}" title="${it.importance != null ? `Importance ${it.importance}/5` : 'Tournament'}">${it.importance != null ? `★${it.importance} ` : ''}${it.typeDot || ''}${it.glyph ? it.glyph + ' ' : ''}${escapeHtml(it.label)}</span>`
    }).join('')
      + (extraCount > 0 ? `<span class="calendar-day-badge calendar-day-badge-more">+${extraCount} more</span>` : '')

    return `
      <div class="${classes.join(' ')}" data-date="${dateStr}" data-week-monday="${weekMonday}">
        <button type="button" class="calendar-day-add-btn" data-date="${dateStr}">+</button>
        <span class="calendar-day-number">${cell.date.getDate()}</span>
        <div class="calendar-day-dots">${dotsHtml}</div>
        <div class="calendar-day-badges">${badgesHtml}</div>
      </div>
    `
}

// ==========================================================================
// ---- DRAG A WORKOUT BADGE TO A NEW DAY ----
// Desktop-only in practice - only .calendar-day-badge (hidden on mobile in
// favor of the tiny dots) carries draggable="true", and only for real
// workouts (mobility/tournament items never get a data-day-id, see
// renderCalendarGrid's items build). Wired once on the persistent
// #calendarGrid node itself (see activateCalendarTab), rather than
// per-render, since delegated listeners on a node whose children get
// replaced don't need re-attaching.
// ==========================================================================
export function wireCalendarDragToMove(grid) {
  grid.addEventListener('dragstart', function(e) {
    const badge = e.target.closest('.calendar-day-badge[draggable="true"]')
    if (!badge) return
    e.dataTransfer.setData('text/plain', badge.dataset.dayId)
    e.dataTransfer.effectAllowed = 'move'
    setTimeout(() => badge.classList.add('dragging'), 0)
  })
  grid.addEventListener('dragend', function(e) {
    const badge = e.target.closest('.calendar-day-badge')
    if (badge) badge.classList.remove('dragging')
  })
  grid.addEventListener('dragover', function(e) {
    const cell = e.target.closest('.calendar-day')
    if (!cell) return
    e.preventDefault()
    cell.classList.add('drag-over')
  })
  grid.addEventListener('dragleave', function(e) {
    const cell = e.target.closest('.calendar-day')
    if (cell) cell.classList.remove('drag-over')
  })
  grid.addEventListener('drop', async function(e) {
    const cell = e.target.closest('.calendar-day')
    if (!cell) return
    e.preventDefault()
    cell.classList.remove('drag-over')
    const dayId = e.dataTransfer.getData('text/plain')
    if (!dayId) return
    await moveWorkoutToDate(dayId, cell.dataset.date)
  })
}

export async function moveWorkoutToDate(dayId, newDateStr) {
  const token = mountToken
  // A coach move clears moved_by_athlete, so the "Moved by athlete" badge
  // only ever means the athlete did it (see sql-history.sql). PGRST204 =
  // that column isn't installed yet: move the day without it.
  let { error } = await supabase.from('program_days').update({ date_override: newDateStr, moved_by_athlete: false }).eq('id', dayId)
  if (error && error.code === 'PGRST204') ({ error } = await supabase.from('program_days').update({ date_override: newDateStr }).eq('id', dayId))
  if (!nav.isCurrent(token)) return
  if (error) { console.log(error); customAlert('Something went wrong moving that workout'); return }
  await loadCalendarMonth(cal.currentViewYear, cal.currentViewMonth)
}

// ==========================================================================
// ---- PER-BADGE/DOT ACTIONS ON THE CALENDAR GRID (view / copy / delete) ----
// View/Copy/Delete for a workout live right on its badge (desktop) or dot
// (mobile) in the month view - a coach scanning the calendar can act on a
// specific workout without first opening a combined popup for the whole
// day. Wired once on the persistent #calendarGrid node, same reasoning as
// wireCalendarDragToMove.
//
// Registered on the CAPTURE phase (the trailing `true`) so a toggle-kebab
// tap (which stopPropagation()s here) can never also register as, say, a
// drag start on the same element.
// ==========================================================================
export function wireCalendarBadgeKebabs(grid) {
  grid.addEventListener('click', function(e) {
    const btn = e.target.closest('[data-action]')
    if (!btn) return

    if (btn.dataset.action === 'toggle-kebab') {
      e.stopPropagation()
      const dropdown = btn.parentElement.querySelector('.kebab-dropdown')
      const wasActive = dropdown.classList.contains('active')
      root.querySelectorAll('#calendarGrid .kebab-dropdown.active').forEach(d => d.classList.remove('active'))
      if (!wasActive) dropdown.classList.add('active')
      return
    }

    if (btn.dataset.action === 'view-workout') {
      e.stopPropagation()
      if (btn.closest('.kebab-dropdown')) btn.closest('.kebab-dropdown').classList.remove('active')
      openWorkoutDetailModal(btn.dataset.date, btn.dataset.dayId || btn.dataset.programDayId)
      return
    }

    if (btn.dataset.action === 'view-mobility') {
      e.stopPropagation()
      if (btn.closest('.kebab-dropdown')) btn.closest('.kebab-dropdown').classList.remove('active')
      openMobilityDetailModal(btn.dataset.date)
      return
    }

    if (btn.dataset.action === 'view-tournament') {
      e.stopPropagation()
      openTournamentDetailModal(btn.dataset.date)
      return
    }

    if (btn.dataset.action === 'view-form') {
      e.stopPropagation()
      if (btn.closest('.kebab-dropdown')) btn.closest('.kebab-dropdown').classList.remove('active')
      openFormDetailModal(btn.dataset.assignmentId)
      return
    }

    if (btn.dataset.action === 'copy-training') {
      e.stopPropagation()
      btn.closest('.kebab-dropdown').classList.remove('active')
      armCopyWorkout(btn.dataset.programDayId, btn.dataset.name)
      return
    }

    if (btn.dataset.action === 'move-training') {
      e.stopPropagation()
      btn.closest('.kebab-dropdown').classList.remove('active')
      armMoveWorkout(btn.dataset.programDayId, btn.dataset.name)
      return
    }

    if (btn.dataset.action === 'delete-training') {
      e.stopPropagation()
      deleteTraining(btn.dataset.mode, btn.dataset.programId, btn.dataset.programDayId)
      return
    }

    if (btn.dataset.action === 'delete-mobility') {
      e.stopPropagation()
      deleteMobilitySession(btn.dataset.sessionId)
      return
    }

    if (btn.dataset.action === 'delete-form') {
      e.stopPropagation()
      deleteFormAssignment(btn.dataset.assignmentId)
      return
    }
  }, true)
}
