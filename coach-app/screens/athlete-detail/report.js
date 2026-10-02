// ==========================================================================
// ATHLETE DETAIL - PDF progress report
// Report builder modal, the section calculators, PDF generation, and sharing
// the report to the athlete's chat.
// ==========================================================================
import { supabase } from '../../../coachClient.js?v=__V__'
import { sendPush } from '../../../push.js?v=__V__'
import * as nav from '../../nav.js?v=__V__'
import { coachId } from '../../session.js?v=__V__'
import { loadChartJs, loadJsPdf } from '../../vendor.js?v=__V__'
import { toDateStr } from '../../../shared/dates.js?v=__V__'
import { root, mountToken, athleteId, currentAthlete, met, rep } from './state.js?v=__V__'
import { convertValue } from './metrics.js?v=__V__'
import { formatDurationOv, resolveDateOv, setVolumeOv } from './overview.js?v=__V__'
import { showToast } from './toast.js?v=__V__'
import { fetchAllRows } from '../../../shared/fetch-all.js?v=__V__'

// ==========================================================================
// ---- PDF PROGRESS REPORT ----
// "Generate Report" button at the top of the Metrics tab opens a checklist
// of sections (only ones with real logged data are offered) + a 1/3/6/9/12
// month picker, then builds a PDF client-side with jsPDF and opens it in a
// new tab. No saved template - the checklist is picked fresh every time.
// ==========================================================================
export function bindReportEvents() {
  root.querySelector('#generateReportBtn').addEventListener('click', openReportBuilderModal)

  root.querySelector('#closeReportBuilderModalBtn').addEventListener('click', function() {
    root.querySelector('#reportBuilderModal').classList.remove('active')
  })

  root.querySelector('#reportSectionChecklist').addEventListener('click', function(e) {
    const btn = e.target.closest('.chip-btn')
    if (!btn) return
    const key = btn.dataset.key
    if (rep.reportSelectedSections.has(key)) {
      rep.reportSelectedSections.delete(key)
      btn.classList.remove('selected')
    } else {
      rep.reportSelectedSections.add(key)
      btn.classList.add('selected')
    }
  })

  root.querySelector('#reportMonthsRow').addEventListener('click', function(e) {
    const btn = e.target.closest('.time-filter-btn')
    if (!btn) return
    root.querySelectorAll('#reportMonthsRow .time-filter-btn').forEach(b => b.classList.remove('active'))
    btn.classList.add('active')
    rep.reportSelectedMonths = parseInt(btn.dataset.months)
  })

  root.querySelector('#generatePdfBtn').addEventListener('click', generateReportPDF)
}

async function openReportBuilderModal() {
  const token = mountToken
  root.querySelector('#reportBuilderModal').classList.add('active')
  root.querySelector('#reportSectionChecklist').innerHTML = '<p class="no-metrics">Checking available data...</p>'
  root.querySelector('#reportSendToChatLabel').textContent = `Also send to ${currentAthlete ? currentAthlete.name : 'athlete'} in chat`
  root.querySelector('#reportSendToChat').checked = false
  rep.reportDataCache = await fetchReportData()
  if (!nav.isCurrent(token)) return
  if (!rep.reportDataCache) {
    root.querySelector('#reportBuilderModal').classList.remove('active')
    return
  }
  rep.reportSelectedSections = new Set(rep.reportDataCache.availableSections.map(s => s.key))
  renderReportChecklist()
}

