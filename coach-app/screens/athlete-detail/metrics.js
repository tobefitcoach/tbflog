// ==========================================================================
// ATHLETE DETAIL - Metrics tab
// Unit conversion, loading and painting the athlete's metrics, the
// measurement modal, and the stats bar.
// ==========================================================================
import { supabase } from '../../../coachClient.js?v=__V__'
import * as nav from '../../nav.js?v=__V__'
import { loadChartJs } from '../../vendor.js?v=__V__'
import { toDateStr } from '../../../shared/dates.js?v=__V__'
import { root, mountToken, athleteId, met } from './state.js?v=__V__'
import { onSaveEditEntry, openEntriesModal, openGraphModal, renderLastUpdatedModal, renderMetricsTrackedModal, renderPRModal, renderTotalEntriesModal } from './metrics-modals.js?v=__V__'
import { openChangeExplain } from './overview.js?v=__V__'

// ==========================================================================
// ---- UNIT CONVERSION HELPERS ----
// Converts stored values (always in a base unit, e.g. cm) into whatever
// display unit the user has chosen (in / ft), and back again for saving.
// ==========================================================================
export function convertValue(value, displayUnit) {
  if (!displayUnit || !value) return { text: value, unit: displayUnit || '' }

  if (displayUnit === 'in') {
    const inches = (value / 2.54).toFixed(1)
    return { text: inches, unit: 'in' }
  }

  if (displayUnit === 'ft') {
    const totalInches = value / 2.54
    const feet = Math.floor(totalInches / 12)
    const inches = Math.round(totalInches % 12)
    return { text: `${feet}'${inches}"`, unit: '' }
  }

  return { text: value, unit: displayUnit }
}

export function convertInput(value, displayUnit) {
  if (!displayUnit || !value) return value
  if (displayUnit === 'in') return +(value * 2.54).toFixed(1)
  if (displayUnit === 'ft') return +(value * 30.48).toFixed(1)
  return value
}

// ==========================================================================
// ---- LOAD ALL AVAILABLE METRICS ----
// Loads the full catalog of metric types (e.g. "Vertical Jump", "Zone 2 Run")
// from the DB and populates the "add metric" dropdown with them.
// ==========================================================================
export async function loadAllMetrics() {
  const token = mountToken
  const { data, error } = await window.fetchWithRetry((signal) => supabase
    .from('metrics')
    .select('*')
    .abortSignal(signal)
  )

  if (!nav.isCurrent(token)) return

  if (error) {
    console.log('Error loading metrics:', error)
    customAlert('Something went wrong loading metrics - check your connection and try again')
    return
  }

  met.allMetrics = data

  // Fill the metric dropdown
  const select = root.querySelector('#metricSelect')
  data.forEach(metric => {
    const option = document.createElement('option')
    option.value = metric.id
    option.textContent = `${metric.name} (${metric.unit})`
    select.appendChild(option)
  })
}

// ==========================================================================
// ---- LOAD ATHLETE'S ASSIGNED METRICS ----
// Loads only the metrics this specific athlete is being tracked on, joins in
// the metric definition (name/unit/type) from allMetrics, then renders them.
// ==========================================================================
export async function loadAthleteMetrics() {
  const token = mountToken
  const { data, error } = await window.fetchWithRetry((signal) => supabase
    .from('athlete_metrics')
    .select('*')
    .eq('athlete_id', athleteId)
    .abortSignal(signal)
  )

  if (!nav.isCurrent(token)) return

  if (error) {
    console.log('Error loading athlete metrics:', error)
    customAlert('Something went wrong loading tracked metrics - check your connection and try again')
    return
  }

  // Add metric details to each athlete_metric
  met.athleteMetrics = data.map(am => {
    return {
      ...am,
      metrics: met.allMetrics.find(m => m.id === am.metric_id)
    }
  })
  await renderMetrics()
  if (!nav.isCurrent(token)) return
  loadStatsBar()
}

