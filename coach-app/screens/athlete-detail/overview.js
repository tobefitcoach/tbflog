// ==========================================================================
// ATHLETE DETAIL - Overview tab
// Completion / volume / training-load stats, recent activity, notes,
// bodyweight, and the % change explanation popup.
// ==========================================================================
import { supabase } from '../../../coachClient.js?v=__V__'
import * as nav from '../../nav.js?v=__V__'
import { loadChartJs } from '../../vendor.js?v=__V__'
import { escapeHtml } from '../../../escape.js?v=__V__'
import { toDateStr, parseDateStr, addDays, startOfWeek } from '../../../shared/dates.js?v=__V__'
import { root, mountToken, athleteId, currentAthlete, ov } from './state.js?v=__V__'
import { convertValue } from './metrics.js?v=__V__'
import { fetchAllRows, runOnce } from '../../../shared/fetch-all.js?v=__V__'

// ==========================================================================
// ---- OVERVIEW STATS: completion rate + volume ----
// Computed from this athlete's schedule (programs -> ... -> program_exercises)
// and their logged exercise_log_sets. Same nested-query shape and date math
// athlete-calendar.js/dashboard.js use, duplicated here since this screen
// (like every other one) has no shared scope with those.
// ==========================================================================

export function resolveDateOv(startDateStr, weekNumber, dayNumber) {
  const start = parseDateStr(startDateStr)
  const result = new Date(start)
  result.setDate(result.getDate() + (weekNumber - 1) * 7 + (dayNumber - 1))
  return toDateStr(result)
}

function daysBetweenDateStrsOv(a, b) {
  const [ay, am, ad] = a.split('-').map(Number)
  const [by, bm, bd] = b.split('-').map(Number)
  return Math.round((new Date(by, bm - 1, bd) - new Date(ay, am - 1, ad)) / 86400000)
}

// Weight x reps for one logged set - 0 if incomplete, unweighted, or the
// reps didn't parse as a plain number (duration text, unedited "8-12" ranges)
export function setVolumeOv(s) {
  if (!s.completed_at || s.actual_weight == null) return 0
  const reps = parseInt(s.actual_reps)
  return isNaN(reps) ? 0 : reps * s.actual_weight
}

// Same is_adhoc/label fallback used everywhere else a training's display
// name is derived (calendar/grid.js's trainingDisplayName, the athlete app)
function trainingDisplayNameOv(program, day) {
  if (program.is_adhoc) return program.name || 'Workout'
  return day.label || ('Day ' + day.day_number)
}

export function formatDurationOv(minutes) {
  if (minutes < 60) return `${minutes}m`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m === 0 ? `${h}h` : `${h}h ${m}m`
}

export async function loadOverviewStatsGuarded() {
  if (ov.overviewLoadInFlight) return
  ov.overviewLoadInFlight = true
  try {
    await Promise.all([loadOverviewStats(), loadRecentActivity()])
  } finally {
    ov.overviewLoadInFlight = false
  }
}