// One batch of unbounded-history queries, cached in reportDataCache for the
// lifetime of one modal-open - both the eligibility checklist AND the final
// PDF read from this same cache, filtered to whichever date range the coach
// picks, so there's exactly one round of requests per report attempt.
async function fetchReportData() {
  const [
    { data: programs, error: programsError },
    { data: sessions, error: sessionsError }
  ] = await Promise.all([
    fetchAllRows(window.fetchWithRetry, () => supabase
      .from('programs')
      .select('*, program_weeks(*, program_days(*, program_exercises(*, exercises!exercise_id(id, name, type, tracks_weight, foot_contacts, intensity_tier))))')
      .eq('athlete_id', athleteId)
      .eq('is_template', false)
    ),
    fetchAllRows(window.fetchWithRetry, () => supabase
      .from('workout_sessions')
      .select('*')
      .eq('athlete_id', athleteId)
      .not('ended_at', 'is', null)
      .order('started_at', { ascending: true })
    )
  ])

  if (programsError || sessionsError) {
    console.log('Error loading report data:', programsError || sessionsError)
    customAlert('Something went wrong loading report data - check your connection and try again')
    return null
  }

  // Same workoutEntries/peInfoById shape loadOverviewStats already builds,
  // just unbounded (no 90-day cap) since PR baselines and a 12-month report
  // both need full history
  const workoutEntries = [] // { dateStr, exercises }
  const peInfoById = {} // program_exercise_id -> joined exercises row
  for (const program of programs) {
    for (const week of program.program_weeks) {
      for (const day of week.program_days) {
        const dateStr = day.date_override || resolveDateOv(program.start_date, week.week_number, day.day_number)
        workoutEntries.push({ dateStr, exercises: day.program_exercises })
        for (const pe of day.program_exercises) {
          // A per-instance "Adjust Fields" override (Workout Builder) wins
          // over the exercise's own tracks_weight default when present -
          // durationStatsForRange() below reads .tracks_weight off this
          // same object, so it needs to see the resolved value too
          if (pe.exercises) {
            const tracksWeight = pe.tracks_weight_override != null ? pe.tracks_weight_override : !!pe.exercises.tracks_weight
            peInfoById[pe.id] = { ...pe.exercises, tracks_weight: tracksWeight }
          }
        }
      }
    }
  }

  // Fetched by athlete, not by listing every program_exercise id - that id
  // list went into the URL and overflowed it for athletes with a long
  // history. Paged (fetchAllRows), because Supabase caps a response at
  // 1,000 rows and this is oldest-first, so a long history used to silently
  // lose its newest sets. The filter keeps the same set as before: sets on exercises the
  // report knows about.
  let logSets = []
  if (Object.keys(peInfoById).length > 0) {
    const { data, error } = await fetchAllRows(window.fetchWithRetry, () => supabase
      .from('exercise_log_sets')
      .select('*')
      .eq('athlete_id', athleteId)
      .not('completed_at', 'is', null)
      .order('date', { ascending: true })
    )
    if (error) {
      console.log('Error loading report log sets:', error)
      customAlert('Something went wrong loading report data - check your connection and try again')
      return null
    }
    logSets = data.filter(s => peInfoById[s.program_exercise_id])
  }

  // Eligibility - a section is only offered if the athlete actually has
  // qualifying data, anywhere in their history
  const availableSections = []
  for (const am of met.athleteMetrics) {
    if (!am.metrics) continue
    if (met.allMeasurementsCache.some(m => m.metric_id === am.metrics.id)) {
      availableSections.push({ key: `metric:${am.metrics.id}`, label: am.metrics.name, kind: 'metric', metric: am.metrics })
    }
  }
  if (sessions.length > 0) {
    availableSections.push({ key: 'overview', label: 'Workout Overview', kind: 'overview' })
  }
  if (logSets.some(s => { const ex = peInfoById[s.program_exercise_id]; return ex && ex.type === 'plyometric' && ex.foot_contacts })) {
    availableSections.push({ key: 'plyo', label: 'Plyometric Load', kind: 'plyo' })
  }

  return { workoutEntries, peInfoById, logSets, sessions, availableSections }
}

function renderReportChecklist() {
  const container = root.querySelector('#reportSectionChecklist')
  if (rep.reportDataCache.availableSections.length === 0) {
    container.innerHTML = '<p class="no-metrics">No logged data yet for this athlete - nothing to report on.</p>'
    return
  }
  container.innerHTML = rep.reportDataCache.availableSections.map(s => `
    <button type="button" class="chip-btn selected" data-key="${s.key}">${s.label}</button>
  `).join('')
}

// { from, to } is the chosen report window; { prevFrom, prevTo } is the
// immediately-preceding period of equal length, used for the "vs previous
// period" deltas that make this read as a progress report, not a snapshot
function buildReportRange(months) {
  const to = new Date()
  const from = new Date(to)
  from.setMonth(from.getMonth() - months)
  const prevTo = new Date(from)
  prevTo.setDate(prevTo.getDate() - 1)
  const prevFrom = new Date(prevTo)
  prevFrom.setMonth(prevFrom.getMonth() - months)
  return {
    from: toDateStr(from), to: toDateStr(to),
    prevFrom: toDateStr(prevFrom), prevTo: toDateStr(prevTo)
  }
}