// ==========================================================================
// ---- RENDER METRICS ON SCREEN ----
// The big one: builds the metrics grid, grouped by category. For each
// metric it loads recent measurements, works out the "latest value" text,
// computes a % change badge, draws the mini graph, and wires up all the
// buttons (record / delete / open details) for that card.
// ==========================================================================
async function renderMetrics() {
  const token = mountToken
  const list = root.querySelector('#metricsList')
  list.innerHTML = ''

  if (met.athleteMetrics.length === 0) {
    list.innerHTML = '<p class="no-metrics">No metrics added yet — click "+ Add Metric" to start tracking!</p>'
    return
  }

  // Every tracked metric's last 3 months of measurements, fetched in ONE
  // query instead of one query per metric (and reused below for the
  // mini-graphs too, instead of fetching the exact same data a second
  // time) - this used to be up to 2-3 sequential database round-trips per
  // tracked metric, which made this tab noticeably slow to open with more
  // than a few metrics tracked.
  const metricIds = met.athleteMetrics.map(am => am.metrics.id)
  const threeMonthsAgo = new Date()
  threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3)
  const fromDate = toDateStr(threeMonthsAgo)

  const { data: recentMeasurements } = await window.fetchWithRetry((signal) => supabase
    .from('measurements')
    .select('*')
    .eq('athlete_id', athleteId)
    .in('metric_id', metricIds)
    .gte('date', fromDate)
    .order('date', { ascending: true })
    .abortSignal(signal)
  )

  if (!nav.isCurrent(token)) return

  const measurementsByMetric = {}
  for (const m of recentMeasurements || []) {
    if (!measurementsByMetric[m.metric_id]) measurementsByMetric[m.metric_id] = []
    measurementsByMetric[m.metric_id].push(m)
  }

  // Zone2 metrics need their FULL history (not just 3 months) for the
  // 30-vs-60-day comparison below - same one-query-for-everyone approach,
  // and only run at all if there's actually a Zone2 metric tracked
  const zone2MetricIds = met.athleteMetrics.filter(am => am.metrics.type === 'zone2').map(am => am.metrics.id)
  const zone2AllByMetric = {}
  if (zone2MetricIds.length > 0) {
    const { data: allZone2Measurements } = await window.fetchWithRetry((signal) => supabase
      .from('measurements')
      .select('*')
      .eq('athlete_id', athleteId)
      .in('metric_id', zone2MetricIds)
      .order('date', { ascending: false })
      .abortSignal(signal)
    )

    if (!nav.isCurrent(token)) return

    for (const m of allZone2Measurements || []) {
      if (!zone2AllByMetric[m.metric_id]) zone2AllByMetric[m.metric_id] = []
      zone2AllByMetric[m.metric_id].push(m)
    }
  }

  // Group metrics by category
  const categories = {}
  for (const am of met.athleteMetrics) {
    const category = am.metrics?.category || 'Other'
    if (!categories[category]) categories[category] = []
    categories[category].push(am)
  }

  // Render each category
  for (const [category, items] of Object.entries(categories)) {
    const categorySection = document.createElement('div')
    categorySection.classList.add('metric-category')
    categorySection.innerHTML = `<h4 class="category-title">${category}</h4>`

    const grid = document.createElement('div')
    grid.classList.add('metrics-grid')

    for (const am of items) {
      const metric = am.metrics
      const measurements = measurementsByMetric[metric.id] || []

      const item = document.createElement('div')
      item.classList.add('metric-item')
      item.dataset.metricId = metric.id

     const latest = measurements.length > 0 ? measurements[measurements.length - 1] : null
      let latestText = 'No measurements yet'
      let changeHTML = ''

      if (latest) {
        // --- Build the "Latest: ..." text, differently per metric type ---
        if (metric.type === 'pogo') {
          const converted = convertValue(latest.height, metric.display_unit)
          latestText = `Height: ${converted.text}${converted.unit} · GCT: ${latest.ground_contact}ms · RSI: ${latest.rsi}`
        } else if (metric.type === 'zone2') {
          latestText = `Score: ${latest.value}`
        } else {
          const converted = convertValue(latest.value, metric.display_unit)
          latestText = `${converted.text} ${converted.unit}`
        }

        // --- Calculate % change badge (▲/▼ x%) shown next to the metric name ---
        if (metric.type === 'zone2') {
          // Zone2: compare average score of last 30 days vs the 30 days before that
          const allZone2 = zone2AllByMetric[metric.id] || []

          if (allZone2.length >= 2) {
            const now = new Date()
            const thirtyDaysAgo = toDateStr(new Date(now - 30 * 24 * 60 * 60 * 1000))
            const sixtyDaysAgo = toDateStr(new Date(now - 60 * 24 * 60 * 60 * 1000))

            const last30 = allZone2.filter(m => m.date >= thirtyDaysAgo)
            const prev30 = allZone2.filter(m => m.date >= sixtyDaysAgo && m.date < thirtyDaysAgo)

            if (last30.length > 0 && prev30.length > 0) {
              const avg30 = last30.reduce((sum, m) => sum + m.value, 0) / last30.length
              const avgPrev = prev30.reduce((sum, m) => sum + m.value, 0) / prev30.length
              const pct = +(((avg30 - avgPrev) / avgPrev) * 100).toFixed(1)
              const isPositive = metric.higher_is_better ? pct > 0 : pct < 0
              const cssClass = pct === 0 ? 'neutral' : isPositive ? 'positive' : 'negative'
              const arrow = pct > 0 ? '▲' : '▼'
changeHTML = `<span class="metric-change ${cssClass}" style="cursor:pointer" data-explain-type="zone2" data-metric-type="${metric.type}" data-metric-name="${metric.name}" data-avg30="${avg30.toFixed(3)}" data-avgprev="${avgPrev.toFixed(3)}" data-pct="${pct}" data-higher="${metric.higher_is_better}">${arrow} ${Math.abs(pct)}%</span>`            }
          }
        } else {
          // All other metric types: compare latest value vs avg of previous 5 entries
          const getValue = m => metric.type === 'pogo' ? m.rsi : m.value
          const latestVal = getValue(latest)

          if (measurements.length >= 2) {
            const previous = measurements.slice(0, -1).slice(-5)
            const avgPrev = previous.reduce((sum, m) => sum + getValue(m), 0) / previous.length
            const pct = +(((latestVal - avgPrev) / avgPrev) * 100).toFixed(1)
            const isPositive = metric.higher_is_better ? pct > 0 : pct < 0
            const cssClass = pct === 0 ? 'neutral' : isPositive ? 'positive' : 'negative'
            const arrow = pct > 0 ? '▲' : '▼'
changeHTML = `<span class="metric-change ${cssClass}" style="cursor:pointer" data-explain-type="simple" data-metric-type="${metric.type}" data-metric-name="${metric.name}" data-latest="${latestVal}" data-avgprev="${avgPrev.toFixed(3)}" data-pct="${pct}" data-higher="${metric.higher_is_better}" data-unit="${metric.display_unit || metric.unit}">${arrow} ${Math.abs(pct)}%</span>`          }
        }
      }

      // --- Build the card's HTML: header, latest value, mini-graph placeholder ---
      item.innerHTML = `
        <div class="metric-item-header">
          <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap">
            <h4>${metric.name}</h4>
            ${changeHTML}
          </div>
          <div style="display:flex; align-items:center; gap:8px">
            <button class="btn-record" data-metric-id="${metric.id}">+ Record</button>
            <button class="btn-delete-metric" data-athlete-metric-id="${am.id}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg></button>
          </div>
        </div>
        <p class="metric-latest">Latest: ${latestText}</p>
        <div class="metric-graph-area">
          ${measurements && measurements.length > 1 ? `
            <canvas id="mini-graph-${metric.id}"></canvas>
            <p class="graph-hint">Click to expand</p>
          ` : '<p style="color:#4a4a8e;font-size:12px">Add 2+ measurements to see graph</p>'}
        </div>
      `

      grid.appendChild(item)
    }

    categorySection.appendChild(grid)
    list.appendChild(categorySection)
  }

  // --- Wire up "+ Record" buttons: open the measurement modal for that metric ---
  root.querySelectorAll('.btn-record').forEach(btn => {
    btn.addEventListener('click', function() {
      const metricId = parseInt(this.dataset.metricId)
      met.currentMetric = met.allMetrics.find(m => m.id === metricId)
      openMeasurementModal()
    })
  })

  // --- Wire up "delete metric" buttons: unassign a metric from this athlete ---
  root.querySelectorAll('.btn-delete-metric').forEach(btn => {
    btn.addEventListener('click', async function() {
      const athleteMetricId = parseInt(this.dataset.athleteMetricId)
      if (!(await customConfirm('Remove this metric from the athlete?'))) return

      const { error } = await supabase
        .from('athlete_metrics')
        .delete()
        .eq('id', athleteMetricId)

      if (error) { console.log('Error deleting metric:', error); customAlert('Something went wrong'); return }

      loadAthleteMetrics()
    })
  })

  // --- Wire up "delete measurement" buttons (used elsewhere in the UI) ---
  root.querySelectorAll('.btn-delete-measurement').forEach(btn => {
    btn.addEventListener('click', async function() {
      const measurementId = parseInt(this.dataset.measurementId)
      if (!(await customConfirm('Delete this measurement?'))) return

      const { error } = await supabase
        .from('measurements')
        .delete()
        .eq('id', measurementId)

      if (error) { console.log('Error deleting measurement:', error); customAlert('Something went wrong'); return }

      loadAthleteMetrics()
    })
  })

  // --- Draw the small trend chart (Chart.js) inside each metric card ---
  // Reuses measurementsByMetric (fetched once, up top) instead of querying
  // the same 3-months-of-measurements data a second time per metric. Charts
  // created here are tracked in miniChartInstances so unmount() can destroy
  // them - see that array's own comment.
  const hasAnyGraph = met.athleteMetrics.some(am => (measurementsByMetric[am.metrics.id] || []).length >= 2)
  if (hasAnyGraph) {
    await loadChartJs()
    if (!nav.isCurrent(token)) return
  }

  for (const am of met.athleteMetrics) {
    const metric = am.metrics
    const canvas = root.querySelector(`#mini-graph-${metric.id}`)
    if (!canvas) continue

    const graphData = measurementsByMetric[metric.id] || []
    if (graphData.length < 2) continue

    const labels = graphData.map(m => m.date)
    const values = graphData.map(m => metric.type === 'pogo' ? m.rsi : m.value)

    const chart = new Chart(canvas, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          data: values,
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
          y: { display: false }
        }
      }
    })
    met.miniChartInstances.push(chart)

    // Clicking the mini graph opens the full-size graph modal
    canvas.addEventListener('click', function() {
      openGraphModal(metric)
    })
  }

  // --- Clicking anywhere on a metric card (except buttons/canvas/change badge)
  //     opens the full entries list for that metric; clicking the % change
  //     badge instead opens the "explain this change" breakdown ---
  root.querySelectorAll('.metric-item').forEach(item => {
    item.addEventListener('click', function(e) {
      if (e.target.classList.contains('btn-record') ||
          e.target.classList.contains('btn-delete-metric') ||
          e.target.tagName === 'CANVAS') return

      if (e.target.classList.contains('metric-change')) {
        openChangeExplain(e.target)
        return
      }

      const metricId = parseInt(this.dataset.metricId)
      const metric = met.allMetrics.find(m => m.id === metricId)
      openEntriesModal(metric)
    })
  })
}

