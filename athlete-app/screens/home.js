// ==========================================================================
// ATHLETE APP - Home (week view)
// The 7-day strip, the collapsed workout summary card, inline video, and the
// unsynced-sets banner.
// ==========================================================================
import * as nav from '../nav.js?v=__V__'
import { toDateStr, parseDateStr, addDays, startOfWeek } from '../../shared/dates.js?v=__V__'
import { getYouTubeEmbedUrl } from '../../shared/video.js?v=__V__'
import { pageContent, pageWrap, cardWrap, athlete, coachMobilityEnabled } from '../state.js?v=__V__'
import { completedSessionsByDayId, dayIsFullyLogged, ensureDatesLoaded, entriesByDate, formAssignmentsByDate, formatSetTargets, isDateLoaded, loadTrainingData, mobilitySessionsByDate, openSessionsByDayId } from '../data.js?v=__V__'
import { CHEVRON_LEFT, CHEVRON_RIGHT, DAY_NAMES, WORKOUT_TYPE_ICON_SVG, formatShortDate, formatTimedReps, formatWeight } from '../format.js?v=__V__'
import { flushPendingQueue, loadPendingQueue, savePendingQueueToStorage } from '../outbox.js?v=__V__'
import { openLogWeightModal, renderDayPreview } from './day-preview.js?v=__V__'
import { renderMobilityAreaPicker } from './mobility.js?v=__V__'
import { renderAddWorkoutChoice } from './own-workout.js?v=__V__'
import { latestBodyweightRow, renderTournaments, tournamentsByDate } from './tournaments.js?v=__V__'

export let currentWeekStart = null // Date (Monday) of the currently-shown week, for "back to week"

// ==========================================================================
// ---- WORKOUT SUMMARY (collapsed day-preview card) ----
// The day preview used to render every exercise in full (video thumbnail +
// target) the instant a day was opened - for an 8-exercise workout that's
// well over a screen's worth of scrolling before the athlete has decided
// whether to even start it, and a second workout that day was pushed
// entirely below the fold with no hint it existed. Each workout now shows
// as a compact card (name, exercise/set count, an estimated duration) with
// the full list one tap away - see the day-preview-summary-row/
// day-preview-exercises-detail toggle in renderDayPreviewGroup below.
// ==========================================================================

// No duration is stored anywhere for a not-yet-done workout - this is a
// rough estimate (a set plus its rest, at a normal pace) purely so the
// summary card can say something more useful than just a set count.
// Rounded to the nearest 5 minutes so it visibly reads as an estimate
// rather than a precise number nobody actually measured.
function estimateWorkoutMinutes(setCount) {
  return Math.max(5, Math.round((setCount * 2.5) / 5) * 5)
}

// set_targets (one row per actual set, set in Workout Builder) wins when
// present - prescribed_sets is only the fallback for an exercise that's
// never had its sets individually edited, same convention as targetLine().
export function summarizeWorkout(exercises) {
  let setCount = 0
  for (const pe of exercises) {
    setCount += (pe.set_targets && pe.set_targets.length) ? pe.set_targets.length : (pe.prescribed_sets || 1)
  }
  return { exerciseCount: exercises.length, setCount, estMinutes: estimateWorkoutMinutes(setCount) }
}

export function targetLine(pe) {
  const isTimed = pe.exercises && pe.exercises.is_timed
  const tracksWeight = !pe.exercises || pe.exercises.tracks_weight
  const tracksDistance = pe.exercises && pe.exercises.tracks_distance
  const setTargetsText = formatSetTargets(pe.set_targets, isTimed, tracksWeight, tracksDistance)
  const parts = []
  if (setTargetsText) {
    parts.push(setTargetsText)
  } else {
    if (pe.prescribed_sets) parts.push(`${pe.prescribed_sets} sets`)
    if (pe.prescribed_reps) parts.push(isTimed ? formatTimedReps(pe.prescribed_reps) : `${pe.prescribed_reps} reps`)
    if (pe.prescribed_weight && tracksWeight) parts.push(`${formatWeight(pe.prescribed_weight, athlete.weight_unit)}${athlete.weight_unit || 'kg'}`)
  }
  if (pe.extra_fields) {
    for (const [k, v] of Object.entries(pe.extra_fields)) parts.push(`${k}: ${v}`)
  }
  return parts.join(' × ')
}