// ---- Section calculators - pure functions, no DOM/network, operate on the
// already-fetched reportDataCache plus a date range from buildReportRange ----

// Same rule completionRate() (loadOverviewStats) uses, generalized from a
// fixed windowDays to an arbitrary [from, to] range - including the "today
// isn't over yet" exception, so a report window ending today (as every
// report window does, see buildReportRange) doesn't count an unfinished
// same-day workout as missed
function completionRateForRange(workoutEntries, logSetsByPE, from, to) {
  const todayStr = toDateStr(new Date())
  let scheduled = 0
  let completed = 0
  for (const entry of workoutEntries) {
    if (entry.dateStr < from || entry.dateStr > to) continue
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

function volumeForRange(logSets, peInfoById, from, to) {
  return logSets
    .filter(s => s.date >= from && s.date <= to && peInfoById[s.program_exercise_id] && peInfoById[s.program_exercise_id].tracks_weight)
    .reduce((sum, s) => sum + setVolumeOv(s), 0)
}

function durationStatsForRange(sessions, from, to) {
  const inRange = sessions.filter(s => s.local_date >= from && s.local_date <= to)
  if (inRange.length === 0) return null
  const totalMinutes = inRange.reduce((sum, s) => sum + (new Date(s.ended_at) - new Date(s.started_at)) / 60000, 0)
  return Math.round(totalMinutes / inRange.length)
}

function computeWorkoutOverviewSection(cache, range) {
  const logSetsByPE = {}
  for (const row of cache.logSets) {
    if (!logSetsByPE[row.program_exercise_id]) logSetsByPE[row.program_exercise_id] = []
    logSetsByPE[row.program_exercise_id].push(row)
  }
  return {
    completion: completionRateForRange(cache.workoutEntries, logSetsByPE, range.from, range.to),
    prevCompletion: completionRateForRange(cache.workoutEntries, logSetsByPE, range.prevFrom, range.prevTo),
    volumeKg: Math.round(volumeForRange(cache.logSets, cache.peInfoById, range.from, range.to)),
    prevVolumeKg: Math.round(volumeForRange(cache.logSets, cache.peInfoById, range.prevFrom, range.prevTo)),
    avgDurationMin: durationStatsForRange(cache.sessions, range.from, range.to),
    prevAvgDurationMin: durationStatsForRange(cache.sessions, range.prevFrom, range.prevTo)
  }
}

// Same 30-days-vs-previous-30-days formula the Metrics tab's zone2 change
// badge uses (renderMetrics()), so the report's % always matches the app's
function zone2ChangePct(allForMetric) {
  const now = new Date()
  const thirtyDaysAgo = toDateStr(new Date(now - 30 * 24 * 60 * 60 * 1000))
  const sixtyDaysAgo = toDateStr(new Date(now - 60 * 24 * 60 * 60 * 1000))
  const last30 = allForMetric.filter(m => m.date >= thirtyDaysAgo)
  const prev30 = allForMetric.filter(m => m.date >= sixtyDaysAgo && m.date < thirtyDaysAgo)
  if (last30.length === 0 || prev30.length === 0) return null
  const avg30 = last30.reduce((sum, m) => sum + m.value, 0) / last30.length
  const avgPrev = prev30.reduce((sum, m) => sum + m.value, 0) / prev30.length
  if (!avgPrev) return null
  return +(((avg30 - avgPrev) / avgPrev) * 100).toFixed(1)
}

// Same "latest vs avg of previous 5 entries" formula the Metrics tab uses
// for every non-zone2 metric type - also always matches the app's number
function simpleChangePct(allForMetric, getValue) {
  if (allForMetric.length < 2) return null
  const latestVal = getValue(allForMetric[allForMetric.length - 1])
  const previous = allForMetric.slice(0, -1).slice(-5)
  const avgPrev = previous.reduce((sum, m) => sum + getValue(m), 0) / previous.length
  if (!avgPrev) return null
  return +(((latestVal - avgPrev) / avgPrev) * 100).toFixed(1)
}

// Converts a metric's raw stored values into whatever unit actually gets
// charted, so the trend chart's axis is never in a different unit than the
// headline "Latest" tile next to it (ft/in display units aren't directly
// plottable as feet'inches" text, so both chart as inches instead)
function chartUnitAndValues(metric, rawValues) {
  if (metric.type === 'pogo') return { unit: 'RSI', values: rawValues }
  if (metric.type === 'zone2') return { unit: 'Score', values: rawValues }
  const displayUnit = metric.display_unit
  if (displayUnit === 'in' || displayUnit === 'ft') {
    return { unit: 'in', values: rawValues.map(v => +(v / 2.54).toFixed(1)) }
  }
  return { unit: displayUnit || '', values: rawValues }
}

// "Latest" + its % change always reuse the exact same formulas/history the
// Metrics tab itself uses (see zone2ChangePct/simpleChangePct above), so
// they can never disagree with what the coach already sees there - only
// the trend chart is actually scoped to the chosen report window
function computeCustomMetricSection(metric, range) {
  const allForMetric = met.allMeasurementsCache
    .filter(m => m.metric_id === metric.id)
    .sort((a, b) => a.date.localeCompare(b.date))

  if (allForMetric.length === 0) return { metric, hasData: false }

  const getValue = m => metric.type === 'pogo' ? m.rsi : m.value
  const latestValue = getValue(allForMetric[allForMetric.length - 1])
  const pct = metric.type === 'zone2' ? zone2ChangePct(allForMetric) : simpleChangePct(allForMetric, getValue)

  const inRange = allForMetric.filter(m => m.date >= range.from && m.date <= range.to)
  const { unit: chartUnit, values: chartValues } = chartUnitAndValues(metric, inRange.map(getValue))

  return { metric, hasData: true, latestValue, pct, dates: inRange.map(m => m.date), chartValues, chartUnit }
}

// Same formula as the athlete app's per-session plyo load (foot_contacts x
// intensity multiplier x completed sets), summed per date across the whole
// report window, plus the equal-length prior period for a delta callout
function computePlyoSection(cache, range) {
  const multiplier = { low: 1, moderate: 1.5, high: 2 }
  const byDate = {}
  for (const s of cache.logSets) {
    const ex = cache.peInfoById[s.program_exercise_id]
    if (!ex || ex.type !== 'plyometric' || !ex.foot_contacts) continue
    const load = ex.foot_contacts * (multiplier[ex.intensity_tier] || 1)
    byDate[s.date] = (byDate[s.date] || 0) + load
  }

  const inRangeDates = Object.keys(byDate).filter(d => d >= range.from && d <= range.to).sort()
  const prevDates = Object.keys(byDate).filter(d => d >= range.prevFrom && d <= range.prevTo)

  return {
    hasData: inRangeDates.length > 0,
    dates: inRangeDates,
    values: inRangeDates.map(d => Math.round(byDate[d])),
    totalInRange: Math.round(inRangeDates.reduce((sum, d) => sum + byDate[d], 0)),
    totalPrev: Math.round(prevDates.reduce((sum, d) => sum + byDate[d], 0))
  }
}

// Loads an image from this same origin (the Tobe-Fit logo) and re-draws it
// onto a canvas so it can be embedded in the PDF as a data URL - resolves
// null on any failure so a broken/slow logo load never blocks the report
function loadImageAsDataUrl(url) {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = img.naturalWidth
      canvas.height = img.naturalHeight
      canvas.getContext('2d').drawImage(img, 0, 0)
      resolve({ dataUrl: canvas.toDataURL('image/png'), width: img.naturalWidth, height: img.naturalHeight })
    }
    img.onerror = () => resolve(null)
    img.src = url
  })
}