// ==========================================================================
// ---- OPEN MEASUREMENT MODAL ----
// Shows/hides the right input fields (simple value / pogo jump / zone2 run)
// depending on the metric type, then opens the "record measurement" modal.
// ==========================================================================
function openMeasurementModal() {
  root.querySelector('#measurementModalTitle').textContent =
    `Record — ${met.currentMetric.name}`

  // Set today's date as default
  root.querySelector('#measurementDate').valueAsDate = new Date()

  // Show right fields based on metric type
  if (met.currentMetric.type === 'pogo') {
    root.querySelector('#simpleFields').style.display = 'none'
    root.querySelector('#pogoFields').style.display = 'block'
    root.querySelector('#zone2Fields').style.display = 'none'
    const pogoUnit = met.currentMetric.display_unit || 'cm'
    root.querySelector('#pogoHeightLabel').textContent = `Height (${pogoUnit})`
  } else if (met.currentMetric.type === 'zone2') {
    root.querySelector('#simpleFields').style.display = 'none'
    root.querySelector('#pogoFields').style.display = 'none'
    root.querySelector('#zone2Fields').style.display = 'block'
  } else {
    root.querySelector('#simpleFields').style.display = 'block'
    root.querySelector('#pogoFields').style.display = 'none'
    root.querySelector('#zone2Fields').style.display = 'none'

    // Simple numeric metrics can display as a single value or as feet+inches
    if (met.currentMetric.display_unit === 'ft') {
      root.querySelector('#singleValueGroup').style.display = 'none'
      root.querySelector('#feetInchesGroup').style.display = 'block'
    } else {
      root.querySelector('#singleValueGroup').style.display = 'block'
      root.querySelector('#feetInchesGroup').style.display = 'none'
      root.querySelector('#valueLabel').textContent =
        `${met.currentMetric.name} (${met.currentMetric.display_unit || met.currentMetric.unit})`
    }
  }

  root.querySelector('#addMeasurementModal').classList.add('active')
}

