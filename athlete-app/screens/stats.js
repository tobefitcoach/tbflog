// ==========================================================================
// ATHLETE APP - Stats tab (gated by athlete.can_view_weekly_stats)
// ==========================================================================
import * as nav from '../nav.js?v=__V__'
import { escapeHtml } from '../../escape.js?v=__V__'
import { toDateStr, addDays, startOfWeek } from '../../shared/dates.js?v=__V__'
import { pageContent, athlete, coachMobilityEnabled } from '../state.js?v=__V__'
import { ensureDatesLoaded, mobilitySessionsByDate } from '../data.js?v=__V__'
import { CHEVRON_LEFT, CHEVRON_RIGHT, formatShortDate, formatWeight } from '../format.js?v=__V__'
import { computeWeekRecap } from './coach-messages.js?v=__V__'
import { computeWeekPREvents } from '../workout/prs.js?v=__V__'
import { tournamentsByDate } from './tournaments.js?v=__V__'

// ==========================================================================
// ---- WEEKLY STATS (Stats tab, gated by athlete.can_view_weekly_stats) ----
// Same underlying computeWeekRecap() as the auto-popup above, just picked
// on demand for any of the last 8 Monday-Sunday weeks instead of always
// "last week". A full-page screen like every other tab (was a modal
// originally, before the bottom nav existed) - open on a default
// selection, re-render just the body in place on each pick.
// ==========================================================================
export function renderWeeklyStats() {
  nav.enter('stats', {}, { root: true, tab: 'stats' })
  const thisMonday = startOfWeek(new Date())
  // How many weeks back from "this week" the stepper is currently showing -
  // 0..7, same 8-week window the old scrollable list offered (This Week
  // through 7 Weeks Ago), just one row instead of eight. No back button
  // here: this is a bottom-nav tab root, same as Home/Chat/Profile - the
  // nav bar is already how you leave it.
  let weeksBack = 0

  pageContent.innerHTML = `
    <div class="day-view-header">
      <h2 class="day-view-date">Stats</h2>
    </div>
    <div class="week-nav-row">
      <button class="icon-btn" id="statsWeekPrevBtn" aria-label="Previous week">${CHEVRON_LEFT}</button>
      <h3 id="statsWeekRangeLabel"></h3>
      <button class="icon-btn" id="statsWeekNextBtn" aria-label="Next week" disabled>${CHEVRON_RIGHT}</button>
    </div>
    <div id="weeklyStatsBody"></div>
  `

  function renderCurrentWeek() {
    const ws = addDays(thisMonday, -7 * weeksBack)
    document.getElementById('statsWeekRangeLabel').textContent = `${formatShortDate(ws)} – ${formatShortDate(addDays(ws, 6))}`
    document.getElementById('statsWeekPrevBtn').disabled = weeksBack >= 7
    document.getElementById('statsWeekNextBtn').disabled = weeksBack <= 0
    renderWeeklyStatsBody(ws)
  }

  document.getElementById('statsWeekPrevBtn').addEventListener('click', function() {
    if (weeksBack >= 7) return
    weeksBack++
    renderCurrentWeek()
  })
  document.getElementById('statsWeekNextBtn').addEventListener('click', function() {
    if (weeksBack <= 0) return
    weeksBack--
    renderCurrentWeek()
  })

  renderCurrentWeek()
}

// Weight-based badges (Volume/Weight/Est. 1RM) convert kg -> the athlete's
// unit and round for display, same as every other weight readout in this
// file; Reps/Sets badges are already unitless counts
export function formatPRBadgeValue(value, isWeight) {
  if (isWeight) return `${Math.round(formatWeight(value, athlete.weight_unit)).toLocaleString()}${athlete.weight_unit || 'kg'}`
  return Math.round(value).toLocaleString()
}

