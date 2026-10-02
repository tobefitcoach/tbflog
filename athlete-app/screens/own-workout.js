// ==========================================================================
// ATHLETE APP - add own workout (Strength + Field/Training)
// ==========================================================================
import { supabase } from '../athleteClient.js?v=__V__'
import * as nav from '../nav.js?v=__V__'
import { toDateStr, parseDateStr } from '../../shared/dates.js?v=__V__'
import { getYouTubeThumbnail } from '../../shared/video.js?v=__V__'
import { pageContent, athlete } from '../state.js?v=__V__'
import { completedSessionsByDayId, entriesByDate, loadTrainingData, logSetsByPE } from '../data.js?v=__V__'
import { CHEVRON_LEFT, RPE_DESCRIPTIONS } from '../format.js?v=__V__'
import { saveWithRetry } from '../outbox.js?v=__V__'
import { notifyCoach } from './tournaments.js?v=__V__'
import { buildWorkoutSlides, renderActiveExercise, startWorkout } from '../workout/active.js?v=__V__'
import { renderWorkoutSummary } from '../workout/swipe.js?v=__V__'

// ==========================================================================
// ---- ADD OWN WORKOUT (Strength + Field/Training) ----
// Gated by athlete.can_self_log_workouts (see the tile in renderWeekView).
// Always logs against today. Strength becomes a completely normal
// programs/program_weeks/program_days/program_exercises tree
// (created_by_athlete=true is the only difference from a coach-assigned
// one), so it flows through the exact same startWorkout -> checkSet/
// uncheckSet -> finishWorkout pipeline a coach-assigned workout uses -
// Total Volume, PR detection, and Training Load all pick it up with zero
// extra code. Field/Training skips exercises entirely and writes straight
// to workout_sessions (duration + RPE), which Training Load already
// consumes via session_rpe x duration_minutes.
// ==========================================================================
let exerciseLibraryCache = null

export async function loadExerciseLibrary() {
  if (exerciseLibraryCache) return exerciseLibraryCache
  const { data, error } = await saveWithRetry((signal) => supabase
    .from('exercises')
    .select('*')
    .eq('archived', false)
    .order('name')
    .abortSignal(signal)
  )
  if (error) { console.log(error); customAlert('Something went wrong loading the exercise library - check your connection and try again'); return null }
  exerciseLibraryCache = data
  return exerciseLibraryCache
}

export function renderAddWorkoutChoice() {
  nav.enter('addWorkoutChoice', {})

  pageContent.innerHTML = `
    <div class="day-view-header">
      <button type="button" class="icon-btn" id="addWorkoutBackBtn" aria-label="Back">${CHEVRON_LEFT}</button>
      <h2 class="day-view-date">Add Own Workout</h2>
    </div>
    <p style="color:var(--c-text-muted); font-size:13px; margin-bottom:16px">What kind of workout did you do today?</p>
    <div class="home-tile-row">
      <button type="button" class="home-tile" id="addWorkoutStrengthChoice">
        <span class="home-tile-icon-chip"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="9" width="3" height="6" rx="1"></rect><rect x="20" y="9" width="3" height="6" rx="1"></rect><line x1="4" y1="12" x2="20" y2="12"></line><rect x="6" y="7" width="2" height="10" rx="1"></rect><rect x="16" y="7" width="2" height="10" rx="1"></rect></svg></span>
        <span class="home-tile-label">Strength (Gym)</span>
      </button>
      <button type="button" class="home-tile" id="addWorkoutFieldChoice">
        <span class="home-tile-icon-chip"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="13" r="8"></circle><path d="M12 9v4l3 2"></path><path d="M9 2h6"></path><path d="M12 2v3"></path></svg></span>
        <span class="home-tile-label">Field / Training</span>
      </button>
      <button type="button" class="home-tile" id="addWorkoutRunChoice">
        <span class="home-tile-icon-chip"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="17" cy="4" r="2"></circle><path d="M10 22l2-6 3 2 2-6"></path><path d="M6 13l3-3 4 1 3-4"></path><path d="M4 22l3-5"></path></svg></span>
        <span class="home-tile-label">Run</span>
      </button>
    </div>
  `

  document.getElementById('addWorkoutBackBtn').addEventListener('click', nav.back)
  document.getElementById('addWorkoutStrengthChoice').addEventListener('click', function() {
    startOwnStrengthWorkout()
  })
  document.getElementById('addWorkoutFieldChoice').addEventListener('click', function() {
    renderAddWorkoutFieldForm('field')
  })
  document.getElementById('addWorkoutRunChoice').addEventListener('click', function() {
    renderAddWorkoutFieldForm('run')
  })
}