async function onSaveMetric() {
  const metricId = parseInt(root.querySelector('#metricSelect').value)

  if (!metricId) {
    customAlert('Please select a metric')
    return
  }

  const { error } = await supabase
    .from('athlete_metrics')
    .insert([{
      athlete_id: parseInt(athleteId),
      metric_id: metricId
    }])

  if (error) {
    console.log('Error adding metric:', error)
    customAlert('Something went wrong')
    return
  }

  root.querySelector('#addMetricModal').classList.remove('active')
  loadAthleteMetrics()
}

async function onSaveMeasurement() {
  const date = root.querySelector('#measurementDate').value

  if (!date) {
    customAlert('Please select a date')
    return
  }

  let insertData = {
    athlete_id: parseInt(athleteId),
    metric_id: met.currentMetric.id,
    date: date,
    notes: root.querySelector('#measurementNotes').value
  }

  if (met.currentMetric.type === 'pogo') {
    insertData.height = convertInput(parseFloat(root.querySelector('#pogoHeight').value), met.currentMetric.display_unit)
    insertData.ground_contact = parseFloat(root.querySelector('#pogoGroundContact').value)
    insertData.rsi = parseFloat(root.querySelector('#pogoRSI').value)
  } else if (met.currentMetric.type === 'zone2') {
    // Zone2 "efficiency score" = 1000 / (pace × heart rate) — lower pace & bpm is better
    const paceMin = parseFloat(root.querySelector('#zone2PaceMin').value) || 0
    const paceSec = parseFloat(root.querySelector('#zone2PaceSec').value) || 0
    const pace = paceMin + (paceSec / 60)
    const bpm = parseFloat(root.querySelector('#zone2BPM').value)
    const distance = parseFloat(root.querySelector('#zone2Distance').value)
    const durMin = parseFloat(root.querySelector('#zone2DurMin').value) || 0
    const durSec = parseFloat(root.querySelector('#zone2DurSec').value) || 0
    const duration = durMin + (durSec / 60)
    const score = +(1000 / (pace * bpm)).toFixed(3)
    insertData.pace = pace
    insertData.bpm = bpm
    insertData.distance = distance
    insertData.duration = duration
    insertData.value = score
  } else {
    let rawValue
    if (met.currentMetric.display_unit === 'ft') {
      const feet = parseFloat(root.querySelector('#measurementFeet').value) || 0
      const inches = parseFloat(root.querySelector('#measurementInches').value) || 0
      rawValue = feet + (inches / 12)
    } else {
      rawValue = parseFloat(root.querySelector('#measurementValue').value)
    }
    insertData.value = convertInput(rawValue, met.currentMetric.display_unit)
  }

  const { error } = await supabase
    .from('measurements')
    .insert([insertData])

  if (error) {
    console.log('Error saving measurement:', error)
    customAlert('Something went wrong')
    return
  }

  root.querySelector('#addMeasurementModal').classList.remove('active')
  loadAthleteMetrics()
}

