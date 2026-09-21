// ==========================================================================
// DASHBOARD — screen
// Roster-wide stats for the coach: how many athletes trained, how many
// sessions and how much time, completion rate - over a window the coach
// picks - plus two "who needs a look" tiles (unreviewed 9-10 RPE flags,
// ACWR outside 0.8-1.5) that open a list of the actual athletes, each with
// a button straight to their profile. The coach decides what to do from
// there (lighten the plan, message them, ...); nothing here edits a plan.
//
// Numbers come from stats-calc.js (pure, tested on its own). This file only
// fetches and renders. Completion rate comes from the coach_completion_stats
// database function (sql-history.sql) - it needs every logged set, which is
// too much to download for a whole roster. If that function isn't installed
// yet, only the Completion tile is affected; everything else still loads.
// ==========================================================================
import { supabase } from '../../coachClient.js'
import * as nav from '../nav.js'
import { go } from '../router.js'
import { coachId } from '../session.js'
import { ensureCss } from '../lazy-css.js'
import {
  toDateStr, addDays, parseDateStr, resolveWindow,
  computeWindowStats, sumCompletion, computeDelta, computeRiskRows, formatDuration,
} from '../stats-calc.js'

const RANGES = [
  { key: 'week', label: 'Week' },
  { key: 'month', label: 'Month' },
  { key: 'quarter', label: '3 Months' },
  { key: 'half', label: '6 Months' },
  { key: 'year', label: 'Year' },
  { key: 'all', label: 'All time' },
  { key: 'custom', label: 'Custom' },
]
const RANGE_LABELS = { week: 'Last 7 days', month: 'Last 30 days', quarter: 'Last 90 days', half: 'Last 180 days', year: 'Last 365 days' }
const RANGE_STORAGE_KEY = 'tbflog-coach-stats-range'

// A pain/injury report stays until reviewed for as long as the athlete
// page's own inbox shows it (90 days); "heavy/tiring" flags never had a
// review button before this screen, so anything older than 30 days is left
// out rather than greeting the coach with a backlog they can't have seen.
const PAIN_FLAG_DAYS = 90
const HEAVY_FLAG_DAYS = 30
const LOAD_HISTORY_DAYS = 90

const TEMPLATE = `
  <div class="dashboard-header">
    <h2>Dashboard</h2>
  </div>
  <p class="screen-subtitle" style="margin-bottom:16px">How your roster is training. Only athletes with an active login count.</p>

  <div class="cd-toolbar">
    <div class="chip-row" id="cdRangeChips">
      ${RANGES.map(r => `<button type="button" class="chip-btn" data-range="${r.key}">${r.label}</button>`).join('')}
    </div>
    <div class="cd-custom" id="cdCustom" hidden>
      <input type="date" id="cdFrom" aria-label="From date" />
      <span class="cd-custom-sep">to</span>
      <input type="date" id="cdTo" aria-label="To date" />
      <button type="button" class="btn-save" id="cdApplyCustom">Apply</button>
    </div>
    <div class="cd-range-label" id="cdRangeLabel"></div>
  </div>

  <h3 class="detail-group-title cd-section-title">Training</h3>
  <div class="cd-tiles" id="cdTiles"></div>

  <h3 class="detail-group-title cd-section-title">Mobility</h3>
  <div class="cd-tiles cd-tiles-mobility" id="cdMobilityTiles"></div>

  <h3 class="detail-group-title cd-section-title">Needs attention</h3>
  <div class="cd-tiles cd-tiles-attn">
    <button type="button" class="cd-attn-tile" id="cdFlagsTile" disabled>
      <span class="cd-tile-label">RPE flags to review</span>
      <span class="cd-attn-value" id="cdFlagsValue">…</span>
      <span class="cd-tile-sub" id="cdFlagsSub">Loading...</span>
    </button>
    <button type="button" class="cd-attn-tile" id="cdRiskTile" disabled>
      <span class="cd-tile-label">Injury risk</span>
      <span class="cd-attn-value" id="cdRiskValue">…</span>
      <span class="cd-tile-sub" id="cdRiskSub">Loading...</span>
    </button>
  </div>

  <div class="modal-overlay" id="cdFlagsModal">
    <div class="modal modal-wide">
      <div class="graph-modal-header">
        <h2>RPE flags to review</h2>
        <button type="button" class="btn-cancel" data-close>✕</button>
      </div>
      <p class="cd-modal-sub">Sessions an athlete rated 9-10 and gave a reason for. Pain/injury reports from the last ${PAIN_FLAG_DAYS} days, heavy/tiring from the last ${HEAVY_FLAG_DAYS}.</p>
      <div class="cd-list" id="cdFlagsList"></div>
    </div>
  </div>

  <div class="modal-overlay" id="cdRiskModal">
    <div class="modal modal-wide">
      <div class="graph-modal-header">
        <h2>Injury risk</h2>
        <button type="button" class="btn-cancel" data-close>✕</button>
      </div>
      <p class="cd-modal-sub">ACWR compares this week's training load to the athlete's usual load over the last 4 weeks. Above 1.5 means load has ramped up faster than the body has adapted; below 0.8 can mean undertrained. Athletes need 4 weeks of rated sessions to appear here.</p>
      <div class="cd-list" id="cdRiskList"></div>
    </div>
  </div>
`

