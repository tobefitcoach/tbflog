// ==========================================================================
// SETUP — Supabase client + page state
// ==========================================================================
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm'

const supabaseUrl = 'https://szvnaiqlxtlsjgnefunt.supabase.co'
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InN6dm5haXFseHRsc2pnbmVmdW50Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMxNTgzMTgsImV4cCI6MjA5ODczNDMxOH0.i0qOHffDnKBVreN1QM7h8tEfHlJgQulwhZ1x4YEAEdU'
const supabase = createClient(supabaseUrl, supabaseKey)

// Get athlete ID from URL
const params = new URLSearchParams(window.location.search)
const athleteId = params.get('id')

// Keep track of current metric being recorded
let currentMetric = null
let allMetrics = []
let athleteMetrics = []
let prEvents = [] // PRs broken in the last 30 days, filled in by loadStatsBar, read by the PR overview modal
let allMeasurementsCache = [] // every measurement for this athlete, filled in by loadStatsBar, read by the stats-bar detail modals

// Load everything when page opens
loadAthlete()
loadAllMetrics().then(() => loadAthleteMetrics())

// ==========================================================================
// ---- LOAD ATHLETE INFO ----
// Fetches the athlete's profile row and fills in the header (name, initials,
// age, height), sets the page title, wires up the "edit info" button, and
// kicks off the bodyweight graph load.
// ==========================================================================
async function loadAthlete() {
  const { data, error } = await supabase
    .from('athletes')
    .select('*')
    .eq('id', athleteId)
    .single()

  if (error) {
    console.log('Error loading athlete:', error)
    return
  }

  // Calculate age from date of birth
  const dob = new Date(data.date_of_birth)
  const age = Math.floor((new Date() - dob) / (365.25 * 24 * 60 * 60 * 1000))

  // Fill in profile header
  const initials = data.name.split(' ').map(w => w[0]).join('').toUpperCase()
  document.getElementById('profileInitials').textContent = initials
  document.getElementById('profileName').textContent = data.name
document.getElementById('profileDetails').textContent =
    `${data.gender} · ${age} years old · ${data.height}cm`

  document.title = `${data.name} — TBFlog`

  // Fill in the notes textarea with whatever's saved
  document.getElementById('athleteNotes').value = data.notes || ''

 // Edit info button
  document.getElementById('editAthleteBtn').addEventListener('click', function() {
    document.getElementById('editAthleteName').value = data.name
    document.getElementById('editAthleteDOB').value = data.date_of_birth
    document.getElementById('editAthleteGender').value = data.gender
    document.getElementById('editAthleteHeight').value = data.height
    document.getElementById('editAthleteModal').classList.add('active')
  })

  // Load bodyweight graph
  loadBodyweightGraph()
}

// ==========================================================================
// ---- ATHLETE NOTES ----
// Saves the freeform notes textarea to athletes.notes in Supabase.
// ==========================================================================
document.getElementById('saveNotesBtn').addEventListener('click', async function() {
  const notes = document.getElementById('athleteNotes').value
  const savedLabel = document.getElementById('notesSavedLabel')

  const { error } = await supabase
    .from('athletes')
    .update({ notes })
    .eq('id', athleteId)

  if (error) {
    console.log('Error saving notes:', error)
    alert('Something went wrong saving notes')
    return
  }

  // Briefly confirm the save, then clear the message after a couple seconds
  savedLabel.textContent = 'Saved ✓'
  setTimeout(() => { savedLabel.textContent = '' }, 2000)
})

