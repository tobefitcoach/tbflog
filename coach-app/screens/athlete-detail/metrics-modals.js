// ==========================================================================
// ATHLETE DETAIL - Metrics tab popups
// PR overview, metrics tracked, total entries, last updated, the graph modal
// and the entries modal.
// ==========================================================================
import { supabase } from '../../../coachClient.js?v=__V__'
import * as nav from '../../nav.js?v=__V__'
import { loadChartJs } from '../../vendor.js?v=__V__'
import { toDateStr, parseDateStr } from '../../../shared/dates.js?v=__V__'
import { root, mountToken, athleteId, ov, met } from './state.js?v=__V__'
import { convertInput, convertValue, loadAthleteMetrics, pctChange } from './metrics.js?v=__V__'
import { formatDisplayDate, openChangeExplain } from './overview.js?v=__V__'
import { fetchAllRows, runOnce } from '../../../shared/fetch-all.js?v=__V__'
import { customAlert, customConfirm } from '../../../confirm-modal.js?v=__V__'

// ==========================================================================
// ---- PR OVERVIEW MODAL ----
// Opened by clicking the "PRs (last 30 days)" stat tile. Shows prEvents
// (filled in by loadStatsBar above) grouped by category, then by individual
// metric, with each metric's PRs listed chronologically (oldest first) so
// repeat PRs on the same metric read as a clear progression.
// ==========================================================================

// Same value-formatting rules used by the "All Entries" table, per metric type
function formatMeasurementValue(metric, entry) {
  if (metric.type === 'pogo') {
    const converted = convertValue(entry.height, metric.display_unit)
    return `RSI ${entry.rsi} (H: ${converted.text}${converted.unit}, GCT: ${entry.ground_contact}ms)`
  } else if (metric.type === 'zone2') {
    return `Score: ${entry.value}`
  } else {
    const converted = convertValue(entry.value, metric.display_unit)
    return `${converted.text} ${converted.unit}`
  }
}

// Shared category order for all "grouped by category" detail modals -
// known categories first in this fixed order, anything unrecognized
// falls back to the end, alphabetically
function sortCategories(categoryNames) {
  const categoryOrder = ['Jumps', 'Sprints', 'Strength', 'Cardio']
  return categoryNames.sort((a, b) => {
    const ai = categoryOrder.indexOf(a)
    const bi = categoryOrder.indexOf(b)
    if (ai === -1 && bi === -1) return a.localeCompare(b)
    if (ai === -1) return 1
    if (bi === -1) return -1
    return ai - bi
  })
}

export function renderPRModal() {
  const container = root.querySelector('#prList')

  if (met.prEvents.length === 0) {
    container.innerHTML = '<p style="color:#aaaacc;text-align:center;padding:20px">No PRs broken in the last 30 days</p>'
    return
  }

  // Group PR events: category -> metric name -> array of {metric, entry}
  const byCategory = {}
  for (const ev of met.prEvents) {
    const category = ev.metric.category || 'Other'
    const metricName = ev.metric.name
    if (!byCategory[category]) byCategory[category] = {}
    if (!byCategory[category][metricName]) byCategory[category][metricName] = []
    byCategory[category][metricName].push(ev)
  }

  const categories = sortCategories(Object.keys(byCategory))

  container.innerHTML = categories.map(category => `
    <div class="detail-category">
      <h3 class="category-title">${category}</h3>
      ${Object.keys(byCategory[category]).sort().map(metricName => {
        // Chronological (oldest first) so multiple PRs on the same metric show progression
        const events = byCategory[category][metricName].sort((a, b) => a.entry.date.localeCompare(b.entry.date))
        return `
          <div class="detail-group">
            <h4 class="detail-group-title">${metricName}</h4>
            <ul class="detail-list">
              ${events.map(ev => `
                <li class="detail-row">
                  <span>${ev.entry.date}</span>
                  <span class="detail-row-value">${formatMeasurementValue(ev.metric, ev.entry)}</span>
                </li>
              `).join('')}
            </ul>
          </div>
        `
      }).join('')}
    </div>
  `).join('')
}