// ==========================================================================
// ---- INLINE VIDEO ----
// YouTube thumbnails/embeds are available at predictable URLs from just the
// video id, no API key needed. Other hosts fall back to opening a new tab.
// Tapping a thumbnail swaps it for a playing embed right in place - no
// overlay/modal covering the screen.
// ==========================================================================

export function playInlineVideo(containerEl, url) {
  if (!url) return
  const embedUrl = getYouTubeEmbedUrl(url)
  if (!embedUrl) { window.open(url, '_blank'); return }
  containerEl.innerHTML = `<iframe src="${embedUrl}" allow="autoplay; encrypted-media" allowfullscreen></iframe>`
  containerEl.classList.add('video-playing') // hides the play-icon overlay - see CSS
}

// ==========================================================================
// ---- WEEK VIEW (default landing) ----
// ==========================================================================
export function renderWeekView(weekStart = startOfWeek(new Date())) {
  const token = nav.enter('home', { weekStart }, { root: true, tab: 'home' })
  currentWeekStart = weekStart
  // Only screen that ever needs to clear .centered: it's the sole landing
  // point for the real app (see enterWeekView), reached either fresh or,
  // via renderWaitingToBeLinked's Try Again button, straight from a
  // .centered pre-app screen in the same page load - nothing else in the
  // real app ever sets .centered, so nothing else needs to clear it.
  pageWrap.classList.remove('centered')
  cardWrap.classList.remove('centered')

  // Next should stay enabled all the way back up from any past week, not
  // just when weekStart happens to be exactly today's week - it only locks
  // once you'd step past the furthest week this athlete is allowed to see
  const realCurrentWeekStart = startOfWeek(new Date())
  const maxAllowedWeekStart = athlete.can_preview_next_week ? addDays(realCurrentWeekStart, 7) : realCurrentWeekStart
  const nextEnabled = toDateStr(weekStart) < toDateStr(maxAllowedWeekStart)

  // Mobility needs BOTH the coach's global "feature is ready" switch and
  // this specific athlete's own toggle on - tournaments only has the
  // per-athlete one, there's no equivalent global readiness gate for it
  const showMobility = coachMobilityEnabled && athlete.mobility_enabled
  const showTournaments = athlete.tournaments_enabled

  const todayStr = toDateStr(new Date())
  const days = []
  for (let i = 0; i < 7; i++) days.push(addDays(weekStart, i))

  const cardsHtml = days.map(date => {
    const dateStr = toDateStr(date)
    const entries = entriesByDate[dateStr] || []
    // One badge per entry, keyed by day.id (always unique) - not by display
    // name. Two separate entries that happen to share a name (e.g. two
    // default-named "Field Training" self-logged workouts the same day)
    // used to incorrectly collapse into a single badge here - same fix
    // already applied to the coach's own calendar (coach-app/screens/athlete-detail/calendar/grid.js).
    // 🙋 prefixes a workout the athlete added themselves (see Add Own
    // Workout) so it's visually distinct from what the coach assigned.
    const badgeEntries = [...new Map(entries.map(entry => [entry.day.id, entry])).values()]
    const done = dayIsFullyLogged(entries)
    // A day with an open (started, never ended) session but not yet fully
    // logged - most often a past day the athlete forgot to tap "End
    // Workout" on - gets its own indicator so it's easy to spot in the
    // week strip instead of looking identical to a day nothing happened on
    const inProgress = !done && entries.some(entry => !!openSessionsByDayId[entry.day.id])
    const mobility = mobilitySessionsByDate[dateStr]
    const tournament = tournamentsByDate[dateStr]
    const forms = formAssignmentsByDate[dateStr] || []

    // Status (done/in-progress/planned/tournament-only) tints the whole
    // card now, not just a border - mutually exclusive, most-advanced wins,
    // so a day never gets two competing tints. "today" stays a separate
    // ring (box-shadow, see app.css) instead of fighting these for the
    // background, so it's still visible on a day that also has a status.
    const classes = ['week-day-card']
    if (dateStr === todayStr) classes.push('today')
    if (done) classes.push('done')
    else if (inProgress) classes.push('in-progress')
    else if (badgeEntries.length > 0) classes.push('planned')
    else if (tournament) classes.push('tournament-only')

    // A busy day (several workouts + mobility + a tournament) used to show
    // one full-name badge per item, which either stacked tall (wrapped
    // text) or blew a grid column wide (unwrapped text - a 1fr grid track
    // won't shrink below an unwrapped child's content width). Small
    // fixed-size icons avoid both - every cell stays a uniform size no
    // matter what's scheduled. Tapping the card still opens the full day
    // preview with real names.
    //
    // Each workout icon is shaped by its own workout_type (gym/field/run)
    // while it's still upcoming - once the day's done or in progress, the
    // shape stops mattering as much as the progress does, so every entry
    // switches to a shared check/play glyph instead (matches the color the
    // card itself is tinted).
    // Per-entry, not the day-level done/inProgress above - those two are an
    // all-or-nothing verdict for the whole day, which is right for the
    // card's own tint but was wrong here: on a day with two workouts, one
    // finished and one not, the day-level `done` is false, and that false
    // was getting applied to BOTH icons, hiding the checkmark on the one
    // that was actually completed.
    const icons = badgeEntries.map(entry => {
      const entryDone = !!completedSessionsByDayId[entry.day.id]
      const entryInProgress = !entryDone && !!openSessionsByDayId[entry.day.id]
      if (entryDone) return `<span class="type-icon type-icon-done"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg></span>`
      if (entryInProgress) return `<span class="type-icon type-icon-in-progress"><svg viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20"></polygon></svg></span>`
      return `<span class="type-icon type-icon-planned">${WORKOUT_TYPE_ICON_SVG[entry.day.workout_type] || WORKOUT_TYPE_ICON_SVG.gym}</span>`
    })
    if (mobility) icons.push('<span class="type-icon type-icon-mobility"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="4" r="2"></circle><path d="M12 6v6"></path><path d="M8 8l4 2 4-2"></path><path d="M9 20l3-6 3 6"></path></svg></span>')
    if (tournament) icons.push('<span class="type-icon type-icon-tournament"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="7"></circle><polyline points="8.21 13.89 7 23 12 20 17 23 15.79 13.88"></polyline></svg></span>')
    for (const fa of forms) {
      icons.push(`<span class="type-icon ${fa.completed_at ? 'type-icon-done' : 'type-icon-form'}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"></path><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path></svg></span>`)
    }
    const visibleIcons = icons.slice(0, 4)
    const extraCount = icons.length - visibleIcons.length

    return `
      <div class="${classes.join(' ')}" data-date="${dateStr}">
        <span class="week-day-name">${DAY_NAMES[date.getDay() === 0 ? 6 : date.getDay() - 1]}</span>
        <span class="week-day-number">${date.getDate()}</span>
        <div class="week-day-icons">
          ${visibleIcons.join('')}
          ${extraCount > 0 ? `<span class="type-icon type-icon-more">+${extraCount}</span>` : ''}
        </div>
      </div>
    `
  }).join('')

  const pendingCount = loadPendingQueue().length

  // Built as a list rather than fixed rows so it always packs 2-per-row no
  // matter which optional tiles (Mobility/Tournaments) are on for this
  // athlete - Log Weight is last, always on, and lands next to Tournaments
  // when both are showing. If the total comes out odd, the trailing tile
  // spans the full row instead of leaving an empty half-row next to it.
  const homeTiles = [
    `<button type="button" class="home-tile ${athlete.can_self_log_workouts ? '' : 'disabled'}" id="addOwnWorkoutTile">
      <span class="home-tile-icon-chip"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg></span>
      <span class="home-tile-label">Add Own Workout</span>
      ${athlete.can_self_log_workouts ? '' : '<span class="home-tile-sublabel">Ask your coach to enable this</span>'}
    </button>`,
    ...(showMobility ? [`<button type="button" class="home-tile" id="mobilityTile">
      <span class="home-tile-icon-chip"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="4" r="2"></circle><path d="M12 6v5"></path><path d="M12 8l-5 5"></path><path d="M12 8l5 5"></path><path d="M12 11l-3 9"></path><path d="M12 11l3 9"></path></svg></span>
      <span class="home-tile-label">Daily Mobility/Stretching</span>
    </button>`] : []),
    ...(showTournaments ? [`<button type="button" class="home-tile" id="tournamentsTile">
      <span class="home-tile-icon-chip"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="7"></circle><polyline points="8.21 13.89 7 23 12 20 17 23 15.79 13.88"></polyline></svg></span>
      <span class="home-tile-label">Tournaments</span>
    </button>`] : []),
    `<button type="button" class="home-tile" id="logWeightTile">
      <span class="home-tile-icon-chip"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="3" x2="12" y2="21"></line><path d="M5 7l-3 7a4 4 0 0 0 8 0z"></path><path d="M19 7l-3 7a4 4 0 0 0 8 0z"></path><path d="M5 7h14"></path><path d="M12 3l4 4M12 3l-4 4"></path></svg></span>
      <span class="home-tile-label">Log Weight</span>
      ${latestBodyweightRow ? `<span class="home-tile-sublabel">${formatWeight(latestBodyweightRow.weight, athlete.weight_unit)}${athlete.weight_unit || 'kg'} · ${formatShortDate(parseDateStr(latestBodyweightRow.date))}</span>` : ''}
    </button>`,
  ]
  if (homeTiles.length % 2 === 1) {
    homeTiles[homeTiles.length - 1] = homeTiles[homeTiles.length - 1].replace('class="home-tile', 'class="home-tile home-tile-wide')
  }

  // .home-screen fills the space between the header and bottom nav exactly
  // (see the body:has(.home-screen) rules in app.css) - unlike every other
  // screen in this app, Home doesn't scroll, so the week strip grows to
  // absorb whatever room is left instead of leaving it blank underneath
  // the tiles.
  pageContent.innerHTML = `
    <div class="home-screen">
      <div class="welcome-header">
        <h2>Welcome back, ${athlete.name.split(' ')[0]}</h2>
        <p>Here's your training for the week</p>
      </div>
      ${renderSyncBannerHtml(pendingCount)}
      <div class="week-nav-row">
        <button class="icon-btn" id="weekPrevBtn" aria-label="Previous week">${CHEVRON_LEFT}</button>
        <h3>${formatShortDate(days[0])} – ${formatShortDate(days[6])}</h3>
        <button class="icon-btn" id="weekNextBtn" aria-label="Next week" ${nextEnabled ? '' : 'disabled'}>${CHEVRON_RIGHT}</button>
      </div>
      <div class="week-strip">${cardsHtml}</div>
      <div class="home-tile-row">${homeTiles.join('')}</div>
    </div>
  `

  document.querySelectorAll('.week-day-card').forEach(cardEl => {
    cardEl.addEventListener('click', function() { renderDayPreview(cardEl.dataset.date) })
  })

  // Only a window of weeks is loaded (see data.js) - stepping back past it
  // waits for that week first. Usually it's already there: the line at the
  // bottom of this function keeps the weeks behind this one loading.
  document.getElementById('weekPrevBtn').addEventListener('click', async function() {
    const prevWeek = addDays(weekStart, -7)
    if (!isDateLoaded(toDateStr(prevWeek))) {
      this.disabled = true
      const loaded = await ensureDatesLoaded(toDateStr(prevWeek), toDateStr(addDays(prevWeek, 6)))
      if (!nav.isCurrent(token)) return
      this.disabled = false
      if (!loaded) { customAlert('Couldn\'t load that week - check your connection and try again'); return }
    }
    renderWeekView(prevWeek)
  })
  document.getElementById('weekNextBtn').addEventListener('click', function() {
    if (nextEnabled) renderWeekView(addDays(weekStart, 7))
  })

  document.getElementById('addOwnWorkoutTile').addEventListener('click', function() {
    if (!athlete.can_self_log_workouts) {
      customAlert('Ask your coach to turn this on for your account.')
      return
    }
    renderAddWorkoutChoice()
  })
  if (showMobility) {
    document.getElementById('mobilityTile').addEventListener('click', function() {
      renderMobilityAreaPicker()
    })
  }
  if (showTournaments) {
    document.getElementById('tournamentsTile').addEventListener('click', function() {
      renderTournaments()
    })
  }
  document.getElementById('logWeightTile').addEventListener('click', function() {
    openLogWeightModal()
  })

  wireSyncBanner(function() { renderWeekView(weekStart) })

  // Quietly load the weeks behind this one, so the back arrow doesn't have
  // to wait (no-op when they're already loaded)
  const twoWeeksBack = addDays(weekStart, -14)
  ensureDatesLoaded(toDateStr(twoWeeksBack), toDateStr(addDays(twoWeeksBack, 6)))
}