// ---- Strength: same live guided screen as a coach-assigned workout ----
// Pressing "Strength" first sends the athlete through renderOwnWorkoutBuilder
// (multi-select their whole exercise list up front), then drops into the
// exact renderActiveExercise flow used to follow a coach-built training -
// video thumb, + Add Set, checkable rows - once "Start Workout" is pressed
// there. Logging itself is unchanged either way: actual sets as they go.
async function startOwnStrengthWorkout() {
  const dateStr = toDateStr(new Date())
  let dayId
  try {
    ({ dayId } = await findOrCreateSelfLoggedDay(dateStr, 'My Workout', 'gym'))
  } catch (err) {
    return
  }
  // No "workout added" notification here anymore - it fired the instant
  // Strength was tapped, before any exercise was even logged, so the coach
  // got two notifications (added, then completed) for what's really one
  // action. Field/Training and Run never had this problem (they only ever
  // notify on completion) - this brings Strength in line with those.
  await loadTrainingData()
  // Matched by day id, not just "any self-logged entry today" - today can
  // now genuinely hold more than one (see findOrCreateSelfLoggedDay), so
  // grabbing the first one found could open an already-finished workout
  // instead of the fresh one just created/resumed here
  const entry = (entriesByDate[dateStr] || []).find(e => e.day.id === dayId)
  if (!entry) { customAlert('Something went wrong starting your workout'); return }
  startWorkout(entry, dateStr)
}

// Shared search+tap-to-pick card list - filters `library` as the athlete
// types and renders one exercise-lib-card per match, calling onPick(id,
// cardEl) when tapped (cardEl gets marked .adding so a slow connection
// can't double-fire the same pick). Used by the full-page Add Exercise
// screen below and the Swap modal, so both stay visually/behaviorally
// identical instead of drifting apart as two copies.
export function wireExercisePicker(searchInputEl, listEl, library, onPick) {
  function render() {
    const filter = searchInputEl.value.trim().toLowerCase()
    const filtered = filter ? library.filter(ex => ex.name.toLowerCase().includes(filter)) : library

    listEl.innerHTML = filtered.length === 0
      ? '<p class="no-metrics">No exercises found</p>'
      : filtered.map(ex => {
          const thumb = getYouTubeThumbnail(ex.video_url)
          return `
            <div class="exercise-lib-card own-add-exercise-card" data-id="${ex.id}">
              <div class="exercise-lib-thumb">
                ${thumb ? `<img src="${thumb}" alt="" loading="lazy">` : '<span class="exercise-lib-thumb-placeholder"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="4" cy="12" r="2"></circle><circle cx="20" cy="12" r="2"></circle><line x1="6" y1="12" x2="18" y2="12"></line><line x1="9" y1="8" x2="9" y2="16"></line><line x1="15" y1="8" x2="15" y2="16"></line></svg></span>'}
              </div>
              <span class="exercise-lib-name">${ex.name}</span>
            </div>
          `
        }).join('')

    listEl.querySelectorAll('.own-add-exercise-card').forEach(card => {
      card.addEventListener('click', function() {
        if (card.classList.contains('adding')) return
        card.classList.add('adding')
        onPick(card.dataset.id, card)
      })
    })
  }

  searchInputEl.addEventListener('input', render)
  render()
}