// Same value+unit formatting the Metrics tab cards already use
// (renderMetrics()) - pogo shows "RSI", zone2 shows "Score", everything
// else goes through convertValue() for its real display unit (cm/kg/etc)
function formatMetricValue(metric, value) {
  if (metric.type === 'pogo') return `${value} RSI`
  if (metric.type === 'zone2') return `Score: ${value}`
  const converted = convertValue(value, metric.display_unit)
  return converted.unit ? `${converted.text} ${converted.unit}` : `${converted.text}`
}

// Renders a Chart.js line chart into a throwaway off-screen canvas (never
// attached to the page, so this never disturbs what's visible on the
// Metrics tab), forces a white background (these charts are transparent by
// default against this app's dark theme, which would look wrong on a white
// PDF page), and returns the new y-cursor position after placing the image.
// The chart is destroyed synchronously right after its image is grabbed, so
// (unlike fullChart/bodyweightChart/volumeChart/miniChartInstances) there's
// nothing left over for unmount() to track.
function drawTrendChart(doc, labels, values, title, margin, y, pageWidth, heightMm) {
  // Canvas is built at EXACTLY the same aspect ratio as the box it'll be
  // placed into below - addImage stretches to fit whatever width/height
  // it's given, so any mismatch here previously showed up as a visibly
  // squashed/compressed chart
  const boxWidthMm = pageWidth - margin * 2
  const canvasWidth = 1000
  const canvasHeight = Math.round(canvasWidth / (boxWidthMm / heightMm))
  const canvas = document.createElement('canvas')
  canvas.width = canvasWidth
  canvas.height = canvasHeight
  const chart = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        data: values,
        borderColor: '#4a4a8e',
        backgroundColor: 'rgba(74,74,142,0.12)',
        fill: true,
        tension: 0.35,
        borderWidth: 3,
        pointRadius: 0
      }]
    },
    options: {
      responsive: false,
      animation: false,
      // devicePixelRatio 1, not 2 - this chart only ever gets printed into a
      // ~62mm-tall PDF box, where a 1000px-wide source is already ~140 DPI;
      // doubling that (as devicePixelRatio: 2 used to) quadrupled every
      // chart's exported PNG bytes for no visible gain, and a report with
      // many tracked metrics selected could add up past the storage
      // bucket's upload size limit
      devicePixelRatio: 1,
      layout: { padding: { top: 6, right: 10, bottom: 2, left: 4 } },
      plugins: {
        legend: { display: false },
        title: { display: !!title, text: title, color: '#333333', font: { size: 15, weight: 'bold' }, padding: { bottom: 10 } }
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: '#888888', font: { size: 11 }, autoSkip: true, maxTicksLimit: 6 } },
        y: { grid: { color: '#eeeeee' }, ticks: { color: '#888888', font: { size: 11 } } }
      }
    },
    plugins: [{
      id: 'whiteBackground',
      beforeDraw: (c) => {
        const ctx = c.canvas.getContext('2d')
        ctx.save()
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, c.width, c.height)
        ctx.restore()
      }
    }]
  })

  const imgData = chart.toBase64Image()
  chart.destroy()

  doc.addImage(imgData, 'PNG', margin, y, pageWidth - margin * 2, heightMm)
  return y + heightMm + 4
}