// ==========================================================================
// ---- SYNC STATUS BANNER ----
// Makes the pending-save queue visible instead of silent - a set that
// hasn't reached the server yet shows up here with the ACTUAL error from
// the last failed attempt (not just an invisible tooltip, which doesn't
// work on touch anyway) and a manual "Retry now" button. Shown on the week
// view since that's what's on screen right after finishing a workout.
// ==========================================================================
export function renderSyncBannerHtml(pendingCount) {
  if (pendingCount === 0) return ''

  const withError = loadPendingQueue().find(e => e.lastError)
  const errorLine = withError ? `Last error: ${withError.lastError}` : 'Still trying automatically in the background.'

  return `
    <div class="sync-banner" id="syncBanner">
      <div>
        <strong>${pendingCount} set${pendingCount === 1 ? '' : 's'} not synced yet</strong>
        <div class="sync-banner-detail">${errorLine}</div>
      </div>
      <div style="display:flex; gap:8px">
        <button type="button" class="btn-cancel" id="syncRetryBtn">Retry Now</button>
        <button type="button" class="btn-cancel" id="syncDismissBtn">Dismiss</button>
      </div>
    </div>
  `
}

export function wireSyncBanner(onDone) {
  const retryBtn = document.getElementById('syncRetryBtn')
  const dismissBtn = document.getElementById('syncDismissBtn')
  if (!retryBtn) return

  retryBtn.addEventListener('click', async function() {
    retryBtn.disabled = true
    retryBtn.textContent = 'Retrying...'
    await flushPendingQueue()
    onDone()
  })

  // Only offered as a last resort once retrying keeps failing - this
  // permanently throws away whatever wasn't saved, since there's no other
  // way to clear a stuck queue from a phone (no browser console access
  // there the way there is on desktop)
  dismissBtn.addEventListener('click', async function() {
    const count = loadPendingQueue().length
    const ok = await customConfirm(`Discard ${count} unsynced set${count === 1 ? '' : 's'}? They never saved to the server, so this can't be undone - only do this if you don't need this data.`)
    if (!ok) return
    savePendingQueueToStorage([])
    // Those sets were applied on top of the loaded data (see
    // applyPendingQueueLocally), so they'd keep looking ticked until the app
    // reloaded - reload now so the screen matches what's actually saved
    await loadTrainingData()
    onDone()
  })
}
