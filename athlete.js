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

// Load everything when page opens
loadAthlete()
loadAllMetrics().then(() => loadAthleteMetrics())

// ---- LOAD ATHLETE INFO ----
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
    `${data.gender} · ${age} years old · ${data.height}cm · ${data.weight}kg`

  document.title = `${data.name} — TBFlog`
}

// ---- LOAD ALL AVAILABLE METRICS ----
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

// ---- LOAD ATHLETE'S ASSIGNED METRICS ----
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
}

// ---- RENDER METRICS ON SCREEN ----
async function renderMetrics() {
  const list = document.getElementById('metricsList')
  list.innerHTML = ''

  if (athleteMetrics.length === 0) {
    list.innerHTML = '<p class="no-metrics">No metrics added yet — click "+ Add Metric" to start tracking!</p>'
    return
  }

  for (const am of athleteMetrics) {
    const metric = am.metrics

   // Load last 5 measurements for mini graph
    const { data: measurements } = await supabase
      .from('measurements')
      .select('*')
      .eq('athlete_id', athleteId)
      .eq('metric_id', metric.id)
      .order('date', { ascending: true })
      .limit(5)

    const item = document.createElement('div')
    item.classList.add('metric-item')

    let historyHTML = ''
    if (measurements && measurements.length > 0) {
     historyHTML = measurements.map(m => {
        if (metric.type === 'pogo') {
          return `<div class="measurement-row">
            <span>${m.date}</span>
            <span>Height: ${m.height}cm · GCT: ${m.ground_contact}ms · RSI: ${m.rsi}</span>
            <button class="btn-delete-measurement" data-measurement-id="${m.id}">🗑</button>
          </div>`
        } else {
          return `<div class="measurement-row">
            <span>${m.date}</span>
            <span>${m.value} ${metric.unit}</span>
            <button class="btn-delete-measurement" data-measurement-id="${m.id}">🗑</button>
          </div>`
        }
      }).join('')
    } else {
      historyHTML = '<p style="color:#bbb;font-size:13px">No measurements yet</p>'
    }

    // Get latest measurement for display
    const latest = measurements && measurements.length > 0 ? measurements[measurements.length - 1] : null
    let latestText = 'No measurements yet'
    if (latest) {
      if (metric.type === 'pogo') {
        latestText = `Height: ${latest.height}cm · GCT: ${latest.ground_contact}ms · RSI: ${latest.rsi}`
      } else {
        latestText = `${latest.value} ${metric.unit}`
      }
    }

    item.innerHTML = `
      <div class="metric-item-header">
        <h4>${metric.name}</h4>
        <div style="display:flex; gap:8px">
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

    list.appendChild(item)
  }

// Add click listeners to all record buttons
  document.querySelectorAll('.btn-record').forEach(btn => {
    btn.addEventListener('click', function() {
      const metricId = parseInt(this.dataset.metricId)
      currentMetric = allMetrics.find(m => m.id === metricId)
      openMeasurementModal()
    })
  })

  // Draw mini graphs
  for (const am of athleteMetrics) {
    const metric = am.metrics
    const canvas = document.getElementById(`mini-graph-${metric.id}`)
    if (!canvas) continue

    const { data: graphData } = await supabase
      .from('measurements')
      .select('*')
      .eq('athlete_id', athleteId)
      .eq('metric_id', metric.id)
      .order('date', { ascending: true })
      .limit(5)

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

    canvas.addEventListener('click', function() {
      openGraphModal(metric)
    })
  }

  document.querySelectorAll('.btn-delete-metric').forEach(btn => {
    btn.addEventListener('click', async function() {
      const athleteMetricId = parseInt(this.dataset.athleteMetricId)
      
      if (!confirm('Remove this metric from the athlete?')) return

      const { error } = await supabase
        .from('athlete_metrics')
        .delete()
        .eq('id', athleteMetricId)

      if (error) {
        console.log('Error deleting metric:', error)
        alert('Something went wrong')
        return
      }

      loadAthleteMetrics()
    })
  })

  document.querySelectorAll('.btn-delete-measurement').forEach(btn => {
    btn.addEventListener('click', async function() {
      const measurementId = parseInt(this.dataset.measurementId)
      
      if (!confirm('Delete this measurement?')) return

      const { error } = await supabase
        .from('measurements')
        .delete()
        .eq('id', measurementId)

      if (error) {
        console.log('Error deleting measurement:', error)
        alert('Something went wrong')
        return
      }

      loadAthleteMetrics()
    })
  })
}

// ---- OPEN MEASUREMENT MODAL ----

function openMeasurementModal() {
  document.getElementById('measurementModalTitle').textContent = 
    `Record — ${currentMetric.name}`

  // Set today's date as default
  document.getElementById('measurementDate').valueAsDate = new Date()

  // Show right fields based on metric type
  if (currentMetric.type === 'pogo') {
    document.getElementById('simpleFields').style.display = 'none'
    document.getElementById('pogoFields').style.display = 'block'
  } else {
    document.getElementById('simpleFields').style.display = 'block'
    document.getElementById('pogoFields').style.display = 'none'
    document.getElementById('valueLabel').textContent = 
      `${currentMetric.name} (${currentMetric.unit})`
  }

  document.getElementById('addMeasurementModal').classList.add('active')
}

// ---- ADD METRIC MODAL ----
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

// ---- MEASUREMENT MODAL ----
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
    insertData.height = parseFloat(document.getElementById('pogoHeight').value)
    insertData.ground_contact = parseFloat(document.getElementById('pogoGroundContact').value)
    insertData.rsi = parseFloat(document.getElementById('pogoRSI').value)
  } else {
    insertData.value = parseFloat(document.getElementById('measurementValue').value)
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
// ---- GRAPH MODAL ----
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

document.querySelectorAll('.time-filter-btn').forEach(btn => {
  btn.addEventListener('click', async function() {
    document.querySelectorAll('.time-filter-btn').forEach(b => b.classList.remove('active'))
    this.classList.add('active')
    const months = parseInt(this.dataset.months)
    await loadGraphData(months)
  })
})