export async function loadOverviewStats() {
  const ninetyDaysAgo = toDateStr(addDays(new Date(), -89))
  const ninetyDaysAgoISO = addDays(new Date(), -89).toISOString()
  const token = mountToken

  // These 3 queries don't depend on each other's results, so they fire
  // together instead of waiting on each other one at a time - this alone
  // cuts this tab's load time roughly in half to a third. Each also goes
  // through window.fetchWithRetry so a slow/flaky connection gets a couple
  // of automatic retries instead of these stats just staying blank with no
  // explanation.
  const [
    { data: programs, error: programsError },
    { data: logSets, error: logError },
    { data: sessions, error: sessionsError }
  ] = await Promise.all([
    fetchAllRows(window.fetchWithRetry, () => supabase
      .from('programs')
      .select('*, program_weeks(*, program_days(*, program_exercises(*, exercises!exercise_id(tracks_weight))))')
      .eq('athlete_id', athleteId)
      .eq('is_template', false)
    ),
    fetchAllRows(window.fetchWithRetry, () => supabase
      .from('exercise_log_sets')
      .select('*')
      .eq('athlete_id', athleteId)
      .gte('date', ninetyDaysAgo)
    ),
    fetchAllRows(window.fetchWithRetry, () => supabase
      .from('workout_sessions')
      .select('*')
      .eq('athlete_id', athleteId)
      .not('ended_at', 'is', null)
      .gte('started_at', ninetyDaysAgoISO)
      .order('started_at', { ascending: false })
    )
  ])

  if (!nav.isCurrent(token)) return
  if (programsError) { console.log('Error loading schedule for stats:', programsError); customAlert('Something went wrong loading this athlete\'s stats - check your connection and try again'); return }
  if (logError) { console.log('Error loading logged sets for stats:', logError); customAlert('Something went wrong loading this athlete\'s stats - check your connection and try again'); return }
  if (sessionsError) { console.log('Error loading sessions for stats:', sessionsError); customAlert('Something went wrong loading this athlete\'s stats - check your connection and try again'); return }
  if (!root) return

  // One entry per program_days row - i.e. per workout, not per calendar
  // date. Two workouts landing on the same date (an assigned program day
  // plus an ad-hoc training, say) stay separate here so completion rate
  // counts them as two workouts, not one merged day. dayInfoById remembers
  // each workout's date + display name so a workout_sessions row (which
  // only has a program_day_id) can be labeled in the duration list below.
  const workoutEntries = [] // { dateStr, exercises }
  const dayInfoById = {}
  // Every program_exercise whose underlying exercise tracks weight - volume
  // only makes sense for weight-bearing sets, so it's scoped to just these
  // (tracks_weight is independent of Timed/Plyometric now, so a weighted
  // timed hold still counts, but a bodyweight-only exercise doesn't)
  const weightsPEIds = new Set()
  for (const program of programs) {
    for (const week of program.program_weeks) {
      for (const day of week.program_days) {
        const dateStr = day.date_override || resolveDateOv(program.start_date, week.week_number, day.day_number)
        workoutEntries.push({ dateStr, exercises: day.program_exercises })
        dayInfoById[day.id] = { dateStr, name: trainingDisplayNameOv(program, day) }
        for (const pe of day.program_exercises) {
          // A per-instance "Adjust Fields" override (Workout Builder) wins
          // over the exercise's own tracks_weight default when present
          const tracksWeight = pe.tracks_weight_override != null ? pe.tracks_weight_override : !!(pe.exercises && pe.exercises.tracks_weight)
          if (tracksWeight) weightsPEIds.add(pe.id)
        }
      }
    }
  }

  const logSetsByPE = {}
  for (const row of logSets) {
    if (!logSetsByPE[row.program_exercise_id]) logSetsByPE[row.program_exercise_id] = []
    logSetsByPE[row.program_exercise_id].push(row)
  }

  // ---- Completion rate: scheduled workouts where at least half the
  // prescribed sets got logged, divided by scheduled workouts in the
  // window - counted per workout (per program_days row), not per calendar
  // date, so a day with two separate trainings counts as two, not one.
  // Set-level within a workout (not "every exercise finished") so 2 fully
  // done exercises plus 1 barely started still gets fair partial credit.
  // Workouts with no exercises don't count toward either side. Today's
  // workout(s) only count once actually done - the day isn't over yet, so
  // an unfinished/not-yet-started workout scheduled for today shouldn't
  // drag the rate down as if it had been missed.
  function completionRate(windowDays) {
    const cutoff = toDateStr(addDays(new Date(), -(windowDays - 1)))
    const todayStr = toDateStr(new Date())
    let scheduled = 0
    let completed = 0

    for (const entry of workoutEntries) {
      if (entry.dateStr < cutoff || entry.dateStr > todayStr) continue
      if (entry.exercises.length === 0) continue

      let totalSets = 0
      let doneSets = 0
      for (const pe of entry.exercises) {
        const prescribed = pe.prescribed_sets || 1
        totalSets += prescribed
        const logged = (logSetsByPE[pe.id] || []).filter(s => s.completed_at && s.set_number <= prescribed)
        doneSets += Math.min(logged.length, prescribed)
      }
      const workoutDone = totalSets > 0 && (doneSets / totalSets) >= 0.5
      if (entry.dateStr === todayStr && !workoutDone) continue

      scheduled++
      if (workoutDone) completed++
    }

    return scheduled === 0 ? null : Math.round((completed / scheduled) * 100)
  }

  const rate30 = completionRate(30)
  const rate60 = completionRate(60)
  const rate90 = completionRate(90)

  root.querySelector('#statCompletion').textContent = rate30 === null ? '—' : `${rate30}%`
  root.querySelector('#statCompletion30').textContent = rate30 === null ? '—' : `${rate30}%`
  root.querySelector('#statCompletion60').textContent = rate60 === null ? '—' : `${rate60}%`
  root.querySelector('#statCompletion90').textContent = rate90 === null ? '—' : `${rate90}%`

  // ---- Volume (weights exercises only - see weightsPEIds above) ----
  const sevenDaysAgo = toDateStr(addDays(new Date(), -6))
  const volume7d = logSets
    .filter(s => s.date >= sevenDaysAgo && weightsPEIds.has(s.program_exercise_id))
    .reduce((sum, s) => sum + setVolumeOv(s), 0)

  root.querySelector('#statVolume').textContent = `${Math.round(volume7d).toLocaleString()}kg`

  // Weekly buckets for the trend chart, oldest of the last 12 weeks first
  const weeklyVolume = {} // 'YYYY-MM-DD' (week start) -> kg
  for (const s of logSets) {
    if (!weightsPEIds.has(s.program_exercise_id)) continue
    const weekStart = toDateStr(startOfWeek(parseDateStr(s.date)))
    weeklyVolume[weekStart] = (weeklyVolume[weekStart] || 0) + setVolumeOv(s)
  }

  const labels = []
  const values = []
  const currentWeekStart = startOfWeek(new Date())
  for (let i = 11; i >= 0; i--) {
    const weekStart = addDays(currentWeekStart, -7 * i)
    labels.push(weekStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }))
    values.push(Math.round(weeklyVolume[toDateStr(weekStart)] || 0))
  }
  ov.volumeChartData = { labels, values }

  // ---- Duration: completed workout_sessions rows only (still-open sessions
  // have no ended_at yet, nothing to measure) ----
  ov.durationEvents = sessions.map(s => {
    const info = dayInfoById[s.program_day_id]
    const minutes = Math.round((new Date(s.ended_at) - new Date(s.started_at)) / 60000)
    return { dateStr: info ? info.dateStr : s.local_date, name: info ? info.name : 'Workout', minutes }
  })

  const thirtyDaysAgo = toDateStr(addDays(new Date(), -29))
  const recentDurations = ov.durationEvents.filter(e => e.dateStr >= thirtyDaysAgo).map(e => e.minutes)
  const avgMinutes = recentDurations.length
    ? Math.round(recentDurations.reduce((sum, m) => sum + m, 0) / recentDurations.length)
    : null

  root.querySelector('#statDuration').textContent = avgMinutes === null ? '—' : formatDurationOv(avgMinutes)

  // ---- Training Load (Foster's session-RPE method: RPE x duration) ----
  // sessions already covers a 90-day window with session_rpe included
  // (select('*') above) - no extra query needed.
  const dailyLoad = {} // dateStr -> summed session_load that day
  for (const s of sessions) {
    if (s.session_rpe == null) continue // no rating entered - excluded, not treated as 0
    const dateStr = s.local_date
    const minutes = (new Date(s.ended_at) - new Date(s.started_at)) / 60000
    dailyLoad[dateStr] = (dailyLoad[dateStr] || 0) + s.session_rpe * minutes
  }

  function loadSum(days) {
    const cutoff = toDateStr(addDays(new Date(), -(days - 1)))
    const todayStr = toDateStr(new Date())
    return Object.entries(dailyLoad)
      .filter(([d]) => d >= cutoff && d <= todayStr)
      .reduce((sum, [, v]) => sum + v, 0)
  }

  // ACWR only means something once there's a real 4-week baseline to compare
  // against - with less than 28 days of rated-session history, loadSum(28)/4
  // divides a partial sum by 4 as if a full chronic period had passed,
  // understating the baseline and inflating the ratio. Held back as "—"
  // until enough history exists, rather than showing a falsely high number.
  const loadDates = Object.keys(dailyLoad).sort()
  ov.daysOfLoadHistoryValue = loadDates.length ? daysBetweenDateStrsOv(loadDates[0], toDateStr(new Date())) + 1 : 0
  const hasEnoughHistoryForAcwr = ov.daysOfLoadHistoryValue >= 28

  ov.acuteLoadValue = loadSum(7)
  ov.chronicLoadValue = hasEnoughHistoryForAcwr ? loadSum(28) / 4 : 0
  ov.acwrValue = (hasEnoughHistoryForAcwr && ov.chronicLoadValue > 0) ? ov.acuteLoadValue / ov.chronicLoadValue : null
  const highRisk = ov.acwrValue !== null && ov.acwrValue > 1.5

  // Rest days count as 0, not skipped - monotony measures variation across
  // the whole week, and a rest day lowering it is the entire point
  ov.last7DailyLoad = []
  for (let i = 6; i >= 0; i--) {
    const dateStr = toDateStr(addDays(new Date(), -i))
    ov.last7DailyLoad.push({ dateStr, load: dailyLoad[dateStr] || 0 })
  }
  const mean7 = ov.last7DailyLoad.reduce((sum, d) => sum + d.load, 0) / 7
  const stddev7 = Math.sqrt(ov.last7DailyLoad.reduce((sum, d) => sum + (d.load - mean7) ** 2, 0) / 7)
  ov.monotonyValue = stddev7 > 0 ? mean7 / stddev7 : null
  ov.strainValue = ov.monotonyValue !== null ? ov.acuteLoadValue * ov.monotonyValue : null

  root.querySelector('#statWeeklyLoad').textContent = ov.acuteLoadValue > 0 ? Math.round(ov.acuteLoadValue).toLocaleString() : '—'
  root.querySelector('#statAcwr').textContent = ov.acwrValue === null ? '—' : ov.acwrValue.toFixed(2)
  const acwrRiskBadge = root.querySelector('#statAcwrRisk')
  if (highRisk) {
    acwrRiskBadge.textContent = 'High Risk'
    acwrRiskBadge.className = 'stat-risk-badge'
    acwrRiskBadge.style.display = 'inline-block'
  } else if (!hasEnoughHistoryForAcwr && loadDates.length > 0) {
    acwrRiskBadge.textContent = 'Building History'
    acwrRiskBadge.className = 'stat-risk-badge neutral'
    acwrRiskBadge.style.display = 'inline-block'
  } else {
    acwrRiskBadge.style.display = 'none'
  }
  root.querySelector('#statMonotony').textContent = ov.monotonyValue === null ? '—' : ov.monotonyValue.toFixed(2)
  root.querySelector('#statStrain').textContent = ov.strainValue === null ? '—' : Math.round(ov.strainValue).toLocaleString()

  renderPainReports(sessions, dayInfoById)

  const updatedLabel = root.querySelector('#overviewUpdatedLabel')
  if (updatedLabel) updatedLabel.textContent = 'Updated ' + new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