// Search + tap-to-add-and-jump-straight-in - reached only mid-workout, via
// the "+ Add Exercise" button on a later slide (renderSingleSlideBody, which
// always passes the slide index to return to). Deliberately still one-at-a-
// time: this is for a spontaneous "oh, one more thing" mid-session, not
// upfront planning - that's renderOwnWorkoutBuilder below, used instead for
// the very first exercise of a fresh (or emptied-back-to-zero) day.
export async function renderOwnWorkoutAddExercise(entry, dateStr, sessionPromise, returnIndex) {
  const myToken = nav.enter('ownAddExercise', { entry, dateStr, sessionPromise, returnIndex })

  pageContent.innerHTML = `
    <div class="workout-active" style="display:none"></div>
    <div class="day-view-header">
      <button type="button" class="icon-btn" id="ownAddExerciseBackBtn" aria-label="Back">${CHEVRON_LEFT}</button>
      <h2 class="day-view-date">Add Exercise</h2>
    </div>
    <input type="text" id="ownAddExerciseSearchInput" class="exercise-search-input" placeholder="Search exercises..." />
    <div id="ownAddExerciseList"></div>
  `

  document.getElementById('ownAddExerciseBackBtn').addEventListener('click', function() {
    const exercises = [...entry.day.program_exercises].sort((a, b) => a.order_index - b.order_index)
    const slides = buildWorkoutSlides(exercises)
    renderActiveExercise(entry, dateStr, slides, Math.min(returnIndex, slides.length - 1), sessionPromise)
  })

  const library = await loadExerciseLibrary()
  if (library === null) return
  if (!nav.isCurrent(myToken)) return // navigated away while the library loaded - #ownAddExerciseSearchInput is gone

  wireExercisePicker(
    document.getElementById('ownAddExerciseSearchInput'),
    document.getElementById('ownAddExerciseList'),
    library,
    function(exerciseId) {
      addExerciseToOwnWorkout(entry, dateStr, sessionPromise, exerciseId)
    }
  )
}

// Every exercise the athlete has ever self-added to one of their own
// workouts, most recently first - pure client-side derivation from
// entriesByDate (already loaded by loadTrainingData(), no extra query
// needed) mapped back through the current library so an archived/deleted
// exercise never shows up. Powers the "Recently Logged" shortcut in
// renderOwnWorkoutBuilder, so a repeat gym day doesn't mean re-searching
// for the same handful of exercises every time.
function getRecentlyLoggedExercises(library, limit) {
  const latestCreatedAt = new Map() // exercise_id -> most recent created_at it was added at
  for (const dateStr in entriesByDate) {
    for (const entry of entriesByDate[dateStr]) {
      if (!entry.program.created_by_athlete) continue
      for (const pe of entry.day.program_exercises) {
        const existing = latestCreatedAt.get(pe.exercise_id)
        if (!existing || pe.created_at > existing) latestCreatedAt.set(pe.exercise_id, pe.created_at)
      }
    }
  }
  return [...latestCreatedAt.entries()]
    .sort((a, b) => b[1].localeCompare(a[1]))
    .map(([exerciseId]) => library.find(ex => ex.id === exerciseId))
    .filter(Boolean)
    .slice(0, limit)
}