let root = null
let mountToken = null
let athletes = []
let trackedIds = new Set()
let athletesById = {}
let currentRange = 'week'
let customRange = null
let windowCache = new Map()
let requestSeq = 0
let flags = []
let riskRows = []
let onKeydown = null

function escapeHtml(str) {
  if (str == null) return ''
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

function formatDay(dateStr) {
  return parseDateStr(dateStr).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
}

function formatShortDay(dateStr) {
  return parseDateStr(dateStr).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

// PostgREST returns at most 1000 rows per request, so anything that can
// exceed that (a year of sessions across a roster) is fetched in pages.
// Ordered by id so a page boundary can't skip or repeat a row.
async function fetchAllPages(buildQuery) {
  const pageSize = 1000
  const rows = []
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await window.fetchWithRetry((signal) =>
      buildQuery().order('id').range(from, from + pageSize - 1).abortSignal(signal)
    )
    if (error) throw error
    rows.push(...data)
    if (data.length < pageSize) return rows
  }
}

function athleteStatus(athlete) {
  if (athlete.archived) return 'archived'
  if (athlete.user_id) return 'active'
  return athlete.email ? 'pending' : 'offline'
}

function rangeLabel(win) {
  if (currentRange === 'all') return 'All time'
  // "Sep 22 – Sep 21" is ambiguous on a year-long window, so the year is
  // added whenever the range crosses one
  const crossesYear = win.start.slice(0, 4) !== win.end.slice(0, 4)
  const fmt = crossesYear
    ? d => parseDateStr(d).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
    : formatShortDay
  const span = `${fmt(win.start)} – ${fmt(win.end)}`
  return currentRange === 'custom' ? `Custom · ${span}` : `${RANGE_LABELS[currentRange]} · ${span}`
}

function prevLabel(win) {
  return win.days === 7 ? 'previous 7 days' : `previous ${win.days} days`
}

function currentWindow() {
  return resolveWindow(currentRange, new Date(), customRange)
}

// ---- Window stats --------------------------------------------------------
// The database function is missing until sql-history.sql's
// coach_completion_stats block has been run once; PostgREST answers that
// with PGRST202 ("could not find the function"). Told apart from a real
// failure so the tile can say what to do instead of just "couldn't load".
function isMissingFunction(err) {
  return err && (err.code === 'PGRST202' || /coach_completion_stats/.test(err.message || ''))
}

async function fetchCompletion(start, end, todayStr) {
  // One attempt only: a missing function should say so straight away rather
  // than after fetchWithRetry's two backoff waits
  const { data, error } = await window.fetchWithRetry((signal) =>
    supabase.rpc('coach_completion_stats', { p_start: start, p_end: end, p_today: todayStr }).abortSignal(signal), 1)
  if (error) throw error
  return data
}

async function loadWindowStats(win) {
  const cacheKey = `${win.start}|${win.end}`
  if (windowCache.has(cacheKey)) return windowCache.get(cacheKey)

  const todayStr = toDateStr(new Date())
  const fetchFrom = win.prevStart || win.start // one query covers both periods

  // Sessions (training + mobility) and completion are independent: a failure
  // in completion only blanks that one tile.
  const sessionsP = fetchAllPages(() => {
    let q = supabase
      .from('workout_sessions')
      .select('id, athlete_id, session_type, local_date, started_at, ended_at')
      .not('ended_at', 'is', null)
      .lte('local_date', win.end)
    if (fetchFrom) q = q.gte('local_date', fetchFrom)
    return q
  })
  const completionP = Promise.all([
    fetchCompletion(win.start, win.end, todayStr),
    win.prevStart ? fetchCompletion(win.prevStart, win.prevEnd, todayStr) : Promise.resolve(null),
  ])

  const [sessionsResult, completionResult] = await Promise.allSettled([sessionsP, completionP])
  if (sessionsResult.status === 'rejected') throw sessionsResult.reason

  const sessions = sessionsResult.value
  const args = { trackedIds, sessions }
  const result = {
    cur: computeWindowStats({ ...args, start: win.start, end: win.end }),
    prev: win.prevStart ? computeWindowStats({ ...args, start: win.prevStart, end: win.prevEnd }) : null,
    completion: null,
    completionState: 'ok',
  }

  if (completionResult.status === 'fulfilled') {
    const [curRows, prevRows] = completionResult.value
    result.completion = {
      cur: sumCompletion(curRows, trackedIds),
      prev: prevRows ? sumCompletion(prevRows, trackedIds) : null,
    }
  } else {
    console.log('Error loading completion rate:', completionResult.reason)
    result.completionState = isMissingFunction(completionResult.reason) ? 'setup' : 'error'
  }

  // A window whose completion failed isn't cached, so looking at it again
  // (or hitting Retry) tries that part once more
  if (result.completionState === 'ok') windowCache.set(cacheKey, result)
  return result
}

function deltaHtml(delta, win) {
  if (!delta) return '<span class="cd-delta cd-delta-none"></span>'
  const arrow = delta.dir === 'up' ? '▲' : delta.dir === 'down' ? '▼' : '•'
  const text = delta.dir === 'flat' ? 'no change' : delta.text
  return `<span class="cd-delta cd-delta-${delta.dir}">${arrow} ${text}</span><span class="cd-delta-vs"> vs ${prevLabel(win)}</span>`
}

function tileHtml(label, value, sub, deltaMarkup) {
  return `
    <div class="cd-tile">
      <div class="cd-tile-label">${label}</div>
      <div class="cd-tile-value">${value}</div>
      <div class="cd-tile-sub">${sub}</div>
      <div class="cd-tile-delta">${deltaMarkup}</div>
    </div>`
}

function completionTile(win, stats) {
  const pct = v => v === null ? '—' : `${Math.round(v)}%`
  const label = 'Completion rate'
  if (stats.completionState === 'setup') {
    return tileHtml(label, '—', 'needs a one-time database update - see sql-history.sql', '')
  }
  if (stats.completionState === 'error') {
    return tileHtml(label, '—', 'couldn\'t load - tap the range again to retry', '')
  }
  const { cur, prev } = stats.completion
  return tileHtml(label, pct(cur.pct), `${cur.completed} of ${cur.scheduled} scheduled workouts`,
    deltaHtml(prev ? computeDelta(cur.pct, prev.pct, 'points') : null, win))
}

function renderTiles(win, stats) {
  const { cur, prev } = stats
  const pct = v => v === null ? '—' : `${Math.round(v)}%`
  const d = (delta) => deltaHtml(delta, win)

  root.querySelector('#cdTiles').innerHTML = [
    tileHtml('Athletes active', pct(cur.activePct), `${cur.activeAthletes} of ${cur.trackedAthletes} athletes`,
      d(prev ? computeDelta(cur.activePct, prev.activePct, 'points') : null)),
    tileHtml('Sessions completed', cur.sessions.toLocaleString(), 'finished workouts',
      d(prev ? computeDelta(cur.sessions, prev.sessions, 'percent') : null)),
    tileHtml('Total training time', formatDuration(cur.minutes), 'across all athletes',
      d(prev ? computeDelta(cur.minutes, prev.minutes, 'percent') : null)),
    completionTile(win, stats),
  ].join('')

  root.querySelector('#cdMobilityTiles').innerHTML = [
    tileHtml('Mobility sessions', cur.mobilitySessions.toLocaleString(), 'finished stretching sessions',
      d(prev ? computeDelta(cur.mobilitySessions, prev.mobilitySessions, 'percent') : null)),
    tileHtml('Total mobility time', formatDuration(cur.mobilityMinutes), 'across all athletes',
      d(prev ? computeDelta(cur.mobilityMinutes, prev.mobilityMinutes, 'percent') : null)),
  ].join('')
}

function renderTilesLoading() {
  const skeleton = `
    <div class="cd-tile">
      <div class="skeleton-bar" style="width:55%; height:12px; margin-bottom:14px"></div>
      <div class="skeleton-bar" style="width:40%; height:30px; margin-bottom:10px"></div>
      <div class="skeleton-bar" style="width:70%; height:12px"></div>
    </div>`
  root.querySelector('#cdTiles').innerHTML = skeleton.repeat(4)
  root.querySelector('#cdMobilityTiles').innerHTML = skeleton.repeat(2)
}

async function refreshWindow() {
  const seq = ++requestSeq
  const win = currentWindow()

  root.querySelector('#cdRangeLabel').textContent = rangeLabel(win)
  root.querySelectorAll('#cdRangeChips .chip-btn').forEach(btn => {
    btn.classList.toggle('selected', btn.dataset.range === currentRange)
  })
  root.querySelector('#cdCustom').hidden = currentRange !== 'custom'

  if (!windowCache.has(`${win.start}|${win.end}`)) renderTilesLoading()

  try {
    const stats = await loadWindowStats(win)
    if (seq !== requestSeq || !root || !nav.isCurrent(mountToken)) return
    renderTiles(win, stats)
  } catch (err) {
    if (seq !== requestSeq || !root) return
    console.log('Error loading dashboard stats:', err)
    root.querySelector('#cdMobilityTiles').innerHTML = ''
    root.querySelector('#cdTiles').innerHTML = `
      <div class="cd-tile cd-tile-error">
        <div class="cd-tile-label">Couldn't load stats</div>
        <div class="cd-tile-sub">Check your connection and try again.</div>
        <button type="button" class="btn-profile-action" id="cdRetryBtn" style="margin-top:12px">Retry</button>
      </div>`
    root.querySelector('#cdRetryBtn').addEventListener('click', refreshWindow)
  }
}

// ---- Needs attention -----------------------------------------------------
async function loadFlags() {
  const since = toDateStr(addDays(new Date(), -(PAIN_FLAG_DAYS - 1)))
  const heavySince = toDateStr(addDays(new Date(), -(HEAVY_FLAG_DAYS - 1)))
  const rows = await fetchAllPages(() => supabase
    .from('workout_sessions')
    .select('id, athlete_id, local_date, session_rpe, rpe_flag_reason, rpe_flag_note')
    .not('rpe_flag_reason', 'is', null)
    .is('rpe_flag_reviewed_at', null)
    .gte('local_date', since)
  )
  return rows
    .filter(r => trackedIds.has(r.athlete_id) && (r.rpe_flag_reason === 'pain_injury' || r.local_date >= heavySince))
    .sort((a, b) => {
      // Pain/injury before heavy/tiring, newest first within each
      if (a.rpe_flag_reason !== b.rpe_flag_reason) return a.rpe_flag_reason === 'pain_injury' ? -1 : 1
      return a.local_date < b.local_date ? 1 : -1
    })
}

async function loadRisk() {
  const since = toDateStr(addDays(new Date(), -(LOAD_HISTORY_DAYS - 1)))
  const sessions = await fetchAllPages(() => supabase
    .from('workout_sessions')
    .select('id, athlete_id, local_date, started_at, ended_at, session_rpe')
    .not('ended_at', 'is', null)
    .not('session_rpe', 'is', null)
    .gte('local_date', since)
  )
  return computeRiskRows({
    athletes: athletes.filter(a => trackedIds.has(a.id)),
    sessions,
    todayStr: toDateStr(new Date()),
  })
}

function renderAttentionTile(prefix, count, sub, hasError) {
  const tile = root.querySelector(`#cd${prefix}Tile`)
  root.querySelector(`#cd${prefix}Value`).textContent = hasError ? '—' : String(count)
  root.querySelector(`#cd${prefix}Sub`).textContent = sub
  tile.disabled = hasError || count === 0
  tile.classList.toggle('cd-attn-alert', !hasError && count > 0)
  tile.classList.toggle('cd-attn-clear', !hasError && count === 0)
}

function renderFlagsTile() {
  const athleteCount = new Set(flags.map(f => f.athlete_id)).size
  const sub = flags.length === 0
    ? 'All clear'
    : `${flags.length} flag${flags.length === 1 ? '' : 's'} · tap to see who`
  renderAttentionTile('Flags', athleteCount, flags.length === 0 ? sub : `athlete${athleteCount === 1 ? '' : 's'} · ${sub}`, false)
}

function renderRiskTile() {
  const spikes = riskRows.filter(r => r.kind === 'spike').length
  const under = riskRows.length - spikes
  const sub = riskRows.length === 0
    ? 'All clear'
    : `${spikes} spike · ${under} undertrained · tap to see who`
  renderAttentionTile('Risk', riskRows.length, sub, false)
}

function renderFlagsList() {
  const list = root.querySelector('#cdFlagsList')
  if (flags.length === 0) {
    list.innerHTML = '<p class="no-metrics">Nothing to review.</p>'
    return
  }
  list.innerHTML = flags.map(f => {
    const athlete = athletesById[f.athlete_id]
    const pain = f.rpe_flag_reason === 'pain_injury'
    return `
      <div class="cd-row" data-session-id="${f.id}" data-athlete-id="${f.athlete_id}">
        <div class="cd-row-main">
          <div class="cd-row-name">${escapeHtml(athlete ? athlete.name : 'Athlete')}</div>
          <div class="cd-row-meta">${formatDay(f.local_date)} · RPE ${f.session_rpe}/10 <span class="cd-tag ${pain ? 'cd-tag-pain' : 'cd-tag-heavy'}">${pain ? 'Pain / injury' : 'Heavy / tiring'}</span></div>
          ${f.rpe_flag_note ? `<p class="cd-row-note">${escapeHtml(f.rpe_flag_note)}</p>` : ''}
        </div>
        <div class="cd-row-actions">
          <button type="button" class="unit-btn" data-action="review">Mark reviewed</button>
          <button type="button" class="btn-save" data-action="profile">Go to profile</button>
        </div>
      </div>`
  }).join('')
}

function renderRiskList() {
  const list = root.querySelector('#cdRiskList')
  if (riskRows.length === 0) {
    list.innerHTML = '<p class="no-metrics">No athletes outside the 0.8-1.5 range.</p>'
    return
  }
  const fmt = n => Math.round(n).toLocaleString()
  list.innerHTML = riskRows.map(r => `
    <div class="cd-row" data-athlete-id="${r.athlete.id}">
      <div class="cd-row-main">
        <div class="cd-row-name">${escapeHtml(r.athlete.name)}</div>
        <div class="cd-row-meta">ACWR ${r.acwr.toFixed(2)} <span class="cd-tag ${r.kind === 'spike' ? 'cd-tag-pain' : 'cd-tag-under'}">${r.kind === 'spike' ? 'Load spike' : 'Undertrained'}</span></div>
        <p class="cd-row-note">This week's load ${fmt(r.acute)} vs their usual ${fmt(r.chronic)}</p>
      </div>
      <div class="cd-row-actions">
        <button type="button" class="btn-save" data-action="profile">Go to profile</button>
      </div>
    </div>`).join('')
}

async function loadAttention(token) {
  const [flagsResult, riskResult] = await Promise.allSettled([loadFlags(), loadRisk()])
  if (!root || !nav.isCurrent(token)) return

  if (flagsResult.status === 'fulfilled') {
    flags = flagsResult.value
    renderFlagsTile()
    renderFlagsList()
  } else {
    console.log('Error loading RPE flags:', flagsResult.reason)
    renderAttentionTile('Flags', 0, 'couldn\'t load', true)
  }

  if (riskResult.status === 'fulfilled') {
    riskRows = riskResult.value
    renderRiskTile()
    renderRiskList()
  } else {
    console.log('Error loading injury risk:', riskResult.reason)
    renderAttentionTile('Risk', 0, 'couldn\'t load', true)
  }
}

// ---- Events --------------------------------------------------------------
function openModal(id) { root.querySelector(id).classList.add('active') }
function closeModals() { root.querySelectorAll('.modal-overlay.active').forEach(m => m.classList.remove('active')) }

function bindEvents() {
  root.querySelector('#cdRangeChips').addEventListener('click', function(e) {
    const btn = e.target.closest('.chip-btn')
    if (!btn) return
    const range = btn.dataset.range
    if (range === 'custom') {
      // Reveals the pickers and shows the last 30 days until the coach
      // applies their own dates - editing a date alone doesn't fetch, only
      // Apply does, so half-typed dates can't trigger a query.
      currentRange = 'custom'
      const today = new Date()
      if (!customRange) customRange = { start: toDateStr(addDays(today, -29)), end: toDateStr(today) }
      root.querySelector('#cdFrom').value = customRange.start
      root.querySelector('#cdTo').value = customRange.end
      root.querySelector('#cdTo').max = toDateStr(today)
      refreshWindow()
      return
    }
    currentRange = range
    try { localStorage.setItem(RANGE_STORAGE_KEY, range) } catch (err) { /* storage can be blocked - the choice just isn't remembered */ }
    refreshWindow()
  })

  root.querySelector('#cdApplyCustom').addEventListener('click', function() {
    const start = root.querySelector('#cdFrom').value
    const end = root.querySelector('#cdTo').value
    if (!start || !end) { customAlert('Pick both a start and an end date'); return }
    if (start > end) { customAlert('The start date has to be before the end date'); return }
    if (start > toDateStr(new Date())) { customAlert('The start date can\'t be in the future'); return }
    customRange = { start, end }
    refreshWindow()
  })

  root.querySelector('#cdFlagsTile').addEventListener('click', () => openModal('#cdFlagsModal'))
  root.querySelector('#cdRiskTile').addEventListener('click', () => openModal('#cdRiskModal'))

  root.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', function(e) {
      if (e.target === overlay || e.target.closest('[data-close]')) overlay.classList.remove('active')
    })
  })
  onKeydown = function(e) { if (e.key === 'Escape') closeModals() }
  document.addEventListener('keydown', onKeydown)

  // Shared by both lists: Go to profile / Mark reviewed. Bound to the lists
  // themselves, not `root` - root is the page container that outlives this
  // screen, so a listener there would stack up on every visit.
  async function onRowAction(e) {
    const btn = e.target.closest('.cd-row [data-action]')
    if (!btn) return
    const row = btn.closest('.cd-row')

    if (btn.dataset.action === 'profile') {
      go('athlete-detail', { id: Number(row.dataset.athleteId) })
      return
    }

    if (btn.dataset.action === 'review') {
      btn.disabled = true
      btn.textContent = 'Marking...'
      const { error } = await supabase
        .from('workout_sessions')
        .update({ rpe_flag_reviewed_at: new Date().toISOString() })
        .eq('id', row.dataset.sessionId)
      if (!root) return
      if (error) {
        console.log(error)
        customAlert('Something went wrong - please try again')
        btn.disabled = false
        btn.textContent = 'Mark reviewed'
        return
      }
      flags = flags.filter(f => f.id !== row.dataset.sessionId)
      renderFlagsTile()
      renderFlagsList()
      if (flags.length === 0) closeModals()
    }
  }
  root.querySelector('#cdFlagsList').addEventListener('click', onRowAction)
  root.querySelector('#cdRiskList').addEventListener('click', onRowAction)
}