// The Overview tab's pain/injury inbox - unreviewed reports only (see
// wireRpeFlagFollowup in athlete-app/workout/swipe.js for how these get set).
// Reuses the same 90-day `sessions` fetch loadOverviewStats already made -
// no extra query. Known limitation, same as every other stat on this tab:
// a report older than that window with no coach visit in the meantime
// ages out of this list silently.
function renderPainReports(sessions, dayInfoById) {
  const section = root.querySelector('#painReportsSection')
  const list = root.querySelector('#painReportsList')
  const reports = sessions.filter(s => s.rpe_flag_reason === 'pain_injury' && !s.rpe_flag_reviewed_at)

  if (reports.length === 0) {
    section.style.display = 'none'
    return
  }

  section.style.display = 'block'
  list.innerHTML = reports.map(s => {
    const info = dayInfoById[s.program_day_id]
    const dateStr = info ? info.dateStr : s.local_date
    const name = info ? info.name : 'Workout'
    return `
      <div class="pain-report-row">
        <div class="pain-report-meta">${formatDisplayDate(dateStr)} — ${escapeHtml(name)} · RPE ${s.session_rpe}/10</div>
        <p class="pain-report-note">${escapeHtml(s.rpe_flag_note) || '<em>No description given</em>'}</p>
        <button type="button" class="unit-btn pain-report-review-btn" data-session-id="${s.id}">Mark Reviewed</button>
      </div>
    `
  }).join('')

  list.querySelectorAll('.pain-report-review-btn').forEach(btn => {
    btn.addEventListener('click', async function() {
      const row = btn.closest('.pain-report-row')
      btn.disabled = true
      btn.textContent = 'Marking...'

      const { error } = await supabase
        .from('workout_sessions')
        .update({ rpe_flag_reviewed_at: new Date().toISOString() })
        .eq('id', btn.dataset.sessionId)

      if (error) {
        console.log(error)
        customAlert('Something went wrong - please try again')
        btn.disabled = false
        btn.textContent = 'Mark Reviewed'
        return
      }

      row.remove()
      if (list.children.length === 0) section.style.display = 'none'
    })
  })
}