// ---- Own workout builder: multi-select the whole exercise list up front ----
// Reached for a brand-new (or emptied-back-out-to-zero) self-logged day.
// Tapping a card just toggles it selected - nothing is written to
// program_exercises until "Start Workout" inserts the whole batch in one
// go, so backing out here leaves no trace. Once started, it's the exact
// same renderActiveExercise flow as a coach-built workout.
export async function renderOwnWorkoutBuilder(entry, dateStr, sessionPromise) {
  const myToken = nav.enter('ownBuilder', { entry, dateStr, sessionPromise }, { collapse: true })

  const selected = new Map() // exercise_id -> exercise object, insertion-ordered
  const activeCategoryFilters = new Set()

  pageContent.innerHTML = `
    <div class="workout-active" style="display:none"></div>
    <div class="day-view-header">
      <button type="button" class="icon-btn" id="ownBuilderBackBtn" aria-label="Back">${CHEVRON_LEFT}</button>
      <h2 class="day-view-date">Build Your Workout</h2>
    </div>
    <p class="own-builder-subtitle">Select all the exercises you want to do, then start your workout.</p>
    <input type="text" id="ownBuilderSearchInput" class="exercise-search-input" placeholder="Search exercises..." />
    <div class="chip-row" id="ownBuilderCategoryChips"></div>
    <div id="ownBuilderList"></div>
    <div class="own-builder-start-bar" id="ownBuilderStartBar"></div>
  `

  document.getElementById('ownBuilderBackBtn').addEventListener('click', nav.back)

  const library = await loadExerciseLibrary()
  if (library === null) return
  if (!nav.isCurrent(myToken)) return // navigated away while the library loaded - #ownBuilderCategoryChips is gone

  const categories = [...new Set(library.map(ex => ex.category).filter(c => c && c.trim()))].sort()
  document.getElementById('ownBuilderCategoryChips').innerHTML = categories.map(cat =>
    `<button type="button" class="chip-btn" data-category="${cat}">${cat}</button>`
  ).join('')
  document.getElementById('ownBuilderCategoryChips').addEventListener('click', function(e) {
    const btn = e.target.closest('.chip-btn')
    if (!btn) return
    const cat = btn.dataset.category
    if (activeCategoryFilters.has(cat)) activeCategoryFilters.delete(cat)
    else activeCategoryFilters.add(cat)
    btn.classList.toggle('selected')
    renderList()
  })

  document.getElementById('ownBuilderSearchInput').addEventListener('input', renderList)

  function cardHtml(ex) {
    const thumb = getYouTubeThumbnail(ex.video_url)
    return `
      <div class="exercise-lib-card own-add-exercise-card ${selected.has(ex.id) ? 'selected' : ''}" data-id="${ex.id}">
        <div class="exercise-lib-thumb">
          ${thumb ? `<img src="${thumb}" alt="" loading="lazy">` : '<span class="exercise-lib-thumb-placeholder"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="4" cy="12" r="2"></circle><circle cx="20" cy="12" r="2"></circle><line x1="6" y1="12" x2="18" y2="12"></line><line x1="9" y1="8" x2="9" y2="16"></line><line x1="15" y1="8" x2="15" y2="16"></line></svg></span>'}
        </div>
        <span class="exercise-lib-name">${ex.name}</span>
        <span class="own-builder-check">✓</span>
      </div>
    `
  }

  function renderList() {
    const search = document.getElementById('ownBuilderSearchInput').value.trim().toLowerCase()
    const filtered = library.filter(ex =>
      (!search || ex.name.toLowerCase().includes(search)) &&
      (activeCategoryFilters.size === 0 || activeCategoryFilters.has((ex.category || '').trim()))
    )

    const showRecents = !search && activeCategoryFilters.size === 0
    const recents = showRecents ? getRecentlyLoggedExercises(library, 6) : []
    const recentIds = new Set(recents.map(ex => ex.id))
    const rest = filtered.filter(ex => !recentIds.has(ex.id))

    const listEl = document.getElementById('ownBuilderList')
    listEl.innerHTML =
      (recents.length ? `<p class="own-builder-section-label">Recently Logged</p>${recents.map(cardHtml).join('')}<p class="own-builder-section-label">All Exercises</p>` : '') +
      (rest.length === 0 && recents.length === 0 ? '<p class="no-metrics">No exercises found</p>' : rest.map(cardHtml).join(''))

    listEl.querySelectorAll('.own-add-exercise-card').forEach(card => {
      card.addEventListener('click', function() {
        const id = card.dataset.id
        if (selected.has(id)) selected.delete(id)
        else selected.set(id, library.find(ex => ex.id === id))
        card.classList.toggle('selected')
        renderStartBar()
      })
    })
  }

  function renderStartBar() {
    const bar = document.getElementById('ownBuilderStartBar')
    if (selected.size === 0) { bar.style.display = 'none'; return }
    bar.style.display = 'flex'
    bar.innerHTML = `
      <span class="own-builder-start-count">${selected.size} exercise${selected.size === 1 ? '' : 's'} selected</span>
      <button type="button" class="btn-save" id="ownBuilderStartBtn">Start Workout</button>
    `
    document.getElementById('ownBuilderStartBtn').addEventListener('click', startBuiltWorkout)
  }

  async function startBuiltWorkout() {
    const ids = [...selected.keys()]
    if (ids.length === 0) return
    const btn = document.getElementById('ownBuilderStartBtn')
    btn.disabled = true
    btn.textContent = 'Starting...'

    const rows = ids.map((exerciseId, i) => ({ day_id: entry.day.id, exercise_id: exerciseId, order_index: i, added_by_athlete: true }))
    const { data, error } = await supabase
      .from('program_exercises')
      .insert(rows)
      .select('*, exercises!exercise_id(name, category, type, video_url, foot_contacts, intensity_tier, tracks_reps, tracks_weight, is_timed, is_unilateral, tracks_distance)')

    if (error) {
      console.log(error)
      customAlert('Something went wrong starting your workout - please try again')
      btn.disabled = false
      btn.textContent = 'Start Workout'
      return
    }

    entry.day.program_exercises.push(...data)
    const slides = buildWorkoutSlides([...entry.day.program_exercises].sort((a, b) => a.order_index - b.order_index))
    renderActiveExercise(entry, dateStr, slides, 0, sessionPromise)
  }

  renderList()
}