// ==========================================================================
// ---- UNIT CONVERSION HELPERS ----
// Converts stored values (always in a base unit, e.g. cm) into whatever
// display unit the user has chosen (in / ft), and back again for saving.
// ==========================================================================
function convertValue(value, displayUnit) {
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

function convertInput(value, displayUnit) {
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
async function loadAllMetrics() {
  const { data, error } = await supabase
    .from('metrics')
    .select('*')

  if (error) {
    console.log('Error loading metrics:', error)
    return
  }

allMetrics = data

  // Fill the metric dropdown
  const select = document.getElementById('metricSelect')
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
async function loadAthleteMetrics() {
  const { data, error } = await supabase
    .from('athlete_metrics')
    .select('*')
    .eq('athlete_id', athleteId)

  if (error) {
    console.log('Error loading athlete metrics:', error)
    return
  }

  // Add metric details to each athlete_metric
  athleteMetrics = data.map(am => {
    return {
      ...am,
      metrics: allMetrics.find(m => m.id === am.metric_id)
    }
  })
  renderMetrics()
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
  const list = document.getElementById('metricsList')
  list.innerHTML = ''

  if (athleteMetrics.length === 0) {
    list.innerHTML = '<p class="no-metrics">No metrics added yet — click "+ Add Metric" to start tracking!</p>'
    return
  }

  // Group metrics by category
  const categories = {}
  for (const am of athleteMetrics) {
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

      // Load last 3 months of measurements for mini graph
      const threeMonthsAgo = new Date()
      threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3)
      const fromDate = threeMonthsAgo.toISOString().split('T')[0]

      const { data: measurements } = await supabase
        .from('measurements')
        .select('*')
        .eq('athlete_id', athleteId)
        .eq('metric_id', metric.id)
        .gte('date', fromDate)
        .order('date', { ascending: true })

      const item = document.createElement('div')
      item.classList.add('metric-item')
      item.dataset.metricId = metric.id

     const latest = measurements && measurements.length > 0 ? measurements[measurements.length - 1] : null
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
          const { data: allZone2 } = await supabase
            .from('measurements')
            .select('*')
            .eq('athlete_id', athleteId)
            .eq('metric_id', metric.id)
            .order('date', { ascending: false })

          if (allZone2 && allZone2.length >= 2) {
            const now = new Date()
            const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
            const sixtyDaysAgo = new Date(now - 60 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]

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
            <button class="btn-delete-metric" data-athlete-metric-id="${am.id}">🗑</button>
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
  document.querySelectorAll('.btn-record').forEach(btn => {
    btn.addEventListener('click', function() {
      const metricId = parseInt(this.dataset.metricId)
      currentMetric = allMetrics.find(m => m.id === metricId)
      openMeasurementModal()
    })
  })

  // --- Wire up "delete metric" buttons: unassign a metric from this athlete ---
  document.querySelectorAll('.btn-delete-metric').forEach(btn => {
    btn.addEventListener('click', async function() {
      const athleteMetricId = parseInt(this.dataset.athleteMetricId)
      if (!confirm('Remove this metric from the athlete?')) return

      const { error } = await supabase
        .from('athlete_metrics')
        .delete()
        .eq('id', athleteMetricId)

      if (error) { console.log('Error deleting metric:', error); alert('Something went wrong'); return }

      loadAthleteMetrics()
    })
  })

  // --- Wire up "delete measurement" buttons (used elsewhere in the UI) ---
  document.querySelectorAll('.btn-delete-measurement').forEach(btn => {
    btn.addEventListener('click', async function() {
      const measurementId = parseInt(this.dataset.measurementId)
      if (!confirm('Delete this measurement?')) return

      const { error } = await supabase
        .from('measurements')
        .delete()
        .eq('id', measurementId)

      if (error) { console.log('Error deleting measurement:', error); alert('Something went wrong'); return }

      loadAthleteMetrics()
    })
  })

  // --- Draw the small trend chart (Chart.js) inside each metric card ---
  for (const am of athleteMetrics) {
    const metric = am.metrics
    const canvas = document.getElementById(`mini-graph-${metric.id}`)
    if (!canvas) continue

    const threeMonthsAgo2 = new Date()
    threeMonthsAgo2.setMonth(threeMonthsAgo2.getMonth() - 3)
    const fromDate2 = threeMonthsAgo2.toISOString().split('T')[0]

    const { data: graphData } = await supabase
      .from('measurements')
      .select('*')
      .eq('athlete_id', athleteId)
      .eq('metric_id', metric.id)
      .gte('date', fromDate2)
      .order('date', { ascending: true })

    if (!graphData || graphData.length < 2) continue

    const labels = graphData.map(m => m.date)
    const values = graphData.map(m => metric.type === 'pogo' ? m.rsi : m.value)

    new Chart(canvas, {
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

    // Clicking the mini graph opens the full-size graph modal
    canvas.addEventListener('click', function() {
      openGraphModal(metric)
    })
  }

  // --- Clicking anywhere on a metric card (except buttons/canvas/change badge)
  //     opens the full entries list for that metric; clicking the % change
  //     badge instead opens the "explain this change" breakdown ---
  document.querySelectorAll('.metric-item').forEach(item => {
    item.addEventListener('click', function(e) {
      if (e.target.classList.contains('btn-record') ||
          e.target.classList.contains('btn-delete-metric') ||
          e.target.tagName === 'CANVAS') return

      if (e.target.classList.contains('metric-change')) {
        openChangeExplain(e.target)
        return
      }

      const metricId = parseInt(this.dataset.metricId)
      const metric = allMetrics.find(m => m.id === metricId)
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
  document.getElementById('measurementModalTitle').textContent =
    `Record — ${currentMetric.name}`

  // Set today's date as default
  document.getElementById('measurementDate').valueAsDate = new Date()

  // Show right fields based on metric type
if (currentMetric.type === 'pogo') {
    document.getElementById('simpleFields').style.display = 'none'
    document.getElementById('pogoFields').style.display = 'block'
    document.getElementById('zone2Fields').style.display = 'none'
    const pogoUnit = currentMetric.display_unit || 'cm'
    document.getElementById('pogoHeightLabel').textContent = `Height (${pogoUnit})`
  } else if (currentMetric.type === 'zone2') {
    document.getElementById('simpleFields').style.display = 'none'
    document.getElementById('pogoFields').style.display = 'none'
    document.getElementById('zone2Fields').style.display = 'block'
  } else {
    document.getElementById('simpleFields').style.display = 'block'
    document.getElementById('pogoFields').style.display = 'none'
    document.getElementById('zone2Fields').style.display = 'none'

    // Simple numeric metrics can display as a single value or as feet+inches
    if (currentMetric.display_unit === 'ft') {
      document.getElementById('singleValueGroup').style.display = 'none'
      document.getElementById('feetInchesGroup').style.display = 'block'
    } else {
      document.getElementById('singleValueGroup').style.display = 'block'
      document.getElementById('feetInchesGroup').style.display = 'none'
      document.getElementById('valueLabel').textContent =
        `${currentMetric.name} (${currentMetric.display_unit || currentMetric.unit})`
    }
  }

  document.getElementById('addMeasurementModal').classList.add('active')
}

// ==========================================================================
// ---- ADD METRIC MODAL ----
// Modal for assigning an existing metric (from the dropdown) to this athlete.
// ==========================================================================
document.getElementById('addMetricBtn').addEventListener('click', function() {
  document.getElementById('addMetricModal').classList.add('active')
})

document.getElementById('cancelMetricBtn').addEventListener('click', function() {
  document.getElementById('addMetricModal').classList.remove('active')
})

document.getElementById('saveMetricBtn').addEventListener('click', async function() {
  const metricId = parseInt(document.getElementById('metricSelect').value)

  if (!metricId) {
    alert('Please select a metric')
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
    alert('Something went wrong')
    return
  }

  document.getElementById('addMetricModal').classList.remove('active')
  loadAthleteMetrics()
})

// ==========================================================================
// ---- MEASUREMENT MODAL ----
// Saves a new measurement entry, building the right payload shape depending
// on whether this is a pogo jump, a zone2 run, or a simple value metric.
// ==========================================================================
document.getElementById('cancelMeasurementBtn').addEventListener('click', function() {
  document.getElementById('addMeasurementModal').classList.remove('active')
})

document.getElementById('saveMeasurementBtn').addEventListener('click', async function() {
  const date = document.getElementById('measurementDate').value

  if (!date) {
    alert('Please select a date')
    return
  }

  let insertData = {
    athlete_id: parseInt(athleteId),
    metric_id: currentMetric.id,
    date: date,
    notes: document.getElementById('measurementNotes').value
  }

  if (currentMetric.type === 'pogo') {
    insertData.height = convertInput(parseFloat(document.getElementById('pogoHeight').value), currentMetric.display_unit)
    insertData.ground_contact = parseFloat(document.getElementById('pogoGroundContact').value)
    insertData.rsi = parseFloat(document.getElementById('pogoRSI').value)
  } else if (currentMetric.type === 'zone2') {
    // Zone2 "efficiency score" = 1000 / (pace × heart rate) — lower pace & bpm is better
    const paceMin = parseFloat(document.getElementById('zone2PaceMin').value) || 0
    const paceSec = parseFloat(document.getElementById('zone2PaceSec').value) || 0
    const pace = paceMin + (paceSec / 60)
    const bpm = parseFloat(document.getElementById('zone2BPM').value)
    const distance = parseFloat(document.getElementById('zone2Distance').value)
    const durMin = parseFloat(document.getElementById('zone2DurMin').value) || 0
    const durSec = parseFloat(document.getElementById('zone2DurSec').value) || 0
    const duration = durMin + (durSec / 60)
    const score = +(1000 / (pace * bpm)).toFixed(3)
    insertData.pace = pace
    insertData.bpm = bpm
    insertData.distance = distance
    insertData.duration = duration
    insertData.value = score
  } else {
    let rawValue
    if (currentMetric.display_unit === 'ft') {
      const feet = parseFloat(document.getElementById('measurementFeet').value) || 0
      const inches = parseFloat(document.getElementById('measurementInches').value) || 0
      rawValue = feet + (inches / 12)
    } else {
      rawValue = parseFloat(document.getElementById('measurementValue').value)
    }
    insertData.value = convertInput(rawValue, currentMetric.display_unit)
  }

  const { error } = await supabase
    .from('measurements')
    .insert([insertData])

  if (error) {
    console.log('Error saving measurement:', error)
    alert('Something went wrong')
    return
  }

  document.getElementById('addMeasurementModal').classList.remove('active')
  loadAthleteMetrics()
})
// ==========================================================================
// ---- STATS BAR ----
// Fills in the top summary row: total entries logged, number of metrics
// tracked, how recently the athlete last logged something, and how many
// personal records (PRs) were set this month.
// ==========================================================================
async function loadStatsBar() {
  // Get all measurements for this athlete
  const { data: allMeasurements } = await supabase
    .from('measurements')
    .select('*')
    .eq('athlete_id', athleteId)
    .order('date', { ascending: false })

  if (!allMeasurements) return

  allMeasurementsCache = allMeasurements // so the stats-bar detail modals can reuse this without re-querying

  // Total entries
  document.getElementById('statEntries').textContent = allMeasurements.length

  // Metrics tracked
  document.getElementById('statMetrics').textContent = athleteMetrics.length

  // Last updated
  if (allMeasurements.length > 0) {
    const lastDate = new Date(allMeasurements[0].date)
    const today = new Date()
    const diffDays = Math.floor((today - lastDate) / (1000 * 60 * 60 * 24))
    if (diffDays === 0) {
      document.getElementById('statLastUpdated').textContent = 'Today'
    } else if (diffDays === 1) {
      document.getElementById('statLastUpdated').textContent = 'Yesterday'
    } else {
      document.getElementById('statLastUpdated').textContent = `${diffDays}d ago`
    }
  }

  // PRs in the last 30 days: walk each metric's measurements oldest-to-newest,
  // tracking the running best value. Any entry that beats the running best
  // counts as a PR - except the very first entry ever logged for a metric,
  // since it has no earlier value to compare against and can't be a "record".
  const now = new Date()
  const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]

  let prCount = 0
  prEvents = [] // reset the module-level list the PR overview modal reads from

  for (const am of athleteMetrics) {
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
          prEvents.push({ metric, entry })
        }
        best = value
      }
    }
  }

  document.getElementById('statPRs').textContent = prCount
}

// ==========================================================================
// ---- PR OVERVIEW MODAL ----
// Opened by clicking the "PRs (last 30 days)" stat tile. Shows prEvents
// (filled in by loadStatsBar above) grouped by category, then by individual
// metric, with each metric's PRs listed chronologically (oldest first) so
// repeat PRs on the same metric read as a clear progression.
// ==========================================================================
document.getElementById('statPRsCard').addEventListener('click', function() {
  document.getElementById('prModal').classList.add('active')
  renderPRModal()
})

document.getElementById('closePRModalBtn').addEventListener('click', function() {
  document.getElementById('prModal').classList.remove('active')
})

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

function renderPRModal() {
  const container = document.getElementById('prList')

  if (prEvents.length === 0) {
    container.innerHTML = '<p style="color:#aaaacc;text-align:center;padding:20px">No PRs broken in the last 30 days</p>'
    return
  }

  // Group PR events: category -> metric name -> array of {metric, entry}
  const byCategory = {}
  for (const ev of prEvents) {
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
document.getElementById('statMetricsCard').addEventListener('click', function() {
  document.getElementById('metricsTrackedModal').classList.add('active')
  renderMetricsTrackedModal()
})

document.getElementById('closeMetricsTrackedModalBtn').addEventListener('click', function() {
  document.getElementById('metricsTrackedModal').classList.remove('active')
})

function renderMetricsTrackedModal() {
  const container = document.getElementById('metricsTrackedList')

  if (athleteMetrics.length === 0) {
    container.innerHTML = '<p style="color:#aaaacc;text-align:center;padding:20px">No metrics tracked yet</p>'
    return
  }

  // Group tracked metrics by category
  const byCategory = {}
  for (const am of athleteMetrics) {
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
document.getElementById('statEntriesCard').addEventListener('click', function() {
  document.getElementById('totalEntriesModal').classList.add('active')
  renderTotalEntriesModal()
})

document.getElementById('closeTotalEntriesModalBtn').addEventListener('click', function() {
  document.getElementById('totalEntriesModal').classList.remove('active')
})

function renderTotalEntriesModal() {
  const container = document.getElementById('totalEntriesList')

  if (allMeasurementsCache.length === 0) {
    container.innerHTML = '<p style="color:#aaaacc;text-align:center;padding:20px">No entries logged yet</p>'
    return
  }

  // Count entries per metric, grouped by category (skip metrics with 0 entries)
  const byCategory = {}
  for (const am of athleteMetrics) {
    const metric = am.metrics
    if (!metric) continue
    const count = allMeasurementsCache.filter(m => m.metric_id === metric.id).length
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
document.getElementById('statLastUpdatedCard').addEventListener('click', function() {
  document.getElementById('lastUpdatedModal').classList.add('active')
  recentActivityPage = 0 // always start back at the newest entries when reopening
  renderLastUpdatedModal()
})

document.getElementById('closeLastUpdatedModalBtn').addEventListener('click', function() {
  document.getElementById('lastUpdatedModal').classList.remove('active')
})

// Formats a stored 'YYYY-MM-DD' date string as e.g. "Jul 23, 2026"
function formatDisplayDate(dateStr) {
  return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

// How many entries per page (21-40, 41-60, etc), and which page we're currently on
const RECENT_ACTIVITY_PAGE_SIZE = 20
let recentActivityPage = 0

function renderLastUpdatedModal() {
  const container = document.getElementById('lastUpdatedList')

  if (allMeasurementsCache.length === 0) {
    container.innerHTML = '<p style="color:#aaaacc;text-align:center;padding:20px">No entries logged yet</p>'
    return
  }

  // Map metric_id -> metric so each measurement can show its metric's name and formatted value
  const metricById = {}
  for (const am of athleteMetrics) {
    if (am.metrics) metricById[am.metrics.id] = am.metrics
  }

  const sorted = [...allMeasurementsCache].sort((a, b) => b.date.localeCompare(a.date))

  const start = recentActivityPage * RECENT_ACTIVITY_PAGE_SIZE
  const end = start + RECENT_ACTIVITY_PAGE_SIZE
  const pageEntries = sorted.slice(start, end)
  const hasPrev = recentActivityPage > 0
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
      ${hasPrev ? '<button class="pagination-btn" id="prevActivityBtn">← Previous</button>' : '<span></span>'}
      <span class="pagination-label">${start + 1}–${Math.min(end, sorted.length)} of ${sorted.length}</span>
      ${hasNext ? '<button class="pagination-btn" id="nextActivityBtn">Next →</button>' : '<span></span>'}
    </div>
  `

  if (hasPrev) {
    document.getElementById('prevActivityBtn').addEventListener('click', function() {
      recentActivityPage--
      renderLastUpdatedModal()
    })
  }

  if (hasNext) {
    document.getElementById('nextActivityBtn').addEventListener('click', function() {
      recentActivityPage++
      renderLastUpdatedModal()
    })
  }
}

// ==========================================================================
// ---- GRAPH MODAL ----
// Full-size Chart.js graph for one metric, with 1M/3M/1Y/All time filters.
// ==========================================================================
let fullChart = null
let currentGraphMetric = null

async function openGraphModal(metric) {
  currentGraphMetric = metric
  document.getElementById('graphModalTitle').textContent = metric.name
  document.getElementById('graphModal').classList.add('active')

  // Set 1M as default active filter
  document.querySelectorAll('.time-filter-btn').forEach(btn => btn.classList.remove('active'))
  document.querySelector('.time-filter-btn[data-months="1"]').classList.add('active')

  await loadGraphData(1)
}

// Fetches measurements for the selected time range and (re)draws the chart
async function loadGraphData(months) {
  let query = supabase
    .from('measurements')
    .select('*')
    .eq('athlete_id', athleteId)
    .eq('metric_id', currentGraphMetric.id)
    .order('date', { ascending: true })

  if (months > 0) {
    const fromDate = new Date()
    fromDate.setMonth(fromDate.getMonth() - months)
    query = query.gte('date', fromDate.toISOString().split('T')[0])
  }

  const { data } = await query

  // For Zone 2 metrics, show total km run within the selected time filter above the graph
  const periodStatEl = document.getElementById('graphPeriodStat')
  if (currentGraphMetric.type === 'zone2') {
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
  const changeStatEl = document.getElementById('graphChangeStat')
  const periodBadgeLabels = { 1: '1M', 3: '3M', 6: '6M', 12: '1Y', 0: 'All' }
  const getValue = m => currentGraphMetric.type === 'pogo' ? m.rsi : m.value

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
      .eq('metric_id', currentGraphMetric.id)
      .gte('date', previousStart.toISOString().split('T')[0])
      .lt('date', currentStart.toISOString().split('T')[0])

    previousPeriodData = prevData
  } else if (data && data.length >= 2) {
    const half = Math.floor(data.length / 2)
    previousPeriodData = data.slice(0, half)
    currentPeriodData = data.slice(half)
  }

  if (!currentPeriodData || currentPeriodData.length === 0 || !previousPeriodData || previousPeriodData.length === 0) {
    changeStatEl.innerHTML = ''
  } else {
    const currentAvg = currentPeriodData.reduce((sum, m) => sum + getValue(m), 0) / currentPeriodData.length
    const previousAvg = previousPeriodData.reduce((sum, m) => sum + getValue(m), 0) / previousPeriodData.length
    const pct = +(((currentAvg - previousAvg) / previousAvg) * 100).toFixed(1)
    const higherIsBetter = currentGraphMetric.higher_is_better
    const isPositive = higherIsBetter ? pct > 0 : pct < 0
    const cssClass = pct === 0 ? 'neutral' : isPositive ? 'positive' : 'negative'
    const arrow = pct > 0 ? '▲' : '▼'

    changeStatEl.innerHTML = `<span class="metric-change ${cssClass}" style="cursor:pointer" data-explain-type="period" data-metric-type="${currentGraphMetric.type}" data-metric-name="${currentGraphMetric.name}" data-period-label="${periodBadgeLabels[months]}" data-first-avg="${previousAvg.toFixed(3)}" data-second-avg="${currentAvg.toFixed(3)}" data-pct="${pct}" data-higher="${higherIsBetter}" data-unit="${currentGraphMetric.display_unit || currentGraphMetric.unit}">${arrow} ${Math.abs(pct)}%</span>`

    const badge = changeStatEl.querySelector('.metric-change')
    badge.addEventListener('click', function() { openChangeExplain(badge) })
  }

  if (!data || data.length === 0) {
    if (fullChart) { fullChart.destroy(); fullChart = null }
    return
  }

  const labels = data.map(m => m.date)
  const values = data.map(m => currentGraphMetric.type === 'pogo' ? m.rsi : m.value)

  if (fullChart) fullChart.destroy()

  const ctx = document.getElementById('fullGraph').getContext('2d')
  fullChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: currentGraphMetric.name,
        data: values,
        borderColor: '#4a4a8e',
        backgroundColor: 'rgba(74, 74, 142, 0.1)',
        borderWidth: 2,
        pointRadius: 5,
        tension: 0.3,
        fill: true
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false }
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

document.getElementById('closeGraphBtn').addEventListener('click', function() {
  document.getElementById('graphModal').classList.remove('active')
  if (fullChart) { fullChart.destroy(); fullChart = null }
})

// Switching the 1M/3M/1Y/All buttons re-loads the graph for that range
document.querySelectorAll('.time-filter-btn').forEach(btn => {
  btn.addEventListener('click', async function() {
    document.querySelectorAll('.time-filter-btn').forEach(b => b.classList.remove('active'))
    this.classList.add('active')
    const months = parseInt(this.dataset.months)
    await loadGraphData(months)
  })
})
// ==========================================================================
// ---- CREATE NEW METRIC ----
// Lets the user define a brand-new metric type (name/unit/type/category),
// save it to the DB, and immediately select it in the "add metric" dropdown.
// ==========================================================================
document.getElementById('createNewMetricBtn').addEventListener('click', function() {
  document.getElementById('addMetricModal').classList.remove('active')
  document.getElementById('createMetricModal').classList.add('active')
})

document.getElementById('cancelCreateMetricBtn').addEventListener('click', function() {
  document.getElementById('createMetricModal').classList.remove('active')
  document.getElementById('addMetricModal').classList.add('active')
})

document.getElementById('saveNewMetricBtn').addEventListener('click', async function() {
  const name = document.getElementById('newMetricName').value.trim()
  const unit = document.getElementById('newMetricUnit').value.trim()
  const type = document.getElementById('newMetricType').value

  if (!name || !unit) {
    alert('Please fill in both name and unit')
    return
  }

  const category = document.getElementById('newMetricCategory').value
  const { data, error } = await supabase
    .from('metrics')
    .insert([{ name, unit, type, category }])
    .select()

  if (error) {
    console.log('Error creating metric:', error)
    alert('Something went wrong')
    return
  }

  // Add new metric to allMetrics and dropdown
  allMetrics.push(data[0])
  const select = document.getElementById('metricSelect')
  const option = document.createElement('option')
  option.value = data[0].id
  option.textContent = `${data[0].name} (${data[0].unit})`
  select.appendChild(option)
  select.value = data[0].id

  // Clear form
  document.getElementById('newMetricName').value = ''
  document.getElementById('newMetricUnit').value = ''

  // Go back to add metric modal
  document.getElementById('createMetricModal').classList.remove('active')
  document.getElementById('addMetricModal').classList.add('active')

  alert(`"${name}" created and selected!`)
})
// ==========================================================================
// ---- ENTRIES MODAL ----
// Full history table for one metric: lists every measurement, with edit
// and delete actions per row.
// ==========================================================================
let currentEditEntry = null
let currentEntriesMetric = null

async function openEntriesModal(metric) {
  currentEntriesMetric = metric
  document.getElementById('entriesModalTitle').textContent = `${metric.name} — All Entries`
  document.getElementById('entriesModal').classList.add('active')

  await loadEntries(metric)
}

// Fetches and renders the entries table for a given metric
async function loadEntries(metric) {
  const { data, error } = await supabase
    .from('measurements')
    .select('*')
    .eq('athlete_id', athleteId)
    .eq('metric_id', metric.id)
    .order('date', { ascending: false })

  const list = document.getElementById('entriesList')

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
              <button class="btn-edit-entry" data-entry-id="${m.id}">✏</button>
              <button class="btn-delete-measurement" data-measurement-id="${m.id}">🗑</button>
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
      if (!confirm('Delete this entry?')) return

      const { error } = await supabase
        .from('measurements')
        .delete()
        .eq('id', measurementId)

      if (error) { alert('Something went wrong'); return }

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
  currentEditEntry = entry
  document.getElementById('editEntryDate').value = entry.date
  document.getElementById('editEntryNotes').value = entry.notes || ''

  if (metric.type === 'pogo') {
    document.getElementById('editSimpleFields').style.display = 'none'
    document.getElementById('editPogoFields').style.display = 'block'
    document.getElementById('editZone2Fields').style.display = 'none'
    const converted = convertValue(entry.height, metric.display_unit)
    document.getElementById('editPogoHeight').value = converted.text || ''
    document.getElementById('editPogoGroundContact').value = entry.ground_contact || ''
    document.getElementById('editPogoRSI').value = entry.rsi || ''
  } else if (metric.type === 'zone2') {
    document.getElementById('editSimpleFields').style.display = 'none'
    document.getElementById('editPogoFields').style.display = 'none'
    document.getElementById('editZone2Fields').style.display = 'block'
   const paceMin = Math.floor(entry.pace || 0)
    const paceSec = Math.round(((entry.pace || 0) - paceMin) * 60)
    document.getElementById('editZone2PaceMin').value = paceMin
    document.getElementById('editZone2PaceSec').value = paceSec
    document.getElementById('editZone2BPM').value = entry.bpm || ''
    document.getElementById('editZone2Distance').value = entry.distance || ''
    const durMin = Math.floor(entry.duration || 0)
    const durSec = Math.round(((entry.duration || 0) - durMin) * 60)
    document.getElementById('editZone2DurMin').value = durMin
    document.getElementById('editZone2DurSec').value = durSec
  } else {
    document.getElementById('editSimpleFields').style.display = 'block'
    document.getElementById('editPogoFields').style.display = 'none'
    document.getElementById('editZone2Fields').style.display = 'none'
    if (metric.display_unit === 'ft') {
      document.getElementById('editSingleValueGroup').style.display = 'none'
      document.getElementById('editFeetInchesGroup').style.display = 'block'
      const totalInches = (entry.value / 2.54)
      const feet = Math.floor(totalInches / 12)
      const inches = +(totalInches % 12).toFixed(1)
      document.getElementById('editEntryFeet').value = feet
      document.getElementById('editEntryInches').value = inches
    } else {
      document.getElementById('editSingleValueGroup').style.display = 'block'
      document.getElementById('editFeetInchesGroup').style.display = 'none'
      document.getElementById('editValueLabel').textContent = `${metric.name} (${metric.display_unit || metric.unit})`
      const converted = convertValue(entry.value, metric.display_unit)
      document.getElementById('editEntryValue').value = converted.text || ''
    }
  }

  document.getElementById('editEntryModal').classList.add('active')
}

document.getElementById('closeEntriesBtn').addEventListener('click', function() {
  document.getElementById('entriesModal').classList.remove('active')
})

document.getElementById('cancelEditEntryBtn').addEventListener('click', function() {
  document.getElementById('editEntryModal').classList.remove('active')
})

// Saves edits to an existing measurement, rebuilding the payload per metric type
document.getElementById('saveEditEntryBtn').addEventListener('click', async function() {
  const date = document.getElementById('editEntryDate').value
  if (!date) { alert('Please select a date'); return }

  let updateData = {
    date,
    notes: document.getElementById('editEntryNotes').value
  }

 if (currentEntriesMetric.type === 'pogo') {
    updateData.height = convertInput(parseFloat(document.getElementById('editPogoHeight').value), currentEntriesMetric.display_unit)
    updateData.ground_contact = parseFloat(document.getElementById('editPogoGroundContact').value)
    updateData.rsi = parseFloat(document.getElementById('editPogoRSI').value)
  } else if (currentEntriesMetric.type === 'zone2') {
    const paceMin = parseFloat(document.getElementById('editZone2PaceMin').value) || 0
    const paceSec = parseFloat(document.getElementById('editZone2PaceSec').value) || 0
    const pace = paceMin + (paceSec / 60)
    const bpm = parseFloat(document.getElementById('editZone2BPM').value)
    const distance = parseFloat(document.getElementById('editZone2Distance').value)
    const durMin = parseFloat(document.getElementById('editZone2DurMin').value) || 0
    const durSec = parseFloat(document.getElementById('editZone2DurSec').value) || 0
    const duration = durMin + (durSec / 60)
    updateData.pace = pace
    updateData.bpm = bpm
    updateData.distance = distance
    updateData.duration = duration
    updateData.value = +(1000 / (pace * bpm)).toFixed(3)
  } else {
    let rawValue
   if (currentEntriesMetric.display_unit === 'ft') {
      const feet = parseFloat(document.getElementById('editEntryFeet').value) || 0
      const inches = parseFloat(document.getElementById('editEntryInches').value) || 0
      rawValue = feet + (inches / 12)
    } else {
      rawValue = parseFloat(document.getElementById('editEntryValue').value)
    }
    updateData.value = convertInput(rawValue, currentEntriesMetric.display_unit)
  }

  const { error } = await supabase
    .from('measurements')
    .update(updateData)
    .eq('id', currentEditEntry.id)

  if (error) { console.log(error); alert('Something went wrong'); return }

  document.getElementById('editEntryModal').classList.remove('active')
  await loadEntries(currentEntriesMetric)
  loadAthleteMetrics()
})
// ==========================================================================
// ---- EDIT ATHLETE INFO ----
// Saves changes made in the "edit athlete" modal (name, DOB, gender, height).
// Weight is not edited here - see the Bodyweight feature for that.
// ==========================================================================
document.getElementById('closeEditAthleteBtn').addEventListener('click', function() {
  document.getElementById('editAthleteModal').classList.remove('active')
})

document.getElementById('cancelEditAthleteBtn').addEventListener('click', function() {
  document.getElementById('editAthleteModal').classList.remove('active')
})

document.getElementById('saveEditAthleteBtn').addEventListener('click', async function() {
  const name = document.getElementById('editAthleteName').value.trim()
  const dob = document.getElementById('editAthleteDOB').value
  const gender = document.getElementById('editAthleteGender').value
  const height = parseInt(document.getElementById('editAthleteHeight').value)

  if (!name) { alert('Please enter a name'); return }

  const { error } = await supabase
    .from('athletes')
    .update({ name, date_of_birth: dob, gender, height })
    .eq('id', athleteId)

  if (error) { console.log(error); alert('Something went wrong'); return }

  document.getElementById('editAthleteModal').classList.remove('active')
  loadAthlete()
})
// ==========================================================================
// ---- BODYWEIGHT ----
// Loads and draws the bodyweight trend chart on the profile header, and
// handles logging a new bodyweight entry.
// ==========================================================================
let bodyweightChart = null
let bodyweightUnit = 'kg'

async function loadBodyweightGraph() {
  const { data, error } = await supabase
    .from('bodyweight')
    .select('*')
    .eq('athlete_id', athleteId)
    .order('date', { ascending: true })

  const canvas = document.getElementById('bodyweightGraph')
  const noDataMsg = document.getElementById('noBodyweightMsg')

  if (!data || data.length === 0) {
    canvas.style.display = 'none'
    noDataMsg.style.display = 'block'
    return
  }

  noDataMsg.style.display = 'none'
  canvas.style.display = 'block'

  if (bodyweightChart) bodyweightChart.destroy()

  bodyweightChart = new Chart(canvas, {
    type: 'line',
    data: {
      labels: data.map(d => d.date),
     datasets: [{
        // Convert stored kg values to lbs on the fly if the user has lbs selected
        data: data.map(d => bodyweightUnit === 'kg' ? d.weight : +(d.weight * 2.20462).toFixed(1)),
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

document.getElementById('addBodyweightBtn').addEventListener('click', function() {
  document.getElementById('bodyweightDate').valueAsDate = new Date()
  document.getElementById('bodyweightModal').classList.add('active')
})

document.getElementById('closeBodyweightBtn').addEventListener('click', function() {
  document.getElementById('bodyweightModal').classList.remove('active')
})

document.getElementById('cancelBodyweightBtn').addEventListener('click', function() {
  document.getElementById('bodyweightModal').classList.remove('active')
})

// Saves a new bodyweight entry; always stores in kg regardless of input unit
document.getElementById('saveBodyweightBtn').addEventListener('click', async function() {
  const date = document.getElementById('bodyweightDate').value
  const rawWeight = parseFloat(document.getElementById('bodyweightValue').value)
  const inputUnit = document.getElementById('bodyweightInputUnit').value
  const weight = inputUnit === 'lbs' ? +(rawWeight / 2.20462).toFixed(2) : rawWeight
  const notes = document.getElementById('bodyweightNotes').value

  if (!date || !weight) { alert('Please fill in date and weight'); return }

  const { error } = await supabase
    .from('bodyweight')
    .insert([{ athlete_id: parseInt(athleteId), date, weight, notes }])

  if (error) { console.log(error); alert('Something went wrong'); return }

  document.getElementById('bodyweightModal').classList.remove('active')
  document.getElementById('bodyweightValue').value = ''
  document.getElementById('bodyweightNotes').value = ''
  loadBodyweightGraph()
})
// ==========================================================================
// ---- BODYWEIGHT UNIT TOGGLE ----
// Switches the bodyweight display (and re-draws the chart) between kg/lbs.
// Note: values are always stored in kg — this only changes how they're shown.
// ==========================================================================
document.getElementById('bwKgBtn').addEventListener('click', function() {
  bodyweightUnit = 'kg'
  document.getElementById('bwKgBtn').classList.add('active')
  document.getElementById('bwLbsBtn').classList.remove('active')
  loadBodyweightGraph()
})

document.getElementById('bwLbsBtn').addEventListener('click', function() {
  bodyweightUnit = 'lbs'
  document.getElementById('bwLbsBtn').classList.add('active')
  document.getElementById('bwKgBtn').classList.remove('active')
  loadBodyweightGraph()
})
// ==========================================================================
// ---- BODYWEIGHT ENTRIES ----
// Full history table for bodyweight logs, with edit/delete per row (mirrors
// the metric ENTRIES MODAL above, but for the bodyweight table).
// ==========================================================================
let currentBWEntry = null

document.getElementById('viewBWEntriesBtn').addEventListener('click', function() {
  document.getElementById('bwEntriesModal').classList.add('active')
  loadBWEntries()
})

document.getElementById('closeBWEntriesBtn').addEventListener('click', function() {
  document.getElementById('bwEntriesModal').classList.remove('active')
})

async function loadBWEntries() {
  const { data, error } = await supabase
    .from('bodyweight')
    .select('*')
    .eq('athlete_id', athleteId)
    .order('date', { ascending: false })

  const list = document.getElementById('bwEntriesList')

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
            <td>${bodyweightUnit === 'lbs' ? +(m.weight * 2.20462).toFixed(1) + ' lbs' : m.weight + ' kg'}</td>
            <td>${m.notes || '—'}</td>
            <td>
              <button class="btn-edit-entry" data-entry-id="${m.id}">✏</button>
              <button class="btn-delete-measurement" data-entry-id="${m.id}">🗑</button>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `

  list.querySelectorAll('.btn-delete-measurement').forEach(btn => {
    btn.addEventListener('click', async function() {
      const entryId = parseInt(this.dataset.entryId)
      if (!confirm('Delete this entry?')) return

      const { error } = await supabase
        .from('bodyweight')
        .delete()
        .eq('id', entryId)

      if (error) { alert('Something went wrong'); return }

      loadBWEntries()
      loadBodyweightGraph()
    })
  })

  list.querySelectorAll('.btn-edit-entry').forEach(btn => {
    btn.addEventListener('click', function() {
      const entryId = parseInt(this.dataset.entryId)
      currentBWEntry = data.find(m => m.id === entryId)
      document.getElementById('editBWDate').value = currentBWEntry.date
      document.getElementById('editBWValue').value = currentBWEntry.weight
      document.getElementById('editBWUnit').value = 'kg'
      document.getElementById('editBWNotes').value = currentBWEntry.notes || ''
      document.getElementById('editBWEntryModal').classList.add('active')
    })
  })
}

document.getElementById('cancelEditBWBtn').addEventListener('click', function() {
  document.getElementById('editBWEntryModal').classList.remove('active')
})

document.getElementById('saveEditBWBtn').addEventListener('click', async function() {
  const date = document.getElementById('editBWDate').value
  const rawWeight = parseFloat(document.getElementById('editBWValue').value)
  const unit = document.getElementById('editBWUnit').value
  const weight = unit === 'lbs' ? +(rawWeight / 2.20462).toFixed(2) : rawWeight
  const notes = document.getElementById('editBWNotes').value

  if (!date || !weight) { alert('Please fill in date and weight'); return }

  const { error } = await supabase
    .from('bodyweight')
    .update({ date, weight, notes })
    .eq('id', currentBWEntry.id)

  if (error) { alert('Something went wrong'); return }

  document.getElementById('editBWEntryModal').classList.remove('active')
  loadBWEntries()
  loadBodyweightGraph()
})
// ==========================================================================
// ---- % CHANGE EXPLANATION ----
// Opens a small modal that explains how the ▲/▼ % change badge on a metric
// card was calculated (which numbers were compared and why).
// ==========================================================================
function openChangeExplain(el) {
  const type = el.dataset.explainType
  const metricName = el.dataset.metricName
  const pct = parseFloat(el.dataset.pct)
  const higher = el.dataset.higher === 'true'
  const isPositive = higher ? pct > 0 : pct < 0
  const cssClass = pct === 0 ? 'neutral' : isPositive ? 'positive' : 'negative'
  const arrow = pct > 0 ? '▲' : '▼'

  document.getElementById('changeExplainTitle').textContent = `${metricName} — Change Breakdown`

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

  document.getElementById('changeExplainContent').innerHTML = content
  document.getElementById('changeExplainModal').classList.add('active')
}

document.getElementById('closeChangeExplainBtn').addEventListener('click', function() {
  document.getElementById('changeExplainModal').classList.remove('active')
})