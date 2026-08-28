// ==========================================================================
// STRETCH LIBRARY
// Coach-owned, reusable flat content list (name/body areas/video/hold
// duration) that powers the athlete app's guided Daily Mobility/Stretching
// flow. Same list+modal pattern as exercises.js, minus category/type (not
// applicable here) and with a video FILE UPLOAD to Supabase Storage instead
// of a pasted URL, since these are short self-filmed clips, not YouTube
// links. RLS scopes every query/write to the logged-in coach automatically.
// ==========================================================================
import { supabase } from './coachClient.js'

let currentStretch = null // stretch being edited, or null when adding new
let allStretchesCache = []
let selectedAreas = new Set()
let pendingVideoFile = null
// Search + area-chip filtering, same pattern as exercises.js - no chip
// selected shows everything, one or more narrows it (OR between chips,
// AND with the search box). Chips are built from areas actually in use,
// not the starter suggestion list, so an empty filter is never offered.
let activeAreaFilters = new Set()

const { data: { session } } = await supabase.auth.getSession()
if (!session) {
  window.location.href = 'login.html'
} else {
  loadStretches()
}

// ==========================================================================
// ---- LOAD + RENDER ----
// ==========================================================================
async function loadStretches() {
  const { data, error } = await fetchWithRetry((signal) => supabase
    .from('stretches')
    .select('*')
    .order('name')
    .abortSignal(signal)
  )

  if (error) {
    console.log('Error loading stretches:', error)
    customAlert('Something went wrong loading your stretches - check your connection and try again')
    return
  }

  allStretchesCache = data
  document.getElementById('stretchTotalCount').textContent = `(${data.length})`
  renderAreaFilterChips()
  applyLibraryFilters()
}

// Distinct body_areas values actually assigned to at least one stretch right
// now - shared by the filter chips and the Manage Areas modal below, since
// both only make sense for areas that are actually in use
function getUsedAreas() {
  return [...new Set(allStretchesCache.flatMap(s => s.body_areas || []))].sort()
}

// Rebuilds the chip row from whatever body_areas values are actually
// present right now - same technique renderAreaChips() in the modal uses,
// just scoped to in-use areas only (a filter chip for an area with zero
// stretches would just be a dead end)
function renderAreaFilterChips() {
  const areas = getUsedAreas()
  const row = document.getElementById('stretchAreaFilterChips')
  row.innerHTML = areas.map(a =>
    `<button type="button" class="chip-btn ${activeAreaFilters.has(a) ? 'selected' : ''}" data-area="${a}">${a}</button>`
  ).join('')
}

function applyLibraryFilters() {
  const search = document.getElementById('stretchSearchInput').value.trim().toLowerCase()
  let filtered = search ? allStretchesCache.filter(s => s.name.toLowerCase().includes(search)) : allStretchesCache
  if (activeAreaFilters.size) filtered = filtered.filter(s => (s.body_areas || []).some(a => activeAreaFilters.has(a)))
  renderStretches(filtered)
}

document.getElementById('stretchSearchInput').addEventListener('input', applyLibraryFilters)

document.getElementById('stretchAreaFilterChips').addEventListener('click', function(e) {
  const btn = e.target.closest('.chip-btn')
  if (!btn) return
  const area = btn.dataset.area
  if (activeAreaFilters.has(area)) activeAreaFilters.delete(area)
  else activeAreaFilters.add(area)
  btn.classList.toggle('selected')
  applyLibraryFilters()
})

// ==========================================================================
// ---- MANAGE AREAS ----
// Rename or remove a targeted area across every stretch tagged with it.
// body_areas is a text[] per stretch, not its own table, so there's no
// single row to edit - a rename/delete here is a client-side loop over
// every affected stretch, each getting its own update.
// ==========================================================================
document.getElementById('manageAreasBtn').addEventListener('click', function() {
  renderManageAreasList()
  document.getElementById('manageAreasModal').classList.add('active')
})

document.getElementById('closeManageAreasModalBtn').addEventListener('click', function() {
  document.getElementById('manageAreasModal').classList.remove('active')
})