async function addExerciseToOwnWorkout(entry, dateStr, sessionPromise, exerciseId) {
  const existing = entry.day.program_exercises
  const orderIndex = existing.length ? Math.max(...existing.map(pe => pe.order_index)) + 1 : 0

  // added_by_athlete=true both flags this for the coach's calendar (see
  // athlete-calendar.js) and is what the "athlete deletes own added
  // exercises" RLS policy checks - true here regardless of self-logged vs
  // coach-assigned, since it's accurate either way
  const { data, error } = await supabase
    .from('program_exercises')
    .insert([{ day_id: entry.day.id, exercise_id: exerciseId, order_index: orderIndex, added_by_athlete: true }])
    .select('*, exercises!exercise_id(name, category, type, video_url, foot_contacts, intensity_tier, tracks_reps, tracks_weight, is_timed, is_unilateral, tracks_distance)')
    .single()

  if (error) { console.log(error); customAlert('Something went wrong adding that exercise - please try again'); return }

  existing.push(data)
  const slides = buildWorkoutSlides([...existing].sort((a, b) => a.order_index - b.order_index))
  const newIndex = slides.findIndex(s => s.type === 'single' && s.pe.id === data.id)
  renderActiveExercise(entry, dateStr, slides, newIndex === -1 ? slides.length - 1 : newIndex, sessionPromise, 1)
}

// Removing a self-logged exercise's last set row removes the exercise
// itself too - a self-added exercise with nothing logged on it isn't worth
// keeping around, and there's no other way to remove one mid-workout.
// Updates in-memory state and moves on immediately (nothing was ever saved
// for an unchecked row - see wireExerciseCardEvents), then deletes the row
// in the background rather than making the athlete wait on it.
export function removeEmptyOwnExercise(entry, dateStr, sessionPromise, index, peId) {
  entry.day.program_exercises = entry.day.program_exercises.filter(pe => pe.id !== peId)
  delete logSetsByPE[peId]

  const exercises = [...entry.day.program_exercises].sort((a, b) => a.order_index - b.order_index)
  if (exercises.length === 0) {
    renderOwnWorkoutBuilder(entry, dateStr, sessionPromise)
  } else {
    const slides = buildWorkoutSlides(exercises)
    renderActiveExercise(entry, dateStr, slides, Math.min(index, slides.length - 1), sessionPromise, -1)
  }

  supabase.from('program_exercises').delete().eq('id', peId).then(function(res) {
    if (res.error) console.log(res.error)
  })
}

// name is only used the first time a self-logged workout is created for
// this date - repeated adds on the same day reuse the same container ONLY
// while it's still unfinished (a still-empty or in-progress draft) - same
// convention as the coach's own findOrCreateAdHocDay for that case. Once a
// self-logged workout on this date has actually been completed, reusing it
// again would silently merge a second, separate workout into the first
// one's program_days row - and since the Calendar day-detail only shows
// the most-recently-ended session's summary per row, the first workout's
// data would effectively vanish behind the second. So a finished day
// always gets a fresh one instead.
// Returns { dayId, created } - `created` lets callers tell a brand-new
// self-logged day apart from resuming today's already-existing one (used
// by startOwnStrengthWorkout to fire a "workout added" notification only
// once, not every time the athlete reopens an in-progress day)
async function findOrCreateSelfLoggedDay(dateStr, name, workoutType) {
  // Not .maybeSingle() - this date can now genuinely hold more than one
  // self-logged program (see the finished-session check below), so every
  // match needs checking, not just the first/only one
  const { data: existingPrograms, error: findError } = await supabase
    .from('programs')
    .select('*, program_weeks(*, program_days(*))')
    .eq('athlete_id', athlete.id)
    .eq('is_adhoc', true)
    .eq('created_by_athlete', true)
    .eq('start_date', dateStr)

  if (findError) { console.log(findError) }

  // completedSessionsByDayId is already loaded/refreshed by loadTrainingData()
  // (every write path here calls it right after saving) - reused directly
  // instead of firing a fresh per-program query, since a previous version of
  // this check (a separate query per program) never correctly detected an
  // already-finished day and kept reusing it indefinitely
  for (const program of existingPrograms || []) {
    const dayId = program.program_weeks[0].program_days[0].id
    if (!completedSessionsByDayId[dayId]) return { dayId, created: false }
  }

  const { data: newProgram, error: programError } = await supabase
    .from('programs')
    .insert([{ coach_id: athlete.coach_id, athlete_id: athlete.id, is_template: false, is_adhoc: true, created_by_athlete: true, start_date: dateStr, name: name || 'My Workout' }])
    .select()
  if (programError) { console.log(programError); customAlert('Something went wrong saving your workout'); throw programError }

  const { data: newWeek, error: weekError } = await supabase
    .from('program_weeks')
    .insert([{ program_id: newProgram[0].id, week_number: 1 }])
    .select()
  if (weekError) { console.log(weekError); customAlert('Something went wrong saving your workout'); throw weekError }

  const { data: newDay, error: dayError } = await supabase
    .from('program_days')
    .insert([{ week_id: newWeek[0].id, day_number: 1, workout_type: workoutType || null }])
    .select()
  if (dayError) { console.log(dayError); customAlert('Something went wrong saving your workout'); throw dayError }

  return { dayId: newDay[0].id, created: true }
}