// ==========================================================================
// ---- METRICS TRACKED MODAL ----
// Opened by clicking the "Metrics tracked" stat tile. Lists every metric
// currently assigned to this athlete, grouped by category.
// ==========================================================================
export function renderMetricsTrackedModal() {
  const container = root.querySelector('#metricsTrackedList')

  if (met.athleteMetrics.length === 0) {
    container.innerHTML = '<p style="color:#aaaacc;text-align:center;padding:20px">No metrics tracked yet</p>'
    return
  }

  // Group tracked metrics by category
  const byCategory = {}
  for (const am of met.athleteMetrics) {
    const metric = am.metrics
    if (!metric) continue
    const category = metric.category || 'Other'
    if (!byCategory[category]) byCategory[category] = []
    byCategory[category].push(metric)
  }

  const categoryTypeLabels = { simple: 'Simple', pogo: 'Pogo', zone2: 'Zone 2' }
  const categories = sortCategories(Object.keys(byCategory))

  container.innerHTML = categories.map(category => `
    <div class="detail-category">
      <h3 class="category-title">${category}</h3>
      <ul class="detail-list">
        ${byCategory[category].sort((a, b) => a.name.localeCompare(b.name)).map(metric => `
          <li class="detail-row">
            <span>${metric.name}</span>
            <span class="detail-row-value">${categoryTypeLabels[metric.type] || metric.type}</span>
          </li>
        `).join('')}
      </ul>
    </div>
  `).join('')
}

// ==========================================================================
// ---- TOTAL ENTRIES MODAL ----
// Opened by clicking the "Total entries" stat tile. Shows how many
// measurements are logged per metric, grouped by category.
// ==========================================================================
export function renderTotalEntriesModal() {
  const container = root.querySelector('#totalEntriesList')

  if (met.allMeasurementsCache.length === 0) {
    container.innerHTML = '<p style="color:#aaaacc;text-align:center;padding:20px">No entries logged yet</p>'
    return
  }

  // Count entries per metric, grouped by category (skip metrics with 0 entries)
  const byCategory = {}
  for (const am of met.athleteMetrics) {
    const metric = am.metrics
    if (!metric) continue
    const count = met.allMeasurementsCache.filter(m => m.metric_id === metric.id).length
    if (count === 0) continue
    const category = metric.category || 'Other'
    if (!byCategory[category]) byCategory[category] = []
    byCategory[category].push({ metric, count })
  }

  const categories = sortCategories(Object.keys(byCategory))

  container.innerHTML = categories.map(category => `
    <div class="detail-category">
      <h3 class="category-title">${category}</h3>
      <ul class="detail-list">
        ${byCategory[category].sort((a, b) => a.metric.name.localeCompare(b.metric.name)).map(({ metric, count }) => `
          <li class="detail-row">
            <span>${metric.name}</span>
            <span class="detail-row-value">${count} ${count === 1 ? 'entry' : 'entries'}</span>
          </li>
        `).join('')}
      </ul>
    </div>
  `).join('')
}

// ==========================================================================
// ---- LAST UPDATED / RECENT ACTIVITY MODAL ----
// Opened by clicking the "Last updated" stat tile. Reverse-chronological
// feed of every entry logged, newest first, across all metrics.
// ==========================================================================

// How many entries per page (21-40, 41-60, etc), and which page we're currently on
const RECENT_ACTIVITY_PAGE_SIZE = 20

export function renderLastUpdatedModal() {
  const container = root.querySelector('#lastUpdatedList')

  if (met.allMeasurementsCache.length === 0) {
    container.innerHTML = '<p style="color:#aaaacc;text-align:center;padding:20px">No entries logged yet</p>'
    return
  }

  // Map metric_id -> metric so each measurement can show its metric's name and formatted value
  const metricById = {}
  for (const am of met.athleteMetrics) {
    if (am.metrics) metricById[am.metrics.id] = am.metrics
  }

  const sorted = [...met.allMeasurementsCache].sort((a, b) => b.date.localeCompare(a.date))

  const start = met.recentActivityPage * RECENT_ACTIVITY_PAGE_SIZE
  const end = start + RECENT_ACTIVITY_PAGE_SIZE
  const pageEntries = sorted.slice(start, end)
  const hasPrev = met.recentActivityPage > 0
  const hasNext = end < sorted.length

  // Group same-day entries together under one date heading, so the date
  // isn't repeated on every row and same-day entries are easy to see as a batch
  const byDate = {}
  const dateOrder = []
  for (const m of pageEntries) {
    if (!byDate[m.date]) { byDate[m.date] = []; dateOrder.push(m.date) }
    byDate[m.date].push(m)
  }

  container.innerHTML = `
    ${dateOrder.map(date => `
      <div class="detail-group">
        <h4 class="detail-group-title">${formatDisplayDate(date)}</h4>
        <ul class="detail-list">
          ${byDate[date].map(m => {
            const metric = metricById[m.metric_id]
            if (!metric) return ''
            return `
              <li class="detail-row">
                <span>${metric.name}</span>
                <span class="detail-row-value">${formatMeasurementValue(metric, m)}</span>
              </li>
            `
          }).join('')}
        </ul>
      </div>
    `).join('')}
    <div class="pagination-row">
      ${hasPrev ? '<button class="icon-btn" id="prevActivityBtn" aria-label="Previous page"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"></polyline></svg></button>' : '<span></span>'}
      <span class="pagination-label">${start + 1}–${Math.min(end, sorted.length)} of ${sorted.length}</span>
      ${hasNext ? '<button class="icon-btn" id="nextActivityBtn" aria-label="Next page"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"></polyline></svg></button>' : '<span></span>'}
    </div>
  `

  if (hasPrev) {
    root.querySelector('#prevActivityBtn').addEventListener('click', function() {
      met.recentActivityPage--
      renderLastUpdatedModal()
    })
  }

  if (hasNext) {
    root.querySelector('#nextActivityBtn').addEventListener('click', function() {
      met.recentActivityPage++
      renderLastUpdatedModal()
    })
  }
}