export function bindOverviewEvents() {
  root.querySelector('#editAthleteBtn').addEventListener('click', function() {
    const data = currentAthlete
    root.querySelector('#editAthleteName').value = data.name
    root.querySelector('#editAthleteDOB').value = data.date_of_birth
    root.querySelector('#editAthleteGender').value = data.gender
    root.querySelector('#editAthleteHeight').value = data.height
    root.querySelector('#editAthleteEmail').value = data.email || ''
    root.querySelector('#editAthleteModal').classList.add('active')
  })

  root.querySelector('#refreshOverviewBtn').addEventListener('click', function() {
    loadOverviewStatsGuarded()
  })

  root.querySelector('#statDurationCard').addEventListener('click', function() {
    root.querySelector('#durationDetailModal').classList.add('active')
    renderDurationModal()
  })
  root.querySelector('#closeDurationModalBtn').addEventListener('click', function() {
    root.querySelector('#durationDetailModal').classList.remove('active')
  })

  root.querySelector('#statCompletionCard').addEventListener('click', function() {
    root.querySelector('#completionDetailModal').classList.add('active')
  })
  root.querySelector('#closeCompletionModalBtn').addEventListener('click', function() {
    root.querySelector('#completionDetailModal').classList.remove('active')
  })

  // Chart.js sizes its canvas from rendered pixel dimensions, so it's only
  // drawn once the modal is actually visible - same reasoning as the
  // Metrics tab's lazy chart loading. await loadChartJs() here means a
  // coach who opens this modal without ever visiting Metrics/Calendar still
  // triggers the Chart.js fetch - see this file's top banner comment.
  root.querySelector('#statVolumeCard').addEventListener('click', async function() {
    root.querySelector('#volumeDetailModal').classList.add('active')

    const canvas = root.querySelector('#volumeChart')
    const noDataMsg = root.querySelector('#noVolumeMsg')
    const hasData = ov.volumeChartData.values.some(v => v > 0)

    if (!hasData) {
      canvas.style.display = 'none'
      noDataMsg.style.display = 'block'
      return
    }

    canvas.style.display = 'block'
    noDataMsg.style.display = 'none'

    await loadChartJs()
    if (!root) return

    if (ov.volumeChart) ov.volumeChart.destroy()

    ov.volumeChart = new Chart(canvas, {
      type: 'bar',
      data: {
        labels: ov.volumeChartData.labels,
        datasets: [{
          data: ov.volumeChartData.values,
          backgroundColor: '#4a4a8e'
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { color: '#aaaacc', font: { size: 10 } }, grid: { display: false } },
          y: { ticks: { color: '#aaaacc', font: { size: 10 } }, grid: { color: '#2a2a4e' } }
        }
      }
    })
  })

  root.querySelector('#closeVolumeModalBtn').addEventListener('click', function() {
    root.querySelector('#volumeDetailModal').classList.remove('active')
  })

  // ---- Training Load modals ----
  root.querySelector('#statWeeklyLoadCard').addEventListener('click', function() {
    root.querySelector('#weeklyLoadDetailModal').classList.add('active')
    renderWeeklyLoadModal()
  })
  root.querySelector('#closeWeeklyLoadModalBtn').addEventListener('click', function() {
    root.querySelector('#weeklyLoadDetailModal').classList.remove('active')
  })

  root.querySelector('#statAcwrCard').addEventListener('click', function() {
    root.querySelector('#acwrDetailModal').classList.add('active')
    root.querySelector('#statAcuteLoad').textContent = ov.acuteLoadValue > 0 ? Math.round(ov.acuteLoadValue).toLocaleString() : '—'
    root.querySelector('#statChronicLoad').textContent = ov.chronicLoadValue > 0 ? Math.round(ov.chronicLoadValue).toLocaleString() : '—'
    root.querySelector('#statAcwrDetail').textContent = ov.acwrValue === null ? '—' : ov.acwrValue.toFixed(2)
    const acwrNote = root.querySelector('#acwrInsufficientNote')
    if (ov.acwrValue === null && ov.daysOfLoadHistoryValue > 0 && ov.daysOfLoadHistoryValue < 28) {
      acwrNote.textContent = `Needs 28 days of rated training history to calculate a reliable ratio — ${ov.daysOfLoadHistoryValue} day${ov.daysOfLoadHistoryValue === 1 ? '' : 's'} so far.`
      acwrNote.style.display = 'block'
    } else {
      acwrNote.style.display = 'none'
    }
  })
  root.querySelector('#closeAcwrModalBtn').addEventListener('click', function() {
    root.querySelector('#acwrDetailModal').classList.remove('active')
  })

  root.querySelector('#statMonotonyCard').addEventListener('click', function() {
    root.querySelector('#monotonyDetailModal').classList.add('active')
  })
  root.querySelector('#closeMonotonyModalBtn').addEventListener('click', function() {
    root.querySelector('#monotonyDetailModal').classList.remove('active')
  })

  root.querySelector('#statStrainCard').addEventListener('click', function() {
    root.querySelector('#strainDetailModal').classList.add('active')
  })
  root.querySelector('#closeStrainModalBtn').addEventListener('click', function() {
    root.querySelector('#strainDetailModal').classList.remove('active')
  })
}

function renderWeeklyLoadModal() {
  const container = root.querySelector('#weeklyLoadList')
  container.innerHTML = `
    <ul class="detail-list">
      ${ov.last7DailyLoad.map(d => `
        <li class="detail-row">
          <span>${d.dateStr}</span>
          <span class="detail-row-value">${d.load > 0 ? Math.round(d.load).toLocaleString() : '—'}</span>
        </li>
      `).join('')}
    </ul>
  `
}