// ---- Field/Training and Run: duration + RPE, no exercises at all - same
// shape for both, just a different title/placeholder/default activity name
// and the `type` ('field' or 'run') that ends up on the program_days row ----
export function renderAddWorkoutFieldForm(type) {
  nav.enter('addWorkoutField', { type })

  const presets = [20, 30, 45, 60, 90]
  let selectedRpe = null
  const title = type === 'run' ? 'Run' : 'Field / Training'
  const activityPlaceholder = type === 'run' ? 'e.g. 5k tempo run, track intervals' : 'e.g. Soccer practice, 5k run'

  pageContent.innerHTML = `
    <div class="day-view-header">
      <button type="button" class="icon-btn" id="addWorkoutBackBtn" aria-label="Back">${CHEVRON_LEFT}</button>
      <h2 class="day-view-date">${title}</h2>
    </div>
    <div class="form-group">
      <label>Date</label>
      <input type="date" id="fieldDateInput" value="${toDateStr(new Date())}" max="${toDateStr(new Date())}">
    </div>
    <div class="form-group">
      <label>Activity (optional)</label>
      <input type="text" id="fieldActivityInput" placeholder="${activityPlaceholder}">
    </div>
    <div class="form-group">
      <label>Duration</label>
      <div class="duration-preset-row">
        ${presets.map(m => `<button type="button" class="duration-preset-btn" data-minutes="${m}">${m} min</button>`).join('')}
      </div>
      <div class="set-time-input" style="width:fit-content; margin-top:8px">
        <input type="text" inputmode="numeric" class="field-duration-hh" id="fieldDurationHH" value="00" maxlength="2">
        <span class="set-time-sep">h</span>
        <input type="text" inputmode="numeric" class="field-duration-mm" id="fieldDurationMM" value="00" maxlength="2">
        <span class="set-time-sep">m</span>
      </div>
      <p style="color:var(--c-text-muted); font-size:11px; margin-top:4px">Hours and minutes - not mm:ss</p>
    </div>
    <div class="rpe-picker">
      <p class="rpe-picker-label">Effort (RPE)</p>
      <div class="rpe-picker-row" id="fieldRpeRow">
        ${[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => `<button type="button" class="rpe-btn" data-rpe="${n}">${n}</button>`).join('')}
      </div>
      <p class="rpe-picker-hint" id="fieldRpeHint">Tap a number to rate how hard it felt</p>
    </div>
    <div class="form-group">
      <label>Avg Heart Rate (optional)</label>
      <input type="number" id="fieldAvgHr" min="30" max="250" placeholder="e.g. 145 bpm">
    </div>
    <button type="button" class="btn-save start-workout-btn" id="fieldSaveBtn" style="margin-top:16px">Save</button>
  `

  document.getElementById('addWorkoutBackBtn').addEventListener('click', nav.back)

  document.querySelectorAll('.duration-preset-btn').forEach(btn => {
    btn.addEventListener('click', function() {
      const totalMinutes = parseInt(btn.dataset.minutes)
      document.getElementById('fieldDurationHH').value = String(Math.floor(totalMinutes / 60)).padStart(2, '0')
      document.getElementById('fieldDurationMM').value = String(totalMinutes % 60).padStart(2, '0')
    })
  })

  // Same sanitize-as-typed / clamp-on-blur pattern as the mm:ss set-time
  // boxes elsewhere in this file (see wireExerciseCardEvents) - kept as two
  // small text inputs rather than type="number" so "00" padding stays
  // visible instead of the browser stripping the leading zero
  const durationBoxes = document.querySelectorAll('#fieldDurationHH, #fieldDurationMM')
  durationBoxes.forEach(input => {
    // Selects the "00" the moment it's tapped, so typing a digit replaces
    // it immediately instead of needing a manual delete first
    input.addEventListener('focus', function() {
      input.select()
    })
    input.addEventListener('input', function() {
      input.value = input.value.replace(/\D/g, '').slice(0, 2)
    })
    input.addEventListener('focusout', function() {
      const max = input.id === 'fieldDurationHH' ? 23 : 59
      const val = Math.min(parseInt(input.value) || 0, max)
      input.value = String(val).padStart(2, '0')
    })
  })

  document.getElementById('fieldRpeRow').addEventListener('click', function(e) {
    const btn = e.target.closest('.rpe-btn')
    if (!btn) return
    document.querySelectorAll('#fieldRpeRow .rpe-btn').forEach(b => b.classList.remove('selected'))
    btn.classList.add('selected')
    selectedRpe = parseInt(btn.dataset.rpe)
    document.getElementById('fieldRpeHint').textContent = RPE_DESCRIPTIONS[selectedRpe]
  })

  document.getElementById('fieldSaveBtn').addEventListener('click', async function() {
    // Clamped here too, not just on focusout - on some devices/keyboards,
    // tapping Save doesn't reliably fire a blur on whichever box still has
    // focus first, so an un-clamped raw value (e.g. "34" left in the hours
    // box) could otherwise sail straight through as 34 HOURS instead of 23
    const hh = Math.min(parseInt(document.getElementById('fieldDurationHH').value) || 0, 23)
    const mm = Math.min(parseInt(document.getElementById('fieldDurationMM').value) || 0, 59)
    const minutes = hh * 60 + mm
    if (!minutes || minutes < 1) { customAlert('Pick a duration first'); return }
    if (!selectedRpe) { customAlert('Pick an RPE first'); return }

    const dateStr = document.getElementById('fieldDateInput').value || toDateStr(new Date())

    const btn = document.getElementById('fieldSaveBtn')
    btn.disabled = true
    btn.textContent = 'Saving...'

    const activity = document.getElementById('fieldActivityInput').value.trim() || title
    const avgHr = parseInt(document.getElementById('fieldAvgHr').value) || null
    await saveFieldTraining(dateStr, activity, minutes, selectedRpe, avgHr, type)
  })
}