function renderManageAreasList() {
  const areas = getUsedAreas()
  const container = document.getElementById('manageAreasList')

  if (areas.length === 0) {
    container.innerHTML = '<p class="no-metrics">No areas in use yet - add one while editing a stretch.</p>'
    return
  }

  container.innerHTML = areas.map(a => `
    <div class="manage-area-row" data-area="${a}">
      <input type="text" class="manage-area-input" value="${a}" />
      <button type="button" class="btn-small-create manage-area-save-btn">Save</button>
      <button type="button" class="manage-area-delete-btn">Delete</button>
    </div>
  `).join('')

  container.querySelectorAll('.manage-area-save-btn').forEach(btn => {
    btn.addEventListener('click', function() {
      const row = btn.closest('.manage-area-row')
      const oldArea = row.dataset.area
      const newArea = row.querySelector('.manage-area-input').value.trim()
      if (!newArea || newArea === oldArea) return
      renameArea(oldArea, newArea)
    })
  })

  container.querySelectorAll('.manage-area-delete-btn').forEach(btn => {
    btn.addEventListener('click', async function() {
      const area = btn.closest('.manage-area-row').dataset.area
      const count = allStretchesCache.filter(s => (s.body_areas || []).includes(area)).length
      if (!(await customConfirm(`Remove "${area}" from ${count} stretch${count === 1 ? '' : 'es'}? The stretches themselves won't be deleted.`))) return
      deleteArea(area)
    })
  })
}

// Renames oldArea to newArea on every stretch that carries it. Deduped via
// Set in case a stretch is somehow already tagged with both (e.g. renaming
// "Hip" to an area it's already also tagged "Hips" with) so it doesn't end
// up listed twice on the same stretch.
async function renameArea(oldArea, newArea) {
  const affected = allStretchesCache.filter(s => (s.body_areas || []).includes(oldArea))
  for (const s of affected) {
    const updated = [...new Set(s.body_areas.map(a => a === oldArea ? newArea : a))]
    const { error } = await supabase.from('stretches').update({ body_areas: updated }).eq('id', s.id)
    if (error) { console.log(error); customAlert('Something went wrong renaming that area'); return }
  }
  if (activeAreaFilters.has(oldArea)) { activeAreaFilters.delete(oldArea); activeAreaFilters.add(newArea) }
  await loadStretches()
  renderManageAreasList()
}

async function deleteArea(area) {
  const affected = allStretchesCache.filter(s => (s.body_areas || []).includes(area))
  for (const s of affected) {
    const updated = s.body_areas.filter(a => a !== area)
    const { error } = await supabase.from('stretches').update({ body_areas: updated }).eq('id', s.id)
    if (error) { console.log(error); customAlert('Something went wrong removing that area'); return }
  }
  activeAreaFilters.delete(area)
  await loadStretches()
  renderManageAreasList()
}

function renderStretches(stretches) {
  const container = document.getElementById('stretchList')

  if (stretches.length === 0) {
    container.innerHTML = allStretchesCache.length === 0
      ? '<p class="no-metrics">No stretches yet — add your first one!</p>'
      : '<p class="no-metrics">No stretches match your search/filter</p>'
    return
  }

  container.innerHTML = `
    <div class="exercise-grid">
      ${stretches.map(s => `
        <div class="exercise-item">
          <div class="exercise-item-thumb">
            ${s.video_url ? `<video src="${s.video_url}" preload="metadata" muted playsinline></video>` : '<span class="exercise-item-thumb-placeholder"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="4" r="2"></circle><path d="M12 6v6"></path><path d="M8 8l4 2 4-2"></path><path d="M9 20l3-6 3 6"></path></svg></span>'}
          </div>
          <div class="card-top">
            <h4 class="exercise-item-title" data-id="${s.id}">${s.name}</h4>
            <div class="kebab-menu">
              <button class="kebab-btn" data-id="${s.id}">⋮</button>
              <div class="kebab-dropdown" id="stretch-dropdown-${s.id}">
                <button class="kebab-delete" data-id="${s.id}">Delete stretch</button>
              </div>
            </div>
          </div>
          <p class="exercise-instructions" style="color:#4a4a8e; margin-bottom:4px">${s.default_hold_seconds}s hold${s.is_unilateral ? ' · Two-Sided' : ''}</p>
          ${(s.body_areas || []).length ? `<div class="stretch-item-areas">${s.body_areas.map(a => `<span class="chip-btn chip-btn-readonly">${a}</span>`).join('')}</div>` : ''}
        </div>
      `).join('')}
    </div>
  `

  // Click the title to edit - same convention as exercises.js
  container.querySelectorAll('.exercise-item-title').forEach(title => {
    title.addEventListener('click', function() {
      openStretchModal(stretches.find(s => s.id === title.dataset.id))
    })
  })

  container.querySelectorAll('.exercise-item .kebab-btn').forEach(btn => {
    btn.addEventListener('click', function(e) {
      e.stopPropagation()
      document.getElementById(`stretch-dropdown-${btn.dataset.id}`).classList.toggle('active')
    })
  })

  container.querySelectorAll('.exercise-item .kebab-delete').forEach(btn => {
    btn.addEventListener('click', function(e) {
      e.stopPropagation()
      deleteStretch(btn.dataset.id)
    })
  })
}