// ==========================================================================
// ---- GRAPH MODAL ----
// Full-size Chart.js graph for one metric, with 1M/3M/1Y/All time filters.
// ==========================================================================

// ---- Auto-scaled averaging ----
// A fluctuating metric (day-to-day Zone 2 pace, say) is hard to read as a
// trend one raw entry at a time - each point below is instead the average
// of every entry in its week/2-week/month bucket, with the bucket size
// auto-scaled to the selected time range so a short window still shows
// enough points to be useful, and a long one doesn't stay just as jittery
// as the raw data. 1M is left as 'raw' (no averaging) since a month rarely
// has enough entries for averaging to help rather than just erase them.
const GRANULARITY_FOR_MONTHS = { 1: 'raw', 3: 'weekly', 6: 'biweekly', 12: 'monthly', 0: 'monthly' }
const GRANULARITY_LABELS = { raw: '', weekly: 'Showing weekly averages', biweekly: 'Showing biweekly averages', monthly: 'Showing monthly averages' }

function averageOf(nums) {
  const valid = nums.filter(n => n != null && !Number.isNaN(n))
  return valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : null
}

// Buckets are aligned to a fixed reference Monday, not the query's own start
// date - so a bucket's boundaries stay the same regardless of which time
// filter is active, which is what lets the metric series and the bodyweight
// overlay series (aggregated separately, via the same function) land on
// exactly the same bucket dates and merge cleanly onto one x-axis.
function chartBucketKey(dateStr, granularity) {
  const d = parseDateStr(dateStr)
  if (granularity === 'monthly') {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`
  }
  const dayMs = 86400000
  const weekLength = granularity === 'biweekly' ? 14 : 7
  const epochMonday = new Date('2024-01-01T00:00:00') // an arbitrary real Monday, just a fixed grid reference
  const bucketIndex = Math.floor(Math.round((d - epochMonday) / dayMs) / weekLength)
  return toDateStr(new Date(epochMonday.getTime() + bucketIndex * weekLength * dayMs))
}

// Averages every listed field across entries sharing a bucket, returning one
// synthetic entry per bucket dated to the bucket's start. 'raw' is a no-op -
// callers pass every field formatMeasurementValue()/getValue() might read
// for the current metric type, so an aggregated point still has everything
// its tooltip needs (e.g. pogo's height/ground_contact alongside rsi).
function aggregateEntriesForChart(entries, granularity, valueFields) {
  if (granularity === 'raw' || entries.length === 0) return entries
  const buckets = new Map()
  for (const e of entries) {
    const key = chartBucketKey(e.date, granularity)
    if (!buckets.has(key)) buckets.set(key, [])
    buckets.get(key).push(e)
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, group]) => {
      const out = { date: key }
      for (const field of valueFields) out[field] = averageOf(group.map(e => e[field]))
      return out
    })
}

export async function openGraphModal(metric) {
  met.currentGraphMetric = metric
  root.querySelector('#graphModalTitle').textContent = metric.name
  root.querySelector('#graphModal').classList.add('active')

  // Set 1M as default active filter
  root.querySelectorAll('.time-filter-btn[data-months]').forEach(btn => btn.classList.remove('active'))
  root.querySelector('.time-filter-btn[data-months="1"]').classList.add('active')

  // Bodyweight overlay always starts off when opening a graph, so it's
  // never confusingly left on for a metric you didn't turn it on for
  met.showBodyweightOverlay = false
  root.querySelector('#bodyweightOverlayToggle').checked = false

  await loadGraphData(1)
}

// Fetches measurements for the selected time range and (re)draws the chart
async function loadGraphData(months) {
  const token = mountToken
  met.currentGraphMonths = months

  let fromDateStr = null
  if (months > 0) {
    const fromDate = new Date()
    fromDate.setMonth(fromDate.getMonth() - months)
    fromDateStr = toDateStr(fromDate)
  }

  // Paged - "All time" on a daily metric passes the 1,000-row cap
  const { data } = await fetchAllRows(runOnce, () => {
    let query = supabase
      .from('measurements')
      .select('*')
      .eq('athlete_id', athleteId)
      .eq('metric_id', met.currentGraphMetric.id)
      .order('date', { ascending: true })
    if (fromDateStr) query = query.gte('date', fromDateStr)
    return query
  })
  if (!nav.isCurrent(token)) return

  // For Zone 2 metrics, show total km run within the selected time filter above the graph
  const periodStatEl = root.querySelector('#graphPeriodStat')
  if (met.currentGraphMetric.type === 'zone2') {
    const periodLabels = { 1: 'last month', 3: 'last 3 months', 6: 'last 6 months', 12: 'last year', 0: 'all time' }
    const totalKm = data ? data.reduce((sum, m) => sum + (m.distance || 0), 0).toFixed(1) : '0.0'
    periodStatEl.textContent = `${totalKm} km run · ${periodLabels[months]}`
  } else {
    periodStatEl.textContent = ''
  }

  // % change badge next to the title, recalculated for whichever time range
  // is currently selected: compares the average of the selected period
  // (e.g. the last 6 months, already loaded as `data` above) to the average
  // of the same-length period immediately before it (the 6 months before
  // that). "All" has no equivalent "previous" period to compare against, so
  // it falls back to splitting all-time data into an earlier half vs a
  // recent half instead.
  const changeStatEl = root.querySelector('#graphChangeStat')
  const periodBadgeLabels = { 1: '1M', 3: '3M', 6: '6M', 12: '1Y', 0: 'All' }
  const getValue = m => met.currentGraphMetric.type === 'pogo' ? m.rsi : m.value

  let currentPeriodData = data
  let previousPeriodData = null

  if (months > 0) {
    const currentStart = new Date()
    currentStart.setMonth(currentStart.getMonth() - months)
    const previousStart = new Date()
    previousStart.setMonth(previousStart.getMonth() - months * 2)

    const { data: prevData } = await supabase
      .from('measurements')
      .select('*')
      .eq('athlete_id', athleteId)
      .eq('metric_id', met.currentGraphMetric.id)
      .gte('date', toDateStr(previousStart))
      .lt('date', toDateStr(currentStart))

    if (!nav.isCurrent(token)) return
    previousPeriodData = prevData
  } else if (data && data.length >= 2) {
    const half = Math.floor(data.length / 2)
    previousPeriodData = data.slice(0, half)
    currentPeriodData = data.slice(half)
  }

  const currentAvg = currentPeriodData && currentPeriodData.length ? currentPeriodData.reduce((sum, m) => sum + getValue(m), 0) / currentPeriodData.length : null
  const previousAvg = previousPeriodData && previousPeriodData.length ? previousPeriodData.reduce((sum, m) => sum + getValue(m), 0) / previousPeriodData.length : null
  const pct = currentAvg === null || previousAvg === null ? null : pctChange(currentAvg, previousAvg)
  if (pct === null) {
    changeStatEl.innerHTML = ''
  } else {
    const higherIsBetter = met.currentGraphMetric.higher_is_better
    const isPositive = higherIsBetter ? pct > 0 : pct < 0
    const cssClass = pct === 0 ? 'neutral' : isPositive ? 'positive' : 'negative'
    const arrow = pct > 0 ? '▲' : '▼'

    changeStatEl.innerHTML = `<span class="metric-change ${cssClass}" style="cursor:pointer" data-explain-type="period" data-metric-type="${met.currentGraphMetric.type}" data-metric-name="${met.currentGraphMetric.name}" data-period-label="${periodBadgeLabels[months]}" data-first-avg="${previousAvg.toFixed(3)}" data-second-avg="${currentAvg.toFixed(3)}" data-pct="${pct}" data-higher="${higherIsBetter}" data-unit="${met.currentGraphMetric.display_unit || met.currentGraphMetric.unit}">${arrow} ${Math.abs(pct)}%</span>`

    const badge = changeStatEl.querySelector('.metric-change')
    badge.addEventListener('click', function() { openChangeExplain(badge) })
  }

  if (!data || data.length === 0) {
    if (met.fullChart) { met.fullChart.destroy(); met.fullChart = null }
    root.querySelector('#graphGranularityNote').textContent = ''
    return
  }

  const granularity = GRANULARITY_FOR_MONTHS[months]
  root.querySelector('#graphGranularityNote').textContent = GRANULARITY_LABELS[granularity]
  // Every field either render function's tooltip might read for this
  // metric's type - see formatMeasurementValue()/getValue() - so an
  // averaged bucket still has everything it needs to display correctly
  const chartData = aggregateEntriesForChart(data, granularity, ['value', 'rsi', 'height', 'ground_contact'])

  // Chart.js sizes its canvas from rendered pixel dimensions, so the graph
  // modal is already open (display isn't none) by the time this loads -
  // see this file's top banner comment for the full lazy-load rationale.
  await loadChartJs()
  if (!nav.isCurrent(token)) return

  if (met.showBodyweightOverlay) {
    await renderGraphWithBodyweightOverlay(chartData, months, granularity)
  } else {
    renderGraphRaw(chartData)
  }
}

// Shared dark-theme tooltip styling for both graph render functions below.
// `extra` can add/override fields (e.g. custom callbacks.label).
function themedTooltipOptions(extra) {
  return Object.assign({
    backgroundColor: '#1a1a2e',
    titleColor: '#ffffff',
    bodyColor: '#ffffff',
    borderColor: '#2a2a4e',
    borderWidth: 1,
    padding: 10,
    displayColors: true
  }, extra)
}

// Default view: this metric's own values in their own unit (cm, score, RSI, etc)
function renderGraphRaw(data) {
  const labels = data.map(m => m.date)
  const values = data.map(m => met.currentGraphMetric.type === 'pogo' ? m.rsi : m.value)

  if (met.fullChart) met.fullChart.destroy()

  const ctx = root.querySelector('#fullGraph').getContext('2d')
  met.fullChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: met.currentGraphMetric.name,
        data: values,
        borderColor: '#4a4a8e',
        backgroundColor: 'rgba(74, 74, 142, 0.12)',
        borderWidth: 2,
        pointRadius: 4,
        pointHoverRadius: 6,
        pointBackgroundColor: '#4a4a8e',
        tension: 0.35,
        cubicInterpolationMode: 'monotone',
        fill: true
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: themedTooltipOptions()
      },
      scales: {
        x: {
          ticks: { color: '#aaaacc' },
          grid: { color: '#2a2a4e' }
        },
        y: {
          ticks: { color: '#aaaacc' },
          grid: { color: '#2a2a4e' }
        }
      }
    }
  })
}

// Bodyweight overlay view: the metric (cm, score, RSI...) and bodyweight
// (kg) are completely different scales, so plotting both in their raw units
// on one axis - or bolting on a second y-axis - would be misleading. Instead
// both are indexed to "% change from the first value in this time range",
// which puts them on one shared, honest axis. The hover tooltip still shows
// each line's real value (metric in its own unit, bodyweight in kg/lbs), so
// the % is just how they're drawn, not how they're read.
async function renderGraphWithBodyweightOverlay(data, months, granularity) {
  const token = mountToken
  let fromDateStr = null
  if (months > 0) {
    const fromDate = new Date()
    fromDate.setMonth(fromDate.getMonth() - months)
    fromDateStr = toDateStr(fromDate)
  }

  const { data: bwDataRaw } = await fetchAllRows(runOnce, () => {
    let bwQuery = supabase
      .from('bodyweight')
      .select('*')
      .eq('athlete_id', athleteId)
      .order('date', { ascending: true })
    if (fromDateStr) bwQuery = bwQuery.gte('date', fromDateStr)
    return bwQuery
  })
  if (!nav.isCurrent(token)) return
  // Aggregated with the exact same bucketing as the metric series (both go
  // through chartBucketKey with the same granularity), so the two series'
  // bucket dates line up and merge cleanly below instead of drifting apart
  const bwData = aggregateEntriesForChart(bwDataRaw || [], granularity, ['weight'])

  // Also grab the last bodyweight entry logged BEFORE this window, so if
  // nothing was logged during the selected range the line still carries
  // forward the athlete's last known weight instead of just disappearing
  let carryInWeight = null
  if (fromDateStr) {
    const { data: priorData } = await supabase
      .from('bodyweight')
      .select('weight')
      .eq('athlete_id', athleteId)
      .lt('date', fromDateStr)
      .order('date', { ascending: false })
      .limit(1)
    if (!nav.isCurrent(token)) return
    if (priorData && priorData.length > 0) carryInWeight = priorData[0].weight
  }

  const getMetricValue = m => met.currentGraphMetric.type === 'pogo' ? m.rsi : m.value

  // Combined, sorted list of every date either series has an entry on, so
  // both lines plot on the same x-axis even though their entries don't
  // line up 1-to-1 (metric-index gap and bodyweight-log dates rarely match)
  const allDates = [...new Set([...data.map(m => m.date), ...bwData.map(b => b.date)])].sort()

  // --- Metric series: indexed to % change from the first value shown ---
  // First non-zero value: a % change from 0 is infinite, so a series that
  // starts at 0 is measured from the first value it can be compared to
  const firstNonZero = data.find(m => getMetricValue(m))
  const metricBaseline = firstNonZero ? getMetricValue(firstNonZero) : null
  const metricByEntry = {}
  data.forEach(m => { metricByEntry[m.date] = m })
  const metricSeries = allDates.map(d => {
    const entry = metricByEntry[d]
    return entry && metricBaseline ? +(((getMetricValue(entry) - metricBaseline) / metricBaseline) * 100).toFixed(2) : null
  })

  // --- Bodyweight series: carry the last known weight forward across dates
  // with no new entry, so the line stays flat/continuous instead of gapping
  // out when nothing was logged during part (or all) of the selected range ---
  const bwByDate = {}
  bwData.forEach(b => { bwByDate[b.date] = b.weight })

  const bwBaseline = carryInWeight !== null ? carryInWeight : (bwData[0] ? bwData[0].weight : null)

  let lastKnownWeight = carryInWeight
  const bwRawByDate = {}
  allDates.forEach(d => {
    if (d in bwByDate) lastKnownWeight = bwByDate[d]
    bwRawByDate[d] = lastKnownWeight
  })
  const bwSeries = !bwBaseline
    ? allDates.map(() => null)
    : allDates.map(d => bwRawByDate[d] === null ? null : +(((bwRawByDate[d] - bwBaseline) / bwBaseline) * 100).toFixed(2))

  if (met.fullChart) met.fullChart.destroy()

  const ctx = root.querySelector('#fullGraph').getContext('2d')
  met.fullChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: allDates,
      datasets: [
        {
          label: met.currentGraphMetric.name,
          data: metricSeries,
          borderColor: '#4a4a8e',
          backgroundColor: 'rgba(74, 74, 142, 0.08)',
          borderWidth: 2,
          pointRadius: 4,
          pointHoverRadius: 6,
          pointBackgroundColor: '#4a4a8e',
          tension: 0.35,
          cubicInterpolationMode: 'monotone',
          fill: false,
          spanGaps: true
        },
        {
          label: 'Bodyweight',
          data: bwSeries,
          borderColor: '#e0a458',
          backgroundColor: 'rgba(224, 164, 88, 0.08)',
          borderWidth: 2,
          pointRadius: 4,
          pointHoverRadius: 6,
          pointBackgroundColor: '#e0a458',
          tension: 0.35,
          cubicInterpolationMode: 'monotone',
          fill: false,
          spanGaps: true
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: true, labels: { color: '#aaaacc' } },
        tooltip: themedTooltipOptions({
          callbacks: {
            // Show each line's real underlying value instead of the plotted
            // % - the % is only how the two share one axis visually
            label: function(context) {
              const date = context.label
              if (context.dataset.label === 'Bodyweight') {
                const raw = bwRawByDate[date]
                if (raw === null || raw === undefined) return 'Bodyweight: no data'
                const display = ov.bodyweightUnit === 'lbs' ? (raw * 2.20462).toFixed(1) : raw.toFixed(1)
                return `Bodyweight: ${display} ${ov.bodyweightUnit}`
              }
              const entry = metricByEntry[date]
              if (!entry) return `${met.currentGraphMetric.name}: no data`
              return `${met.currentGraphMetric.name}: ${formatMeasurementValue(met.currentGraphMetric, entry)}`
            }
          }
        })
      },
      scales: {
        x: {
          ticks: { color: '#aaaacc' },
          grid: { color: '#2a2a4e' }
        },
        y: {
          ticks: { color: '#aaaacc', callback: v => `${v}%` },
          grid: { color: '#2a2a4e' },
          title: { display: true, text: '% change from period start', color: '#aaaacc' }
        }
      }
    }
  })
}

// Note: the Graph Modal's and Report Builder modal's time-period buttons
// both use the exact same `.time-filter-btn[data-months]` selector (see
// athlete.html originally, now the shared TEMPLATE above) - this was already
// true on the single-page site, not introduced by this conversion. That
// means opening/switching the graph also flips the Report modal's own
// active-filter button state (they're just CSS classes on hidden markup, so
// this has no visible effect), and clicking a Report month button also fires
// this handler below, calling loadGraphData() against whatever
// currentGraphMetric is currently set (or throwing into the console if none
// is, e.g. before any graph has ever been opened this session). See the
// report for this - preserved as-is rather than silently re-scoped, since
// scoping it would be a behavior change, not a structural conversion.
export function bindGraphModalEvents() {
  root.querySelector('#closeGraphBtn').addEventListener('click', function() {
    root.querySelector('#graphModal').classList.remove('active')
    if (met.fullChart) { met.fullChart.destroy(); met.fullChart = null }
  })

  root.querySelector('#bodyweightOverlayToggle').addEventListener('change', async function() {
    met.showBodyweightOverlay = this.checked
    await loadGraphData(met.currentGraphMonths)
  })

  // Switching the 1M/3M/1Y/All buttons re-loads the graph for that range
  root.querySelectorAll('.time-filter-btn[data-months]').forEach(btn => {
    btn.addEventListener('click', async function() {
      root.querySelectorAll('.time-filter-btn[data-months]').forEach(b => b.classList.remove('active'))
      this.classList.add('active')
      const months = parseInt(this.dataset.months)
      await loadGraphData(months)
    })
  })
}

// ==========================================================================
// ---- ENTRIES MODAL ----
// Full history table for one metric: lists every measurement, with edit
// and delete actions per row.
// ==========================================================================
export async function openEntriesModal(metric) {
  met.currentEntriesMetric = metric
  root.querySelector('#entriesModalTitle').textContent = `${metric.name} — All Entries`
  root.querySelector('#entriesModal').classList.add('active')

  await loadEntries(metric)
}

// Fetches and renders the entries table for a given metric
async function loadEntries(metric) {
  const token = mountToken
  const { data, error } = await fetchAllRows(runOnce, () => supabase
    .from('measurements')
    .select('*')
    .eq('athlete_id', athleteId)
    .eq('metric_id', metric.id)
    .order('date', { ascending: false })
  )

  if (!nav.isCurrent(token)) return
  const list = root.querySelector('#entriesList')

  if (!data || data.length === 0) {
    list.innerHTML = '<p style="color:#aaaacc;text-align:center;padding:20px">No entries yet</p>'
    return
  }

  list.innerHTML = `
    <table class="entries-table">
      <thead>
        <tr>
          <th>Date</th>
          <th>Value</th>
          <th>Notes</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${data.map(m => {
          let valueText = ''
        if (metric.type === 'pogo') {
            const converted = convertValue(m.height, metric.display_unit)
            valueText = `H: ${converted.text}${converted.unit} · GCT: ${m.ground_contact}ms · RSI: ${m.rsi}`
          } else if (metric.type === 'zone2') {
            valueText = `Score: ${m.value}`
          } else {
            const converted = convertValue(m.value, metric.display_unit)
            valueText = `${converted.text} ${converted.unit}`
          }
          return `<tr>
            <td>${m.date}</td>
            <td>${valueText}</td>
            <td>${m.notes || '—'}</td>
            <td>
              <button class="btn-edit-entry" data-entry-id="${m.id}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg></button>
              <button class="btn-delete-measurement" data-measurement-id="${m.id}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg></button>
            </td>
          </tr>`
        }).join('')}
      </tbody>
    </table>
  `

  // Delete listener
  list.querySelectorAll('.btn-delete-measurement').forEach(btn => {
    btn.addEventListener('click', async function() {
      const measurementId = parseInt(this.dataset.measurementId)
      if (!(await customConfirm('Delete this entry?'))) return

      const { error } = await supabase
        .from('measurements')
        .delete()
        .eq('id', measurementId)

      if (error) { customAlert('Something went wrong'); return }

      await loadEntries(metric)
      loadAthleteMetrics()
    })
  })

  // Edit listener
  list.querySelectorAll('.btn-edit-entry').forEach(btn => {
    btn.addEventListener('click', async function() {
      const entryId = parseInt(this.dataset.entryId)
      const entry = data.find(m => m.id === entryId)
      openEditEntryModal(entry, metric)
    })
  })
}

// Populates the "edit entry" modal fields based on the metric type, then opens it
function openEditEntryModal(entry, metric) {
  met.currentEditEntry = entry
  root.querySelector('#editEntryDate').value = entry.date
  root.querySelector('#editEntryNotes').value = entry.notes || ''

  if (metric.type === 'pogo') {
    root.querySelector('#editSimpleFields').style.display = 'none'
    root.querySelector('#editPogoFields').style.display = 'block'
    root.querySelector('#editZone2Fields').style.display = 'none'
    const converted = convertValue(entry.height, metric.display_unit)
    root.querySelector('#editPogoHeight').value = converted.text || ''
    root.querySelector('#editPogoGroundContact').value = entry.ground_contact || ''
    root.querySelector('#editPogoRSI').value = entry.rsi || ''
  } else if (metric.type === 'zone2') {
    root.querySelector('#editSimpleFields').style.display = 'none'
    root.querySelector('#editPogoFields').style.display = 'none'
    root.querySelector('#editZone2Fields').style.display = 'block'
    const paceMin = Math.floor(entry.pace || 0)
    const paceSec = Math.round(((entry.pace || 0) - paceMin) * 60)
    root.querySelector('#editZone2PaceMin').value = paceMin
    root.querySelector('#editZone2PaceSec').value = paceSec
    root.querySelector('#editZone2BPM').value = entry.bpm || ''
    root.querySelector('#editZone2Distance').value = entry.distance || ''
    const durMin = Math.floor(entry.duration || 0)
    const durSec = Math.round(((entry.duration || 0) - durMin) * 60)
    root.querySelector('#editZone2DurMin').value = durMin
    root.querySelector('#editZone2DurSec').value = durSec
  } else {
    root.querySelector('#editSimpleFields').style.display = 'block'
    root.querySelector('#editPogoFields').style.display = 'none'
    root.querySelector('#editZone2Fields').style.display = 'none'
    if (metric.display_unit === 'ft') {
      root.querySelector('#editSingleValueGroup').style.display = 'none'
      root.querySelector('#editFeetInchesGroup').style.display = 'block'
      const totalInches = (entry.value / 2.54)
      const feet = Math.floor(totalInches / 12)
      const inches = +(totalInches % 12).toFixed(1)
      root.querySelector('#editEntryFeet').value = feet
      root.querySelector('#editEntryInches').value = inches
    } else {
      root.querySelector('#editSingleValueGroup').style.display = 'block'
      root.querySelector('#editFeetInchesGroup').style.display = 'none'
      root.querySelector('#editValueLabel').textContent = `${metric.name} (${metric.display_unit || metric.unit})`
      const converted = convertValue(entry.value, metric.display_unit)
      root.querySelector('#editEntryValue').value = converted.text || ''
    }
  }

  root.querySelector('#editEntryModal').classList.add('active')
}

// Saves edits to an existing measurement, rebuilding the payload per metric type
export async function onSaveEditEntry() {
  const date = root.querySelector('#editEntryDate').value
  if (!date) { customAlert('Please select a date'); return }

  let updateData = {
    date,
    notes: root.querySelector('#editEntryNotes').value
  }

  if (met.currentEntriesMetric.type === 'pogo') {
    updateData.height = convertInput(parseFloat(root.querySelector('#editPogoHeight').value), met.currentEntriesMetric.display_unit)
    updateData.ground_contact = parseFloat(root.querySelector('#editPogoGroundContact').value)
    updateData.rsi = parseFloat(root.querySelector('#editPogoRSI').value)
  } else if (met.currentEntriesMetric.type === 'zone2') {
    const paceMin = parseFloat(root.querySelector('#editZone2PaceMin').value) || 0
    const paceSec = parseFloat(root.querySelector('#editZone2PaceSec').value) || 0
    const pace = paceMin + (paceSec / 60)
    const bpm = parseFloat(root.querySelector('#editZone2BPM').value)
    const distance = parseFloat(root.querySelector('#editZone2Distance').value)
    const durMin = parseFloat(root.querySelector('#editZone2DurMin').value) || 0
    const durSec = parseFloat(root.querySelector('#editZone2DurSec').value) || 0
    const duration = durMin + (durSec / 60)
    updateData.pace = pace
    updateData.bpm = bpm
    updateData.distance = distance
    updateData.duration = duration
    updateData.value = +(1000 / (pace * bpm)).toFixed(3)
  } else {
    let rawValue
    if (met.currentEntriesMetric.display_unit === 'ft') {
      const feet = parseFloat(root.querySelector('#editEntryFeet').value) || 0
      const inches = parseFloat(root.querySelector('#editEntryInches').value) || 0
      rawValue = feet + (inches / 12)
    } else {
      rawValue = parseFloat(root.querySelector('#editEntryValue').value)
    }
    updateData.value = convertInput(rawValue, met.currentEntriesMetric.display_unit)
  }

  const { error } = await supabase
    .from('measurements')
    .update(updateData)
    .eq('id', met.currentEditEntry.id)

  if (error) { console.log(error); customAlert('Something went wrong'); return }

  root.querySelector('#editEntryModal').classList.remove('active')
  await loadEntries(met.currentEntriesMetric)
  loadAthleteMetrics()
}