async function saveFieldTraining(dateStr, activityName, durationMinutes, rpe, avgHeartRate, workoutType) {
  let dayId
  try {
    ({ dayId } = await findOrCreateSelfLoggedDay(dateStr, activityName, workoutType))
  } catch (err) {
    const btn = document.getElementById('fieldSaveBtn')
    if (btn) { btn.disabled = false; btn.textContent = 'Save' }
    return
  }

  // Today: use the real current time, so logging right after finishing
  // reflects an accurate clock time. A past day: the exact time isn't
  // known, so anchor near midday - just keeps the derived clock time
  // looking plausible; local_date below (not started_at) is what actually
  // decides which day this counts toward everywhere in the app now
  const isToday = dateStr === toDateStr(new Date())
  const endedAt = isToday ? new Date() : new Date(parseDateStr(dateStr).getTime() + 12 * 60 * 60000)
  const startedAt = new Date(endedAt.getTime() - durationMinutes * 60000)

  const { data, error } = await supabase
    .from('workout_sessions')
    .insert([{
      program_day_id: dayId,
      athlete_id: athlete.id,
      started_at: startedAt.toISOString(),
      ended_at: endedAt.toISOString(),
      local_date: dateStr,
      session_rpe: rpe,
      avg_heart_rate: avgHeartRate
    }])
    .select()

  if (error) {
    console.log(error)
    customAlert('Something went wrong saving your workout - please try again')
    const btn = document.getElementById('fieldSaveBtn')
    if (btn) { btn.disabled = false; btn.textContent = 'Save' }
    return
  }

  notifyCoach('workout_completed', `${athlete.name} completed ${activityName}`)
  await loadTrainingData()
  const entries = entriesByDate[dateStr] || []
  const entry = entries.find(e => e.day.id === dayId)
  renderWorkoutSummary(data[0], entry)
}