// ==========================================================================
// ---- BODY AREA CHIPS ----
// A stretch can carry more than one area (unlike exercises.category), so
// this is a multi-select chip row instead of a dropdown. Starter vocabulary
// plus any custom area a coach has already typed elsewhere in the library,
// same "existing values + escape hatch" idea as exercises.js's category
// dropdown, just rendered as toggle-chips instead of <option>s.
// ==========================================================================
const STARTER_BODY_AREAS = ['Hips', 'Hamstrings', 'Quads', 'Calves', 'Inner Thighs', 'Glutes', 'Lower Back', 'Upper Back', 'Shoulders', 'Neck', 'Chest', 'Full Body']

function getKnownAreas() {
  const custom = [...new Set(allStretchesCache.flatMap(s => s.body_areas || []))].filter(a => !STARTER_BODY_AREAS.includes(a)).sort()
  return [...STARTER_BODY_AREAS, ...custom]
}

function renderAreaChips() {
  const container = document.getElementById('stretchAreaChips')
  container.innerHTML = getKnownAreas().map(a => `<button type="button" class="chip-btn ${selectedAreas.has(a) ? 'selected' : ''}" data-area="${a}">${a}</button>`).join('')

  container.querySelectorAll('.chip-btn').forEach(btn => {
    btn.addEventListener('click', function() {
      if (selectedAreas.has(btn.dataset.area)) selectedAreas.delete(btn.dataset.area)
      else selectedAreas.add(btn.dataset.area)
      renderAreaChips()
    })
  })
}

document.getElementById('stretchAddAreaBtn').addEventListener('click', function() {
  document.getElementById('stretchNewAreaGroup').style.display = 'block'
  document.getElementById('stretchNewArea').focus()
})

document.getElementById('addNewStretchAreaBtn').addEventListener('click', function() {
  const val = document.getElementById('stretchNewArea').value.trim()
  if (!val) return
  selectedAreas.add(val)
  document.getElementById('stretchNewArea').value = ''
  document.getElementById('stretchNewAreaGroup').style.display = 'none'
  renderAreaChips()
})

// ==========================================================================
// ---- VIDEO PREVIEW ----
// The picked File object is held until Save (uploaded then, not on pick) -
// this preview just shows what will be saved, using a local blob URL so no
// network round trip is needed to see it.
// ==========================================================================
function renderVideoPreview(url) {
  document.getElementById('stretchVideoPreview').innerHTML = url
    ? `<video src="${url}" controls muted playsinline style="width:100%; max-width:280px; border-radius:8px; margin-bottom:8px"></video>`
    : ''
}

document.getElementById('stretchVideoFile').addEventListener('change', function() {
  pendingVideoFile = this.files[0] || null
  renderVideoPreview(pendingVideoFile ? URL.createObjectURL(pendingVideoFile) : (currentStretch ? currentStretch.video_url : null))
})