async function generateReportPDF() {
  if (!rep.reportDataCache) return

  // await loadJsPdf()/loadChartJs() replace the old `if (!window.jspdf)`
  // guard - see this file's top banner comment. Both are cached (see
  // vendor.js) so this is a no-op after the first report of a visit.
  await loadJsPdf()
  await loadChartJs()
  if (!root) return

  const range = buildReportRange(rep.reportSelectedMonths)
  const MONTHS_LABELS = { 1: 'Last Month', 3: 'Last 3 Months', 6: 'Last 6 Months', 9: 'Last 9 Months', 12: 'Last 12 Months' }
  const periodLabel = MONTHS_LABELS[rep.reportSelectedMonths] || `Last ${rep.reportSelectedMonths} Months`

  const btn = root.querySelector('#generatePdfBtn')
  const originalBtnHTML = btn.innerHTML // restored in finally - textContent below would otherwise lose the button's svg icon
  btn.disabled = true
  btn.textContent = 'Generating…'

  try {
    const logo = await loadImageAsDataUrl('logo.png')
    if (!root) return

    const { jsPDF } = window.jspdf
    const doc = new jsPDF()
    const pageWidth = doc.internal.pageSize.getWidth()
    const pageHeight = doc.internal.pageSize.getHeight()
    const margin = 15
    let y = margin

    // Spacing constants, shared between the actual drawing code below and
    // the per-section height estimates sectionBlock() uses to decide
    // whether a whole section (heading + stats + chart) needs to move to
    // the next page together - keeping these in one place means the
    // estimate can never drift out of sync with what's actually drawn
    const HEADING_H = 8, HEADING_GAP = 3
    const TILE_H = 26, TILE_GAP = 6
    const CHART_H = 62, CHART_GAP = 5
    const EMPTY_LINE_H = 8
    const SECTION_GAP = 3
    const HEADING_TOTAL = HEADING_H + HEADING_GAP
    const TILE_TOTAL = TILE_H + TILE_GAP
    const CHART_TOTAL = CHART_H + CHART_GAP

    function ensureSpace(blockHeight) {
      if (y + blockHeight > pageHeight - margin) {
        doc.addPage()
        y = margin
      }
    }

    // Reserves room for an ENTIRE section (heading + stats + chart) in one
    // go, so a section only ever splits across a page break if it's too
    // tall to fit on any single page - never mid-way, e.g. heading+stats on
    // one page and its chart alone on the next
    function sectionBlock(totalHeight, drawFn) {
      if (totalHeight <= pageHeight - margin * 2) ensureSpace(totalHeight)
      drawFn()
    }

    // Colored banner bar, white bold text - reads as a real report section
    // divider rather than a plain bold line of text
    function heading(text) {
      ensureSpace(HEADING_TOTAL)
      doc.setFillColor(74, 74, 142)
      doc.rect(margin, y, pageWidth - margin * 2, HEADING_H, 'F')
      doc.setFont('helvetica', 'bold')
      doc.setFontSize(12)
      doc.setTextColor(255, 255, 255)
      doc.text(text, margin + 3, y + 5.5)
      doc.setTextColor(0, 0, 0)
      y += HEADING_TOTAL
    }

    // Boxed "stat card" tiles, same visual idea as the app's own .stat-item
    // tiles on the Overview/Metrics tabs - laid out left-aligned at a fixed
    // width so a single tile doesn't stretch awkwardly across the page.
    // The % change is drawn big and bold, since "did this go up or down" is
    // meant to be readable at a glance, not squinted at.
    function statTiles(items) {
      const tileWidth = 50
      const gap = 4
      ensureSpace(TILE_TOTAL)
      items.forEach((item, i) => {
        const x = margin + i * (tileWidth + gap)
        doc.setDrawColor(210, 210, 220)
        doc.setLineWidth(0.3)
        doc.roundedRect(x, y, tileWidth, TILE_H, 2, 2, 'S')

        doc.setFont('helvetica', 'bold')
        doc.setFontSize(12.5)
        doc.setTextColor(30, 30, 50)
        doc.text(String(item.value), x + tileWidth / 2, y + 9, { align: 'center' })

        doc.setFont('helvetica', 'normal')
        doc.setFontSize(7.5)
        doc.setTextColor(120, 120, 130)
        doc.text(item.label, x + tileWidth / 2, y + 14, { align: 'center' })

        if (item.delta) {
          // deltaPositive (when given) overrides the sign-based color guess,
          // since a metric can be "lower is better" - a negative change on
          // those should read green, not red, matching the app's own rule
          let isUp, isDown
          if (item.deltaPositive === true) { isUp = true; isDown = false }
          else if (item.deltaPositive === false) { isUp = false; isDown = true }
          else { isUp = item.delta.startsWith('+'); isDown = item.delta.startsWith('-') }
          doc.setFont('helvetica', 'bold')
          doc.setFontSize(11)
          if (isUp) doc.setTextColor(40, 140, 90)
          else if (isDown) doc.setTextColor(190, 70, 70)
          else doc.setTextColor(120, 120, 130)
          doc.text(item.delta, x + tileWidth / 2, y + 21, { align: 'center' })
          doc.setFont('helvetica', 'normal')
        }
      })
      doc.setTextColor(0, 0, 0)
      y += TILE_TOTAL
    }

    function emptyStateLine(text) {
      ensureSpace(EMPTY_LINE_H)
      doc.setFont('helvetica', 'italic')
      doc.setFontSize(9.5)
      doc.setTextColor(140, 140, 150)
      doc.text(text, margin, y)
      doc.setTextColor(0, 0, 0)
      doc.setFont('helvetica', 'normal')
      y += EMPTY_LINE_H
    }

    // jsPDF's built-in fonts don't support the ▲/▼ characters used
    // elsewhere in the app (they're outside WinAnsi encoding and render as
    // garbled glyphs, e.g. a stray superscript mark next to the %) - a
    // leading +/- sign is fully supported and reads just as clearly
    function deltaText(current, previous) {
      if (previous == null || current == null || previous === 0) return null
      const pct = Math.round(((current - previous) / Math.abs(previous)) * 100)
      if (pct === 0) return null
      return `${pct > 0 ? '+' : ''}${pct}%`
    }

    // ---- Header: logo + athlete name/title on the left, the chosen time
    // period as its own large callout on the right (so which period this
    // report covers is visible at a glance, not buried in small print) ----
    const logoHeight = 22
    let logoWidth = 0
    if (logo) {
      logoWidth = (logo.width / logo.height) * logoHeight
      doc.addImage(logo.dataUrl, 'PNG', margin, y, logoWidth, logoHeight)
    }
    const textX = margin + (logo ? logoWidth + 7 : 0)

    doc.setFont('helvetica', 'bold')
    doc.setFontSize(18)
    doc.setTextColor(30, 30, 50)
    doc.text(currentAthlete ? currentAthlete.name : 'Athlete', textX, y + 8)

    doc.setFont('helvetica', 'bold')
    doc.setFontSize(9.5)
    doc.setTextColor(74, 74, 142)
    doc.text('PHYSICAL ABILITY REPORT', textX, y + 14)

    doc.setFont('helvetica', 'normal')
    doc.setFontSize(8)
    doc.setTextColor(130, 130, 140)
    doc.text(`Generated ${toDateStr(new Date())}`, textX, y + 19.5)

    // Right-aligned period callout - the single biggest piece of text in
    // the header, since "which period is this" is the first thing a coach
    // should be able to tell at a glance
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(20)
    doc.setTextColor(74, 74, 142)
    doc.text(periodLabel, pageWidth - margin, y + 10, { align: 'right' })

    doc.setFont('helvetica', 'normal')
    doc.setFontSize(8.5)
    doc.setTextColor(130, 130, 140)
    doc.text(`${range.from} to ${range.to}`, pageWidth - margin, y + 16, { align: 'right' })

    doc.setTextColor(0, 0, 0)
    y += logoHeight + 6

    doc.setDrawColor(74, 74, 142)
    doc.setLineWidth(0.8)
    doc.line(margin, y, pageWidth - margin, y)
    y += 9

    for (const section of rep.reportDataCache.availableSections) {
      if (!rep.reportSelectedSections.has(section.key)) continue

      if (section.kind === 'overview') {
        const s = computeWorkoutOverviewSection(rep.reportDataCache, range)
        sectionBlock(HEADING_TOTAL + TILE_TOTAL + SECTION_GAP, () => {
          heading('Workout Overview')
          statTiles([
            { label: 'Completion Rate', value: s.completion === null ? '—' : `${s.completion}%`, delta: deltaText(s.completion, s.prevCompletion) },
            { label: 'Total Volume', value: `${s.volumeKg.toLocaleString()}kg`, delta: deltaText(s.volumeKg, s.prevVolumeKg) },
            { label: 'Avg Session Duration', value: s.avgDurationMin === null ? '—' : formatDurationOv(s.avgDurationMin), delta: deltaText(s.avgDurationMin, s.prevAvgDurationMin) }
          ])
          y += SECTION_GAP
        })
      } else if (section.kind === 'plyo') {
        const s = computePlyoSection(rep.reportDataCache, range)
        // A trend line needs at least 2 points IN THIS WINDOW - a short
        // window (e.g. 1 month) legitimately has 0 or 1 some of the time,
        // which isn't a bug, so say so instead of just showing nothing
        const hasChart = s.values.length > 1
        sectionBlock(HEADING_TOTAL + TILE_TOTAL + (hasChart ? CHART_TOTAL : EMPTY_LINE_H) + SECTION_GAP, () => {
          heading('Plyometric Load')
          statTiles([{ label: 'Total Load', value: s.totalInRange.toLocaleString(), delta: deltaText(s.totalInRange, s.totalPrev) }])
          if (hasChart) y = drawTrendChart(doc, s.dates, s.values, 'Plyometric Load Trend', margin, y, pageWidth, CHART_H)
          else emptyStateLine('Not enough data in this period to chart a trend.')
          y += SECTION_GAP
        })
      } else if (section.kind === 'metric') {
        const s = computeCustomMetricSection(section.metric, range)
        if (!s.hasData) {
          sectionBlock(HEADING_TOTAL + EMPTY_LINE_H + SECTION_GAP, () => {
            heading(section.metric.name)
            emptyStateLine('No data logged yet.')
            y += SECTION_GAP
          })
        } else {
          const hasChart = s.chartValues.length > 1
          const pctDelta = s.pct === null ? null : `${s.pct > 0 ? '+' : ''}${s.pct}%`
          const deltaPositive = s.pct === null || s.pct === 0 ? undefined : (section.metric.higher_is_better ? s.pct > 0 : s.pct < 0)
          sectionBlock(HEADING_TOTAL + TILE_TOTAL + (hasChart ? CHART_TOTAL : EMPTY_LINE_H) + SECTION_GAP, () => {
            heading(section.metric.name)
            statTiles([{ label: 'Latest', value: formatMetricValue(section.metric, s.latestValue), delta: pctDelta, deltaPositive }])
            if (hasChart) {
              const title = `${section.metric.name} Trend${s.chartUnit ? ' (' + s.chartUnit + ')' : ''}`
              y = drawTrendChart(doc, s.dates, s.chartValues, title, margin, y, pageWidth, CHART_H)
            } else {
              emptyStateLine('Not enough data in this period to chart a trend.')
            }
            y += SECTION_GAP
          })
        }
      }
    }

    const blobUrl = doc.output('bloburl')
    window.open(blobUrl, '_blank')
    root.querySelector('#reportBuilderModal').classList.remove('active')

    if (root.querySelector('#reportSendToChat').checked) {
      await shareReportWithAthlete(doc, periodLabel)
    }
  } catch (err) {
    console.log('Error generating report PDF:', err)
    customAlert('Something went wrong generating the PDF - please try again')
  } finally {
    if (root) { btn.disabled = false; btn.innerHTML = originalBtnHTML }
  }
}