// PRs fill in a moment after the rest: they compare against the athlete's
// whole history, which is a database query (see computeWeekPREvents). The
// body remembers which week it's showing, so a slow answer for a week the
// athlete has already stepped away from is dropped.
async function renderWeeklyStatsBody(weekStart) {
  const body = document.getElementById('weeklyStatsBody')
  const weekKey = toDateStr(weekStart)
  const stillShowing = () => body.isConnected && body.dataset.week === weekKey
  body.dataset.week = weekKey

  // Normally a no-op - the last 8 weeks are loaded on open (see data.js)
  await ensureDatesLoaded(weekKey, toDateStr(addDays(weekStart, 6)))
  if (!stillShowing()) return

  const stats = computeWeekRecap(weekStart)
  const durationMin = Math.round(stats.totalDurationMs / 60000)
  const durationText = durationMin >= 60 ? `${Math.floor(durationMin / 60)}h ${durationMin % 60}m` : `${durationMin}m`

  const tiles = [
    { value: `${stats.scheduledCompletedCount} / ${stats.scheduledCount}`, label: 'Workouts' },
    ...(stats.hasVolumeData ? [{ value: `${Math.round(formatWeight(stats.totalVolume, athlete.weight_unit))}${athlete.weight_unit || 'kg'}`, label: 'Volume' }] : []),
    { value: durationText, label: 'Training Time' },
    { value: '…', label: 'PRs', id: 'weeklyPRCount' },
  ]

  body.innerHTML = `
    <div class="stats-grid">
      ${tiles.map(t => `
        <div class="stats-grid-tile">
          <div class="workout-summary-stat-value"${t.id ? ` id="${t.id}"` : ''}>${t.value}</div>
          <div class="workout-summary-stat-label">${t.label}</div>
        </div>
      `).join('')}
    </div>
    <div id="weeklyPRSection"></div>
    ${stats.scheduledCount === 0 && stats.totalWorkouts === 0 ? '<p class="no-metrics" style="margin-top:16px">Nothing logged this week</p>' : ''}
  `

  const prEvents = await computeWeekPREvents(weekStart)
  if (!stillShowing()) return
  document.getElementById('weeklyPRCount').textContent = prEvents ? `${prEvents.length}` : '—'
  if (!prEvents || prEvents.length === 0) return
  document.getElementById('weeklyPRSection').innerHTML = `
    <div class="stats-section">
      <p class="stats-section-title">Personal Records</p>
      <div class="summary-exercise-list">${prEvents.map(e => `
        <div class="summary-exercise-row">
          <div class="summary-exercise-name"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><circle cx="12" cy="8" r="7"></circle><polyline points="8.21 13.89 7 23 12 20 17 23 15.79 13.88"></polyline></svg> ${escapeHtml(e.exerciseName)}</div>
          ${e.badges.map(b => `<p class="summary-exercise-sets">${b.label}: ${formatPRBadgeValue(b.before, b.isWeight)} → ${formatPRBadgeValue(b.after, b.isWeight)}</p>`).join('')}
        </div>
      `).join('')}</div>
    </div>
  `
}

// What a day with no workout and no form shows. Today gets the useful next
// steps (a mobility session, logging something of their own) - the same two
// flows the Home tiles open, gated by the same settings. A future day stays
// button-free since the coach may still add something to it, and a
// tournament day says so instead of calling itself a rest day.
export function renderRestDayCard(dateStr, isToday) {
  const todayStr = toDateStr(new Date())
  const tournament = tournamentsByDate[dateStr]
  const showMobility = coachMobilityEnabled && athlete.mobility_enabled
  const mobilityDone = !!mobilitySessionsByDate[dateStr]

  let title = 'Rest day'
  let text
  if (tournament) {
    title = 'Tournament day'
    text = escapeHtml(tournament.name)
  } else if (isToday) text = 'Nothing planned today. Recovery is part of the program.'
  else if (dateStr > todayStr) text = 'Nothing planned for this day yet.'
  else text = 'Nothing was planned for this day.'

  const actions = []
  if (!tournament) {
    if (showMobility && mobilityDone) actions.push('<p class="rest-day-done">Mobility done \u2713</p>')
    else if (showMobility && isToday) actions.push('<button type="button" class="btn-save" id="restMobilityBtn">Do a mobility session</button>')
    if (isToday && athlete.can_self_log_workouts) actions.push('<button type="button" class="btn-cancel" id="restOwnWorkoutBtn">Log your own workout</button>')
  }

  return `
    <div class="rest-day-card">
      <div class="rest-day-icon"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"></path></svg></div>
      <h3 class="rest-day-title">${title}</h3>
      <p class="rest-day-text">${text}</p>
      ${actions.length ? `<div class="rest-day-actions">${actions.join('')}</div>` : ''}
    </div>
  `
}