export async function mount(container, params, token) {
  root = container
  mountToken = token
  ensureCss('css/stats.css?v=2')
  container.innerHTML = TEMPLATE
  renderTilesLoading()

  try {
    const stored = localStorage.getItem(RANGE_STORAGE_KEY)
    if (stored && RANGES.some(r => r.key === stored && r.key !== 'custom')) currentRange = stored
  } catch (err) { /* storage can be blocked - fall back to the default */ }

  const { data, error } = await window.fetchWithRetry((signal) =>
    supabase.from('athletes').select('id, name, archived, user_id, email').eq('coach_id', coachId()).abortSignal(signal)
  )
  if (!root || !nav.isCurrent(token)) return
  if (error) {
    console.log('Error loading athletes for dashboard:', error)
    container.innerHTML = `
      <div class="screen-message">
        <h2>Couldn't load your dashboard</h2>
        <p>Check your connection and try again.</p>
        <button class="btn-save" id="cdReloadBtn" style="margin-top:16px">Retry</button>
      </div>`
    container.querySelector('#cdReloadBtn').addEventListener('click', () => mount(container, params, token))
    return
  }

  athletes = data
  athletesById = Object.fromEntries(athletes.map(a => [a.id, a]))
  trackedIds = new Set(athletes.filter(a => athleteStatus(a) === 'active').map(a => a.id))

  bindEvents()
  refreshWindow()
  loadAttention(token)
}

export function unmount() {
  if (onKeydown) document.removeEventListener('keydown', onKeydown)
  onKeydown = null
  root = null
  mountToken = null
  athletes = []
  athletesById = {}
  trackedIds = new Set()
  windowCache = new Map()
  flags = []
  riskRows = []
  customRange = null
  requestSeq++ // orphan any fetch still in flight
}