// Uploads the just-generated PDF to the chat-attachments bucket (same
// {coach_id}/{uuid}.ext convention as the stretch-videos bucket) and drops
// it into this athlete's chat as a message with a pdf_url - shows up next
// time the coach opens communication.html's Communication inbox for this
// athlete (chat lives there now, not on this page). Only runs when the
// "Also send to chat" checkbox in the Report Builder modal was on, chosen
// up front instead of a confirm() popup after the PDF already opened.
async function shareReportWithAthlete(doc, periodLabel) {
  try {
    const blob = doc.output('blob')
    const path = `${coachId()}/${crypto.randomUUID()}.pdf`
    const { error: uploadError } = await supabase.storage.from('chat-attachments').upload(path, blob, { contentType: 'application/pdf' })
    if (uploadError) {
      console.log('Error uploading report:', uploadError)
      customAlert('Something went wrong sharing the report')
      return
    }
    const pdfUrl = supabase.storage.from('chat-attachments').getPublicUrl(path).data.publicUrl

    const { error } = await supabase.from('chat_messages').insert([{
      coach_id: coachId(),
      athlete_id: athleteId,
      sender: 'coach',
      message: `📄 Progress Report (${periodLabel})`,
      pdf_url: pdfUrl
    }])
    if (error) {
      console.log('Error sharing report:', error)
      customAlert('Something went wrong sharing the report')
      return
    }

    if (currentAthlete.user_id) {
      const url = new URL('../athlete-app/dashboard.html', window.location.href).href
      sendPush(supabase, currentAthlete.user_id, 'Tobe-Fit', 'Your coach shared a progress report', url) // not awaited
    }

    if (!root) return
    showToast(`Sent to ${currentAthlete.name}'s chat ✓`)
  } catch (err) {
    console.log('Error sharing report:', err)
    customAlert('Something went wrong sharing the report')
  }
}