// ==========================================================================
// ---- ADD / EDIT MODAL ----
// ==========================================================================
function openStretchModal(stretch) {
  currentStretch = stretch || null
  pendingVideoFile = null
  selectedAreas = new Set(stretch ? stretch.body_areas : [])

  document.getElementById('stretchModalTitle').textContent = stretch ? 'Edit Stretch' : 'Add Stretch'
  document.getElementById('stretchName').value = stretch ? stretch.name : ''
  document.getElementById('stretchDefaultHold').value = stretch ? stretch.default_hold_seconds : 30
  document.getElementById('stretchIsUnilateral').checked = stretch ? !!stretch.is_unilateral : false
  document.getElementById('stretchVideoFile').value = ''
  document.getElementById('stretchNewAreaGroup').style.display = 'none'
  renderAreaChips()
  renderVideoPreview(stretch ? stretch.video_url : null)

  document.getElementById('stretchModal').classList.add('active')
}

document.getElementById('addStretchBtn').addEventListener('click', function() {
  openStretchModal(null)
})

document.getElementById('closeStretchModalBtn').addEventListener('click', function() {
  document.getElementById('stretchModal').classList.remove('active')
})

document.getElementById('cancelStretchBtn').addEventListener('click', function() {
  document.getElementById('stretchModal').classList.remove('active')
})

document.getElementById('saveStretchBtn').addEventListener('click', async function() {
  const name = document.getElementById('stretchName').value.trim()
  const defaultHoldSeconds = parseInt(document.getElementById('stretchDefaultHold').value) || 30
  const isUnilateral = document.getElementById('stretchIsUnilateral').checked
  const bodyAreas = [...selectedAreas]

  if (!name) { customAlert('Please enter a name'); return }

  const saveBtn = document.getElementById('saveStretchBtn')
  let videoUrl = currentStretch ? currentStretch.video_url : null

  // Single-attempt upload (not wrapped in the retry helper, which is built
  // for chained PostgREST queries, not storage.upload()) - acceptable here
  // since this is a coach at a desk uploading a pre-filmed clip, not the
  // athlete's live flow. A failed upload just means clicking Save again.
  if (pendingVideoFile) {
    saveBtn.disabled = true
    saveBtn.textContent = 'Uploading...'
    const ext = pendingVideoFile.name.split('.').pop()
    const path = `${session.user.id}/${crypto.randomUUID()}.${ext}`
    const { error: uploadError } = await supabase.storage.from('stretch-videos').upload(path, pendingVideoFile, { contentType: pendingVideoFile.type })
    saveBtn.disabled = false
    saveBtn.textContent = 'Save'
    if (uploadError) { console.log(uploadError); customAlert('Video upload failed - check your connection and try again'); return }
    videoUrl = supabase.storage.from('stretch-videos').getPublicUrl(path).data.publicUrl
  }

  let error
  if (currentStretch) {
    ({ error } = await supabase
      .from('stretches')
      .update({ name, body_areas: bodyAreas, video_url: videoUrl, default_hold_seconds: defaultHoldSeconds, is_unilateral: isUnilateral })
      .eq('id', currentStretch.id))
  } else {
    ({ error } = await supabase
      .from('stretches')
      .insert([{ coach_id: session.user.id, name, body_areas: bodyAreas, video_url: videoUrl, default_hold_seconds: defaultHoldSeconds, is_unilateral: isUnilateral }]))
  }

  if (error) { console.log(error); customAlert('Something went wrong'); return }

  document.getElementById('stretchModal').classList.remove('active')
  loadStretches()
})

// ==========================================================================
// ---- DELETE ----
// No FK-violation handling needed (unlike exercises.js's deleteExercise) -
// athlete_stretch_preferences references stretches with ON DELETE CASCADE,
// so nothing can block this.
// ==========================================================================
async function deleteStretch(id) {
  if (!(await customConfirm('Delete this stretch?'))) return

  const { error } = await supabase
    .from('stretches')
    .delete()
    .eq('id', id)

  if (error) { console.log(error); customAlert('Something went wrong'); return }

  loadStretches()
}