async function onCreateMetric() {
  const name = root.querySelector('#newMetricName').value.trim()
  const unit = root.querySelector('#newMetricUnit').value.trim()
  const type = root.querySelector('#newMetricType').value

  if (!name || !unit) {
    customAlert('Please fill in both name and unit')
    return
  }

  const category = root.querySelector('#newMetricCategory').value
  const { data, error } = await supabase
    .from('metrics')
    .insert([{ name, unit, type, category }])
    .select()

  if (error) {
    console.log('Error creating metric:', error)
    customAlert('Something went wrong')
    return
  }

  // Add new metric to allMetrics and dropdown
  met.allMetrics.push(data[0])
  const select = root.querySelector('#metricSelect')
  const option = document.createElement('option')
  option.value = data[0].id
  option.textContent = `${data[0].name} (${data[0].unit})`
  select.appendChild(option)
  select.value = data[0].id

  // Clear form
  root.querySelector('#newMetricName').value = ''
  root.querySelector('#newMetricUnit').value = ''

  // Go back to add metric modal
  root.querySelector('#createMetricModal').classList.remove('active')
  root.querySelector('#addMetricModal').classList.add('active')

  customAlert(`"${name}" created and selected!`)
}

export function bindMetricsStaticEvents() {
  root.querySelector('#addMetricBtn').addEventListener('click', function() {
    root.querySelector('#addMetricModal').classList.add('active')
  })

  root.querySelector('#cancelMetricBtn').addEventListener('click', function() {
    root.querySelector('#addMetricModal').classList.remove('active')
  })

  root.querySelector('#saveMetricBtn').addEventListener('click', onSaveMetric)

  root.querySelector('#cancelMeasurementBtn').addEventListener('click', function() {
    root.querySelector('#addMeasurementModal').classList.remove('active')
  })

  root.querySelector('#saveMeasurementBtn').addEventListener('click', onSaveMeasurement)

  root.querySelector('#createNewMetricBtn').addEventListener('click', function() {
    root.querySelector('#addMetricModal').classList.remove('active')
    root.querySelector('#createMetricModal').classList.add('active')
  })

  root.querySelector('#cancelCreateMetricBtn').addEventListener('click', function() {
    root.querySelector('#createMetricModal').classList.remove('active')
    root.querySelector('#addMetricModal').classList.add('active')
  })

  root.querySelector('#saveNewMetricBtn').addEventListener('click', onCreateMetric)

  root.querySelector('#closeEntriesBtn').addEventListener('click', function() {
    root.querySelector('#entriesModal').classList.remove('active')
  })

  root.querySelector('#cancelEditEntryBtn').addEventListener('click', function() {
    root.querySelector('#editEntryModal').classList.remove('active')
  })

  root.querySelector('#saveEditEntryBtn').addEventListener('click', onSaveEditEntry)

  // ---- Stats bar detail modals (PR / Metrics Tracked / Total Entries / Last Updated) ----
  root.querySelector('#statPRsCard').addEventListener('click', function() {
    root.querySelector('#prModal').classList.add('active')
    renderPRModal()
  })
  root.querySelector('#closePRModalBtn').addEventListener('click', function() {
    root.querySelector('#prModal').classList.remove('active')
  })

  root.querySelector('#statMetricsCard').addEventListener('click', function() {
    root.querySelector('#metricsTrackedModal').classList.add('active')
    renderMetricsTrackedModal()
  })
  root.querySelector('#closeMetricsTrackedModalBtn').addEventListener('click', function() {
    root.querySelector('#metricsTrackedModal').classList.remove('active')
  })

  root.querySelector('#statEntriesCard').addEventListener('click', function() {
    root.querySelector('#totalEntriesModal').classList.add('active')
    renderTotalEntriesModal()
  })
  root.querySelector('#closeTotalEntriesModalBtn').addEventListener('click', function() {
    root.querySelector('#totalEntriesModal').classList.remove('active')
  })

  root.querySelector('#statLastUpdatedCard').addEventListener('click', function() {
    root.querySelector('#lastUpdatedModal').classList.add('active')
    met.recentActivityPage = 0 // always start back at the newest entries when reopening
    renderLastUpdatedModal()
  })
  root.querySelector('#closeLastUpdatedModalBtn').addEventListener('click', function() {
    root.querySelector('#lastUpdatedModal').classList.remove('active')
  })
}