function renderDurationModal() {
  const container = root.querySelector('#durationList')

  if (ov.durationEvents.length === 0) {
    container.innerHTML = '<p style="color:#aaaacc;text-align:center;padding:20px">No completed workouts logged yet</p>'
    return
  }

  container.innerHTML = `
    <ul class="detail-list">
      ${ov.durationEvents.map(e => `
        <li class="detail-row">
          <span>${e.dateStr} — ${escapeHtml(e.name)}</span>
          <span class="detail-row-value">${formatDurationOv(e.minutes)}</span>
        </li>
      `).join('')}
    </ul>
  `
}

// ==========================================================================
// ---- RECENT ACTIVITY ----
// Last 5 things this athlete has done, merged from 3 otherwise-unrelated
// tables (there's no single activity-log table) - tournaments added, own
// workouts started, and workouts (incl. mobility sessions) completed. Each
// query is capped at 5 and independently the most recent of its own kind,
// so merging+sorting client-side and slicing the top 5 overall can never
// miss a genuinely-recent event in favor of a stale one from another table.
// ==========================================================================
function formatActivityDate(iso) {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export async function loadRecentActivity() {
  const token = mountToken
  const list = root.querySelector('#recentActivityList')

  const [
    { data: tournaments, error: tournamentsError },
    { data: ownPrograms, error: programsError },
    { data: sessions, error: sessionsError }
  ] = await Promise.all([
    window.fetchWithRetry((signal) => supabase
      .from('tournaments')
      .select('id, name, created_at')
      .eq('athlete_id', athleteId)
      .order('created_at', { ascending: false })
      .limit(5)
      .abortSignal(signal)
    ),
    window.fetchWithRetry((signal) => supabase
      .from('programs')
      .select('id, name, created_at')
      .eq('athlete_id', athleteId)
      .eq('created_by_athlete', true)
      .order('created_at', { ascending: false })
      .limit(5)
      .abortSignal(signal)
    ),
    window.fetchWithRetry((signal) => supabase
      .from('workout_sessions')
      .select('id, ended_at, session_type, program_days(day_number, label, program_weeks(programs(name, is_adhoc)))')
      .eq('athlete_id', athleteId)
      .not('ended_at', 'is', null)
      .order('ended_at', { ascending: false })
      .limit(5)
      .abortSignal(signal)
    )
  ])

  if (!nav.isCurrent(token)) return

  if (tournamentsError || programsError || sessionsError) {
    console.log('Error loading recent activity:', tournamentsError || programsError || sessionsError)
    list.innerHTML = '<p class="no-metrics">Something went wrong loading recent activity</p>'
    return
  }

  const trophyIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="7"></circle><polyline points="8.21 13.89 7 23 12 20 17 23 15.79 13.88"></polyline></svg>'
  const dumbbellIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="4" cy="12" r="2"></circle><circle cx="20" cy="12" r="2"></circle><line x1="6" y1="12" x2="18" y2="12"></line><line x1="9" y1="8" x2="9" y2="16"></line><line x1="15" y1="8" x2="15" y2="16"></line></svg>'
  const mobilityIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="4" r="2"></circle><path d="M12 6v6"></path><path d="M8 8l4 2 4-2"></path><path d="M9 20l3-6 3 6"></path></svg>'
  const checkIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>'

  const events = []
  for (const t of tournaments) {
    events.push({ at: t.created_at, icon: trophyIcon, text: `Added a tournament: ${escapeHtml(t.name)}` })
  }
  for (const p of ownPrograms) {
    events.push({ at: p.created_at, icon: dumbbellIcon, text: `Added their own workout${p.name ? ': ' + escapeHtml(p.name) : ''}` })
  }
  for (const s of sessions) {
    if (s.session_type === 'mobility') {
      events.push({ at: s.ended_at, icon: mobilityIcon, text: 'Completed a mobility session' })
      continue
    }
    const day = s.program_days
    const program = day && day.program_weeks && day.program_weeks.programs
    const name = program ? trainingDisplayNameOv(program, day) : 'a workout'
    events.push({ at: s.ended_at, icon: checkIcon, text: `Completed a workout: ${escapeHtml(name)}` })
  }

  events.sort((a, b) => b.at.localeCompare(a.at))
  const recent = events.slice(0, 5)

  list.innerHTML = recent.length === 0
    ? '<p class="no-metrics">No activity yet</p>'
    : recent.map(e => `
        <div class="activity-row">
          <span class="activity-icon-chip">${e.icon}</span>
          <span class="activity-text">${e.text}</span>
          <span class="activity-date">${formatActivityDate(e.at)}</span>
        </div>
      `).join('')
}

// ==========================================================================
// ---- ATHLETE NOTES ----
// Dated notes log: each "Add" creates a new row in athlete_notes (never
// overwrites), so past notes stay visible with the date they were written.
// Mirrors the Bodyweight pattern - a "latest entry" preview in the header,
// full history + edit/delete in the "View all" modal.
// (ov.currentNoteEntry lives in state.js)
// ==========================================================================

// Formats a stored 'YYYY-MM-DD' date string as e.g. "Jul 23, 2026"
export function formatDisplayDate(dateStr) {
  return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

// Shows the single most recent note in the profile header
export async function loadLatestNote() {
  const token = mountToken
  const { data } = await supabase
    .from('athlete_notes')
    .select('*')
    .eq('athlete_id', athleteId)
    .order('date', { ascending: false })
    .limit(1)

  if (!nav.isCurrent(token)) return
  const preview = root.querySelector('#latestNotePreview')

  if (!data || data.length === 0) {
    preview.classList.add('no-notes')
    preview.innerHTML = '<p class="no-bodyweight-data">No notes yet</p>'
    return
  }

  const latest = data[0]
  preview.classList.remove('no-notes')
  preview.innerHTML = `
    <p class="latest-note-date">${formatDisplayDate(latest.date)}</p>
    <p class="latest-note-text">${latest.note}</p>
  `
}

// Fetches and renders every note for this athlete, newest first
async function loadNotesList() {
  const token = mountToken
  const { data } = await supabase
    .from('athlete_notes')
    .select('*')
    .eq('athlete_id', athleteId)
    .order('date', { ascending: false })

  if (!nav.isCurrent(token)) return
  const list = root.querySelector('#notesList')

  if (!data || data.length === 0) {
    list.innerHTML = '<p style="color:#aaaacc;text-align:center;padding:20px">No notes yet</p>'
    return
  }

  list.innerHTML = data.map(n => `
    <div class="note-entry">
      <div class="note-entry-header">
        <span class="note-entry-date">${formatDisplayDate(n.date)}</span>
        <div>
          <button class="btn-edit-entry" data-note-id="${n.id}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg></button>
          <button class="btn-delete-measurement" data-note-id="${n.id}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg></button>
        </div>
      </div>
      <p class="note-entry-text">${n.note}</p>
    </div>
  `).join('')

  list.querySelectorAll('.btn-edit-entry').forEach(btn => {
    btn.addEventListener('click', function() {
      const noteId = parseInt(this.dataset.noteId)
      ov.currentNoteEntry = data.find(n => n.id === noteId)
      root.querySelector('#editNoteDate').value = ov.currentNoteEntry.date
      root.querySelector('#editNoteText').value = ov.currentNoteEntry.note
      root.querySelector('#editNoteModal').classList.add('active')
    })
  })

  list.querySelectorAll('.btn-delete-measurement').forEach(btn => {
    btn.addEventListener('click', async function() {
      const noteId = parseInt(this.dataset.noteId)
      if (!(await customConfirm('Delete this note?'))) return

      const { error } = await supabase
        .from('athlete_notes')
        .delete()
        .eq('id', noteId)

      if (error) { customAlert('Something went wrong'); return }

      loadNotesList()
      loadLatestNote()
    })
  })
}

export function bindNotesEvents() {
  root.querySelector('#addNoteBtn').addEventListener('click', function() {
    root.querySelector('#noteDate').valueAsDate = new Date()
    root.querySelector('#noteText').value = ''
    root.querySelector('#addNoteModal').classList.add('active')
  })

  root.querySelector('#closeAddNoteBtn').addEventListener('click', function() {
    root.querySelector('#addNoteModal').classList.remove('active')
  })

  root.querySelector('#cancelAddNoteBtn').addEventListener('click', function() {
    root.querySelector('#addNoteModal').classList.remove('active')
  })

  root.querySelector('#saveNoteBtn').addEventListener('click', async function() {
    const date = root.querySelector('#noteDate').value
    const note = root.querySelector('#noteText').value.trim()

    if (!date || !note) { customAlert('Please fill in date and note'); return }

    const { error } = await supabase
      .from('athlete_notes')
      .insert([{ athlete_id: parseInt(athleteId), date, note }])

    if (error) { console.log(error); customAlert('Something went wrong'); return }

    root.querySelector('#addNoteModal').classList.remove('active')
    loadLatestNote()
  })

  root.querySelector('#viewNotesBtn').addEventListener('click', function() {
    root.querySelector('#notesListModal').classList.add('active')
    loadNotesList()
  })

  root.querySelector('#closeNotesListBtn').addEventListener('click', function() {
    root.querySelector('#notesListModal').classList.remove('active')
  })

  root.querySelector('#cancelEditNoteBtn').addEventListener('click', function() {
    root.querySelector('#editNoteModal').classList.remove('active')
  })

  root.querySelector('#saveEditNoteBtn').addEventListener('click', async function() {
    const date = root.querySelector('#editNoteDate').value
    const note = root.querySelector('#editNoteText').value.trim()

    if (!date || !note) { customAlert('Please fill in date and note'); return }

    const { error } = await supabase
      .from('athlete_notes')
      .update({ date, note })
      .eq('id', ov.currentNoteEntry.id)

    if (error) { customAlert('Something went wrong'); return }

    root.querySelector('#editNoteModal').classList.remove('active')
    loadNotesList()
    loadLatestNote()
  })
}

// ==========================================================================
// ---- BODYWEIGHT ----
// Loads and draws the bodyweight trend chart on the profile header, and
// handles logging a new bodyweight entry.
// ==========================================================================
export async function loadBodyweightGraph() {
  const token = mountToken
  const { data, error } = await fetchAllRows(runOnce, () => supabase
    .from('bodyweight')
    .select('*')
    .eq('athlete_id', athleteId)
    .order('date', { ascending: true })
  )

  if (!nav.isCurrent(token)) return
  const canvas = root.querySelector('#bodyweightGraph')
  const noDataMsg = root.querySelector('#noBodyweightMsg')

  if (!data || data.length === 0) {
    canvas.style.display = 'none'
    noDataMsg.style.display = 'block'
    return
  }

  noDataMsg.style.display = 'none'
  canvas.style.display = 'block'

  await loadChartJs()
  if (!nav.isCurrent(token)) return

  if (ov.bodyweightChart) ov.bodyweightChart.destroy()

  ov.bodyweightChart = new Chart(canvas, {
    type: 'line',
    data: {
      labels: data.map(d => d.date),
      datasets: [{
        // Convert stored kg values to lbs on the fly if the user has lbs selected
        data: data.map(d => ov.bodyweightUnit === 'kg' ? d.weight : +(d.weight * 2.20462).toFixed(1)),
        borderColor: '#4a4a8e',
        backgroundColor: 'rgba(74, 74, 142, 0.1)',
        borderWidth: 2,
        pointRadius: 3,
        tension: 0.3,
        fill: true
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { display: false },
        y: {
          ticks: { color: '#aaaacc', font: { size: 10 } },
          grid: { color: '#2a2a4e' }
        }
      }
    }
  })
}

// ---- Bodyweight logging, kg/lbs toggle, and Bodyweight Entries history ----
// (mirrors the metric ENTRIES MODAL above, but for the bodyweight table).
// Values are always stored in kg - bodyweightUnit only changes how they're shown.
export function bindBodyweightEvents() {
  root.querySelector('#addBodyweightBtn').addEventListener('click', function() {
    root.querySelector('#bodyweightDate').valueAsDate = new Date()
    root.querySelector('#bodyweightModal').classList.add('active')
  })

  root.querySelector('#closeBodyweightBtn').addEventListener('click', function() {
    root.querySelector('#bodyweightModal').classList.remove('active')
  })

  root.querySelector('#cancelBodyweightBtn').addEventListener('click', function() {
    root.querySelector('#bodyweightModal').classList.remove('active')
  })

  // Saves a new bodyweight entry; always stores in kg regardless of input unit
  root.querySelector('#saveBodyweightBtn').addEventListener('click', async function() {
    const date = root.querySelector('#bodyweightDate').value
    const rawWeight = parseFloat(root.querySelector('#bodyweightValue').value)
    const inputUnit = root.querySelector('#bodyweightInputUnit').value
    const weight = inputUnit === 'lbs' ? +(rawWeight / 2.20462).toFixed(2) : rawWeight
    const notes = root.querySelector('#bodyweightNotes').value

    if (!date || !weight) { customAlert('Please fill in date and weight'); return }

    const { error } = await supabase
      .from('bodyweight')
      .insert([{ athlete_id: parseInt(athleteId), date, weight, notes }])

    if (error) { console.log(error); customAlert('Something went wrong'); return }

    root.querySelector('#bodyweightModal').classList.remove('active')
    root.querySelector('#bodyweightValue').value = ''
    root.querySelector('#bodyweightNotes').value = ''
    loadBodyweightGraph()
  })

  root.querySelector('#bwKgBtn').addEventListener('click', function() {
    ov.bodyweightUnit = 'kg'
    root.querySelector('#bwKgBtn').classList.add('active')
    root.querySelector('#bwLbsBtn').classList.remove('active')
    loadBodyweightGraph()
  })

  root.querySelector('#bwLbsBtn').addEventListener('click', function() {
    ov.bodyweightUnit = 'lbs'
    root.querySelector('#bwLbsBtn').classList.add('active')
    root.querySelector('#bwKgBtn').classList.remove('active')
    loadBodyweightGraph()
  })

  root.querySelector('#viewBWEntriesBtn').addEventListener('click', function() {
    root.querySelector('#bwEntriesModal').classList.add('active')
    loadBWEntries()
  })

  root.querySelector('#closeBWEntriesBtn').addEventListener('click', function() {
    root.querySelector('#bwEntriesModal').classList.remove('active')
  })

  root.querySelector('#cancelEditBWBtn').addEventListener('click', function() {
    root.querySelector('#editBWEntryModal').classList.remove('active')
  })

  root.querySelector('#saveEditBWBtn').addEventListener('click', async function() {
    const date = root.querySelector('#editBWDate').value
    const rawWeight = parseFloat(root.querySelector('#editBWValue').value)
    const unit = root.querySelector('#editBWUnit').value
    const weight = unit === 'lbs' ? +(rawWeight / 2.20462).toFixed(2) : rawWeight
    const notes = root.querySelector('#editBWNotes').value

    if (!date || !weight) { customAlert('Please fill in date and weight'); return }

    const { error } = await supabase
      .from('bodyweight')
      .update({ date, weight, notes })
      .eq('id', ov.currentBWEntry.id)

    if (error) { customAlert('Something went wrong'); return }

    root.querySelector('#editBWEntryModal').classList.remove('active')
    loadBWEntries()
    loadBodyweightGraph()
  })
}

async function loadBWEntries() {
  const token = mountToken
  const { data, error } = await fetchAllRows(runOnce, () => supabase
    .from('bodyweight')
    .select('*')
    .eq('athlete_id', athleteId)
    .order('date', { ascending: false })
  )

  if (!nav.isCurrent(token)) return
  const list = root.querySelector('#bwEntriesList')

  if (!data || data.length === 0) {
    list.innerHTML = '<p style="color:#aaaacc;text-align:center;padding:20px">No entries yet</p>'
    return
  }

  list.innerHTML = `
    <table class="entries-table">
      <thead>
        <tr>
          <th>Date</th>
          <th>Weight</th>
          <th>Notes</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${data.map(m => `
          <tr>
            <td>${m.date}</td>
            <td>${ov.bodyweightUnit === 'lbs' ? +(m.weight * 2.20462).toFixed(1) + ' lbs' : m.weight + ' kg'}</td>
            <td>${m.notes || '—'}</td>
            <td>
              <button class="btn-edit-entry" data-entry-id="${m.id}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg></button>
              <button class="btn-delete-measurement" data-entry-id="${m.id}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg></button>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `

  list.querySelectorAll('.btn-delete-measurement').forEach(btn => {
    btn.addEventListener('click', async function() {
      const entryId = parseInt(this.dataset.entryId)
      if (!(await customConfirm('Delete this entry?'))) return

      const { error } = await supabase
        .from('bodyweight')
        .delete()
        .eq('id', entryId)

      if (error) { customAlert('Something went wrong'); return }

      loadBWEntries()
      loadBodyweightGraph()
    })
  })

  list.querySelectorAll('.btn-edit-entry').forEach(btn => {
    btn.addEventListener('click', function() {
      const entryId = parseInt(this.dataset.entryId)
      ov.currentBWEntry = data.find(m => m.id === entryId)
      root.querySelector('#editBWDate').value = ov.currentBWEntry.date
      root.querySelector('#editBWValue').value = ov.currentBWEntry.weight
      root.querySelector('#editBWUnit').value = 'kg'
      root.querySelector('#editBWNotes').value = ov.currentBWEntry.notes || ''
      root.querySelector('#editBWEntryModal').classList.add('active')
    })
  })
}

// ==========================================================================
// ---- % CHANGE EXPLANATION ----
// Opens a small modal that explains how the ▲/▼ % change badge on a metric
// card was calculated (which numbers were compared and why).
// ==========================================================================
export function openChangeExplain(el) {
  const type = el.dataset.explainType
  const metricName = el.dataset.metricName
  const pct = parseFloat(el.dataset.pct)
  const higher = el.dataset.higher === 'true'
  const isPositive = higher ? pct > 0 : pct < 0
  const cssClass = pct === 0 ? 'neutral' : isPositive ? 'positive' : 'negative'
  const arrow = pct > 0 ? '▲' : '▼'

  root.querySelector('#changeExplainTitle').textContent = `${metricName} — Change Breakdown`

  let content = ''

  if (type === 'zone2') {
    // Zone2 breakdown: last-30-days avg vs previous-30-days avg
    const avg30 = parseFloat(el.dataset.avg30)
    const avgPrev = parseFloat(el.dataset.avgprev)
    content = `
      <div class="change-explain-row">
        <span class="change-explain-label">Last 30 days avg score</span>
        <span class="change-explain-value">${avg30}</span>
      </div>
      <div class="change-explain-row">
        <span class="change-explain-label">Previous 30 days avg score</span>
        <span class="change-explain-value">${avgPrev}</span>
      </div>
      <div class="change-explain-result metric-change ${cssClass}">
        ${arrow} ${Math.abs(pct)}% change in efficiency
      </div>
      <p style="color:#aaaacc; font-size:12px; margin-top:12px; text-align:center">
        Score = 1000 ÷ (pace × BPM) — higher is better
      </p>
    `
  } else if (type === 'period') {
    // Full graph modal breakdown: for a fixed window (1M/3M/6M/1Y), compares
    // that period's avg to the same-length period right before it. "All" has
    // no equivalent "previous" period, so it falls back to an earlier-half
    // vs recent-half split of the whole history instead.
    const periodLabel = el.dataset.periodLabel
    const isAllTime = periodLabel === 'All'
    const previousAvg = parseFloat(el.dataset.firstAvg)
    const currentAvg = parseFloat(el.dataset.secondAvg)
    const unit = el.dataset.unit
    const isPogo = el.dataset.metricType === 'pogo'
    const isZone2 = el.dataset.metricType === 'zone2'

    const formatVal = v => isZone2 || isPogo ? v : `${convertValue(v, unit).text} ${convertValue(v, unit).unit}`.trim()
    const valueLabel = isZone2 ? 'score' : isPogo ? 'RSI' : 'value'
    const previousLabel = isAllTime ? `Earlier half avg ${valueLabel}` : `Previous ${periodLabel} avg ${valueLabel}`
    const currentLabel = isAllTime ? `Recent half avg ${valueLabel}` : `This ${periodLabel} avg ${valueLabel}`

    content = `
      <div class="change-explain-row">
        <span class="change-explain-label">${previousLabel}</span>
        <span class="change-explain-value">${formatVal(previousAvg)}</span>
      </div>
      <div class="change-explain-row">
        <span class="change-explain-label">${currentLabel}</span>
        <span class="change-explain-value">${formatVal(currentAvg)}</span>
      </div>
      <div class="change-explain-result metric-change ${cssClass}">
        ${arrow} ${Math.abs(pct)}% within the ${periodLabel} view
      </div>
      <p style="color:#aaaacc; font-size:12px; margin-top:12px; text-align:center">
        ${isAllTime
          ? 'All time has no earlier equivalent period, so this compares the earlier half of the athlete’s history to the more recent half.'
          : `Compares the selected ${periodLabel} period to the ${periodLabel} right before it.`}
        Change the time filter above to see a different range.
        ${higher ? ' Higher is better for this metric.' : ' Lower is better for this metric.'}
      </p>
    `
  } else {
    // Simple/pogo breakdown: latest entry vs avg of previous 5 entries
    const latest = parseFloat(el.dataset.latest)
    const avgPrev = parseFloat(el.dataset.avgprev)
    const unit = el.dataset.unit
    const isPogo = el.dataset.metricType === 'pogo'

    const convertedLatest = isPogo ? { text: latest, unit: '' } : convertValue(latest, unit)
    const convertedAvg = isPogo ? { text: avgPrev, unit: '' } : convertValue(avgPrev, unit)
    const displayLatest = `${convertedLatest.text} ${convertedLatest.unit}`.trim()
    const displayAvg = `${convertedAvg.text} ${convertedAvg.unit}`.trim()
    const valueLabel = isPogo ? 'RSI Score' : 'Latest entry'
    const avgLabel = isPogo ? 'Avg RSI of previous 5 entries' : 'Avg of previous 5 entries'

    content = `
      <div class="change-explain-row">
        <span class="change-explain-label">${valueLabel}</span>
        <span class="change-explain-value">${displayLatest}</span>
      </div>
      <div class="change-explain-row">
        <span class="change-explain-label">${avgLabel}</span>
        <span class="change-explain-value">${displayAvg}</span>
      </div>
      <div class="change-explain-result metric-change ${cssClass}">
        ${arrow} ${Math.abs(pct)}% vs previous 5 entries
      </div>
      <p style="color:#aaaacc; font-size:12px; margin-top:12px; text-align:center">
        ${higher ? 'Higher is better for this metric' : 'Lower is better for this metric'}
      </p>
    `
  }

  root.querySelector('#changeExplainContent').innerHTML = content
  root.querySelector('#changeExplainModal').classList.add('active')
}

export function bindChangeExplainEvents() {
  root.querySelector('#closeChangeExplainBtn').addEventListener('click', function() {
    root.querySelector('#changeExplainModal').classList.remove('active')
  })
}