// ==========================================================================
// ---- STATS BAR ----
// Fills in the top summary row: total entries logged, number of metrics
// tracked, how recently the athlete last logged something, and how many
// personal records (PRs) were set this month.
// ==========================================================================
async function loadStatsBar() {
  const token = mountToken
  // Get all measurements for this athlete
  const { data: allMeasurements, error } = await window.fetchWithRetry((signal) => supabase
    .from('measurements')
    .select('*')
    .eq('athlete_id', athleteId)
    .order('date', { ascending: false })
    .abortSignal(signal)
  )

  if (!nav.isCurrent(token)) return
  if (error) { console.log('Error loading stats bar:', error) }
  if (!allMeasurements) return

  met.allMeasurementsCache = allMeasurements // so the stats-bar detail modals can reuse this without re-querying

  // Total entries
  root.querySelector('#statEntries').textContent = allMeasurements.length

  // Metrics tracked
  root.querySelector('#statMetrics').textContent = met.athleteMetrics.length

  // Last updated
  if (allMeasurements.length > 0) {
    const lastDate = new Date(allMeasurements[0].date)
    const today = new Date()
    const diffDays = Math.floor((today - lastDate) / (1000 * 60 * 60 * 24))
    if (diffDays === 0) {
      root.querySelector('#statLastUpdated').textContent = 'Today'
    } else if (diffDays === 1) {
      root.querySelector('#statLastUpdated').textContent = 'Yesterday'
    } else {
      root.querySelector('#statLastUpdated').textContent = `${diffDays}d ago`
    }
  }

  // PRs in the last 30 days: walk each metric's measurements oldest-to-newest,
  // tracking the running best value. Any entry that beats the running best
  // counts as a PR - except the very first entry ever logged for a metric,
  // since it has no earlier value to compare against and can't be a "record".
  const now = new Date()
  const thirtyDaysAgo = toDateStr(new Date(now - 30 * 24 * 60 * 60 * 1000))

  let prCount = 0
  met.prEvents = [] // reset the list the PR overview modal reads from (state.js)

  for (const am of met.athleteMetrics) {
    const metric = am.metrics
    if (!metric) continue

    // Get all measurements for this metric, oldest first, so we can track the running best
    const metricMeasurements = allMeasurements
      .filter(m => m.metric_id === metric.id)
      .sort((a, b) => a.date.localeCompare(b.date))

    if (metricMeasurements.length < 2) continue // need a baseline entry + at least one challenger

    const getValue = m => metric.type === 'pogo' ? m.rsi : m.value
    const higherIsBetter = metric.higher_is_better

    // First entry is just the baseline - it can never be a PR itself
    let best = getValue(metricMeasurements[0])

    for (let i = 1; i < metricMeasurements.length; i++) {
      const entry = metricMeasurements[i]
      const value = getValue(entry)
      const isNewBest = higherIsBetter ? value > best : value < best

      if (isNewBest) {
        if (entry.date >= thirtyDaysAgo) {
          prCount++
          // Keep the metric + entry so the PR overview modal can display and group it
          met.prEvents.push({ metric, entry })
        }
        best = value
      }
    }
  }

  root.querySelector('#statPRs').textContent = prCount
}
