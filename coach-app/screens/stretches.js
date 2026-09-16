// ==========================================================================
// STRETCH LIBRARY — screen
// Converted from the repo-root stretches.js + the .dashboard block of
// stretches.html. Coach-owned flat content list (name / body areas / video
// / hold duration) powering the athlete app's guided Daily Mobility flow.
// Same list+modal pattern as the Exercise Library, but with a video FILE
// UPLOAD to Supabase Storage instead of a pasted URL, since these are short
// self-filmed clips rather than YouTube links.
//
// One thing tightened during conversion: the video preview creates a blob
// URL via URL.createObjectURL, which the original never revoked. On the
// multi-page site the document was torn down on every navigation so it
// didn't matter; here the blob would be pinned in memory for the life of
// the app. Every blob URL this screen creates is now tracked and revoked -
// on the next pick, and on unmount.
// ==========================================================================
import { supabase } from '../../coachClient.js'
import * as nav from '../nav.js'
import { coachId } from '../session.js'

const TEMPLATE = `
  <div class="dashboard-header">
    <h2>Stretch Library <span class="count-badge" id="stretchTotalCount"></span></h2>
    <button class="btn-add" id="addStretchBtn">+ Add Stretch</button>
  </div>
  <p class="screen-subtitle">Videos here power the athlete app's guided Daily Mobility/Stretching flow — short looping clips work best.</p>
  <input type="text" id="stretchSearchInput" class="exercise-search-input" placeholder="Search stretches..." style="margin-bottom:10px" />
  <div class="filter-chips-row">
    <div class="chip-row" id="stretchAreaFilterChips"></div>
    <button type="button" class="btn-small-create" id="manageAreasBtn" style="flex-shrink:0">Manage Areas</button>
  </div>
  <div id="stretchList"></div>

  <div class="modal-overlay" id="stretchModal">
    <div class="modal">
      <div class="graph-modal-header">
        <h2 id="stretchModalTitle">Add Stretch</h2>
        <button class="btn-cancel" id="closeStretchModalBtn" data-modal-dismiss>✕</button>
      </div>
      <div class="form-group">
        <label>Name</label>
        <input type="text" id="stretchName" placeholder="e.g. Couch Stretch" />
      </div>
      <div class="form-group">
        <label>Body Area(s)</label>
        <div class="chip-row" id="stretchAreaChips"></div>
        <div id="stretchNewAreaGroup" style="display:none; margin-top:8px">
          <input type="text" id="stretchNewArea" placeholder="e.g. Ankles" />
          <button type="button" class="btn-small-create" id="addNewStretchAreaBtn" style="margin-top:8px">+ Add</button>
        </div>
        <button type="button" class="chip-btn chip-btn-clear" id="stretchAddAreaBtn" style="margin-top:8px">+ Add New Area</button>
      </div>
      <div class="form-group">
        <label>Hold Duration (seconds)</label>
        <input type="number" id="stretchDefaultHold" min="1" placeholder="e.g. 30" />
      </div>
      <div class="form-group">
        <label class="bodyweight-toggle"><span>Two-Sided</span>
          <span class="toggle-switch"><input type="checkbox" id="stretchIsUnilateral"><span class="toggle-slider"></span></span>
        </label>
        <p class="form-group-hint" style="margin-top:4px">Film just one side - in the athlete app this plays twice in a row (once per side), each getting the full hold duration.</p>
      </div>
      <div class="form-group">
        <label>Video</label>
        <div id="stretchVideoPreview"></div>
        <input type="file" id="stretchVideoFile" accept="video/*" />
        <p class="form-group-hint" style="margin-top:4px">A short clip (5-15s) is enough - it loops automatically to cover the hold duration.</p>
      </div>
      <div class="form-actions">
        <button class="btn-cancel" id="cancelStretchBtn">Cancel</button>
        <button class="btn-save" id="saveStretchBtn">Save</button>
      </div>
    </div>
  </div>

  <!-- Manage Areas: create, rename, or remove a targeted area. body_areas
       is a text[] per stretch, not its own table, so renaming/removing
       loops over every stretch tagged with it; creating writes to
       stretch_body_areas, the coach's own persisted area list, so a new
       area exists right away even before any stretch uses it. -->
  <div class="modal-overlay" id="manageAreasModal">
    <div class="modal">
      <div class="graph-modal-header">
        <h2>Manage Targeted Areas</h2>
        <button class="btn-cancel" id="closeManageAreasModalBtn" data-modal-dismiss>✕</button>
      </div>
      <p class="modal-subtitle">Rename or remove an area across every stretch tagged with it, or add a new one.</p>
      <div class="manage-area-row">
        <input type="text" id="manageAreaNewInput" placeholder="e.g. Ankles" />
        <button type="button" class="btn-small-create" id="manageAreaAddBtn">+ Add</button>
      </div>
      <div id="manageAreasList"></div>
    </div>
  </div>
`

const SKELETON = `
  <div class="dashboard-header"><h2>Stretch Library</h2></div>
  <div class="skeleton-bar" style="height:38px; margin-bottom:16px"></div>
  ${'<div class="skeleton-bar" style="height:96px; margin-bottom:12px"></div>'.repeat(4)}
`

let root = null
let currentStretch = null
let allStretchesCache = []
let allAreasCache = []       // names from stretch_body_areas - the coach's persisted list, independent of whether any stretch uses them yet
let selectedAreas = new Set()
let activeAreaFilters = new Set()
let pendingVideoFile = null
let previewBlobUrl = null    // tracked so it can be revoked - see header note

export async function mount(container, params, token) {
  root = container
  container.innerHTML = SKELETON
  if (!(await loadStretches(token))) return

  container.innerHTML = TEMPLATE
  bindEvents()
  paint()
}

export function unmount() {
  releasePreviewBlob()
  root = null
  currentStretch = null
  allStretchesCache = []
  allAreasCache = []
  selectedAreas = new Set()
  activeAreaFilters = new Set()
  pendingVideoFile = null
}

function releasePreviewBlob() {
  if (previewBlobUrl) URL.revokeObjectURL(previewBlobUrl)
  previewBlobUrl = null
}

async function loadStretches(token) {
  const [
    { data: stretchesData, error: stretchesError },
    { data: areasData, error: areasError }
  ] = await Promise.all([
    window.fetchWithRetry((signal) => supabase.from('stretches').select('*').order('name').abortSignal(signal)),
    window.fetchWithRetry((signal) => supabase.from('stretch_body_areas').select('name').order('name').abortSignal(signal))
  ])
  if (token !== undefined && !nav.isCurrent(token)) return false

  if (stretchesError || areasError) {
    console.log('Error loading stretches:', stretchesError || areasError)
    if (root) root.innerHTML = `
      <div class="screen-message">
        <h2>Couldn't load your stretches</h2>
        <p>Check your connection and try again.</p>
      </div>`
    return false
  }

  allStretchesCache = stretchesData || []
  allAreasCache = (areasData || []).map(a => a.name)
  return true
}

async function reloadAndRepaint() {
  if (!(await loadStretches())) return
  if (!root) return
  paint()
}

function paint() {
  root.querySelector('#stretchTotalCount').textContent = `(${allStretchesCache.length})`
  renderAreaFilterChips()
  applyLibraryFilters()
}

function bindEvents() {
  root.querySelector('#stretchSearchInput').addEventListener('input', applyLibraryFilters)

  root.querySelector('#stretchAreaFilterChips').addEventListener('click', function(e) {
    const btn = e.target.closest('.chip-btn')
    if (!btn) return
    const area = btn.dataset.area
    if (activeAreaFilters.has(area)) activeAreaFilters.delete(area)
    else activeAreaFilters.add(area)
    btn.classList.toggle('selected')
    applyLibraryFilters()
  })

  root.querySelector('#manageAreasBtn').addEventListener('click', function() {
    root.querySelector('#manageAreaNewInput').value = ''
    renderManageAreasList()
    root.querySelector('#manageAreasModal').classList.add('active')
  })

  root.querySelector('#closeManageAreasModalBtn').addEventListener('click', function() {
    root.querySelector('#manageAreasModal').classList.remove('active')
  })

  root.querySelector('#manageAreaAddBtn').addEventListener('click', onAddArea)

  root.querySelector('#stretchAddAreaBtn').addEventListener('click', function() {
    root.querySelector('#stretchNewAreaGroup').style.display = 'block'
    root.querySelector('#stretchNewArea').focus()
  })

  root.querySelector('#addNewStretchAreaBtn').addEventListener('click', onAddAreaFromModal)

  root.querySelector('#stretchVideoFile').addEventListener('change', function() {
    releasePreviewBlob()
    pendingVideoFile = this.files[0] || null
    if (pendingVideoFile) {
      previewBlobUrl = URL.createObjectURL(pendingVideoFile)
      renderVideoPreview(previewBlobUrl)
    } else {
      renderVideoPreview(currentStretch ? currentStretch.video_url : null)
    }
  })

  root.querySelector('#addStretchBtn').addEventListener('click', function() {
    openStretchModal(null)
  })

  root.querySelector('#closeStretchModalBtn').addEventListener('click', closeStretchModal)
  root.querySelector('#cancelStretchBtn').addEventListener('click', closeStretchModal)
  root.querySelector('#saveStretchBtn').addEventListener('click', onSaveStretch)
}

function closeStretchModal() {
  root.querySelector('#stretchModal').classList.remove('active')
}

// Distinct body_areas actually assigned to at least one stretch - powers
// the filter chips, which only make sense for areas in use (unlike
// getKnownAreas, used by the modal picker and Manage Areas, which also
// includes areas that exist but aren't used yet).
function getUsedAreas() {
  return [...new Set(allStretchesCache.flatMap(s => s.body_areas || []))].sort()
}

function getKnownAreas() {
  const fromStretches = allStretchesCache.flatMap(s => s.body_areas || [])
  return [...new Set([...allAreasCache, ...fromStretches])].sort()
}

function renderAreaFilterChips() {
  root.querySelector('#stretchAreaFilterChips').innerHTML = getUsedAreas().map(a =>
    `<button type="button" class="chip-btn ${activeAreaFilters.has(a) ? 'selected' : ''}" data-area="${a}">${a}</button>`
  ).join('')
}

function applyLibraryFilters() {
  const search = root.querySelector('#stretchSearchInput').value.trim().toLowerCase()
  let filtered = search ? allStretchesCache.filter(s => s.name.toLowerCase().includes(search)) : allStretchesCache
  if (activeAreaFilters.size) filtered = filtered.filter(s => (s.body_areas || []).some(a => activeAreaFilters.has(a)))
  renderStretches(filtered)
}

function renderStretches(stretches) {
  const container = root.querySelector('#stretchList')

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
          <p class="exercise-instructions exercise-type-line">${s.default_hold_seconds}s hold${s.is_unilateral ? ' · Two-Sided' : ''}</p>
          ${(s.body_areas || []).length ? `<div class="stretch-item-areas">${s.body_areas.map(a => `<span class="chip-btn chip-btn-readonly">${a}</span>`).join('')}</div>` : ''}
        </div>
      `).join('')}
    </div>
  `

  container.querySelectorAll('.exercise-item-title').forEach(title => {
    title.addEventListener('click', function() {
      openStretchModal(stretches.find(s => s.id === title.dataset.id))
    })
  })

  container.querySelectorAll('.exercise-item .kebab-btn').forEach(btn => {
    btn.addEventListener('click', function(e) {
      e.stopPropagation()
      container.querySelector(`#stretch-dropdown-${btn.dataset.id}`).classList.toggle('active')
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
// BODY AREA CHIPS
// A stretch can carry more than one area, so this is a multi-select chip
// row rather than a dropdown - every area the coach has ever created plus
// any value in actual use.
// ==========================================================================
function renderAreaChips() {
  const container = root.querySelector('#stretchAreaChips')
  container.innerHTML = getKnownAreas().map(a =>
    `<button type="button" class="chip-btn ${selectedAreas.has(a) ? 'selected' : ''}" data-area="${a}">${a}</button>`
  ).join('')

  container.querySelectorAll('.chip-btn').forEach(btn => {
    btn.addEventListener('click', function() {
      if (selectedAreas.has(btn.dataset.area)) selectedAreas.delete(btn.dataset.area)
      else selectedAreas.add(btn.dataset.area)
      renderAreaChips()
    })
  })
}

async function onAddAreaFromModal() {
  const input = root.querySelector('#stretchNewArea')
  const val = input.value.trim()
  if (!val) return
  selectedAreas.add(val)
  input.value = ''
  root.querySelector('#stretchNewAreaGroup').style.display = 'none'
  renderAreaChips()

  if (!allAreasCache.includes(val)) {
    const { error } = await supabase.from('stretch_body_areas').insert([{ coach_id: coachId(), name: val }])
    // Cached locally so it's suggested right away, even if this stretch
    // never actually gets saved.
    if (!error) allAreasCache.push(val)
  }
}

// ==========================================================================
// MANAGE AREAS
// ==========================================================================
async function onAddArea() {
  const input = root.querySelector('#manageAreaNewInput')
  const name = input.value.trim()
  if (!name) return
  if (allAreasCache.includes(name)) { input.value = ''; return } // already exists - nothing to do

  const { error } = await supabase.from('stretch_body_areas').insert([{ coach_id: coachId(), name }])
  if (error) { console.log(error); customAlert('Something went wrong adding that area'); return }

  input.value = ''
  await reloadAndRepaint()
  if (root) renderManageAreasList()
}

function renderManageAreasList() {
  const areas = getKnownAreas()
  const container = root.querySelector('#manageAreasList')

  if (areas.length === 0) {
    container.innerHTML = '<p class="no-metrics">No areas yet - add one above.</p>'
    return
  }

  container.innerHTML = areas.map(a => {
    const count = allStretchesCache.filter(s => (s.body_areas || []).includes(a)).length
    return `
      <div class="manage-area-row" data-area="${a}">
        <input type="text" class="manage-area-input" value="${a}" />
        <span class="manage-area-count">${count ? `${count} stretch${count === 1 ? '' : 'es'}` : 'unused'}</span>
        <button type="button" class="btn-small-create manage-area-save-btn">Save</button>
        <button type="button" class="manage-area-delete-btn">Delete</button>
      </div>
    `
  }).join('')

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
      const warning = count ? ` Removes it from ${count} stretch${count === 1 ? '' : 'es'} (the stretches themselves won't be deleted).` : ''
      if (!(await customConfirm(`Delete "${area}"?${warning}`))) return
      deleteArea(area)
    })
  })
}

// Renames oldArea to newArea everywhere: on every stretch carrying it
// (deduped via Set in case a stretch is somehow tagged with both) and on
// its stretch_body_areas row.
async function renameArea(oldArea, newArea) {
  const affected = allStretchesCache.filter(s => (s.body_areas || []).includes(oldArea))
  for (const s of affected) {
    const updated = [...new Set(s.body_areas.map(a => a === oldArea ? newArea : a))]
    const { error } = await supabase.from('stretches').update({ body_areas: updated }).eq('id', s.id)
    if (error) { console.log(error); customAlert('Something went wrong renaming that area'); return }
  }
  const { error } = await supabase.from('stretch_body_areas').update({ name: newArea }).eq('name', oldArea)
  if (error) {
    // 23505 = unique violation - newArea already has its own row (this
    // rename is really a merge), so drop the now-redundant old one rather
    // than treating it as a failure.
    if (error.code === '23505') await supabase.from('stretch_body_areas').delete().eq('name', oldArea)
    else { console.log(error); customAlert('Something went wrong renaming that area'); return }
  }
  if (activeAreaFilters.has(oldArea)) { activeAreaFilters.delete(oldArea); activeAreaFilters.add(newArea) }
  await reloadAndRepaint()
  if (root) renderManageAreasList()
}

async function deleteArea(area) {
  const affected = allStretchesCache.filter(s => (s.body_areas || []).includes(area))
  for (const s of affected) {
    const updated = s.body_areas.filter(a => a !== area)
    const { error } = await supabase.from('stretches').update({ body_areas: updated }).eq('id', s.id)
    if (error) { console.log(error); customAlert('Something went wrong removing that area'); return }
  }
  const { error } = await supabase.from('stretch_body_areas').delete().eq('name', area)
  if (error) { console.log(error); customAlert('Something went wrong removing that area'); return }
  activeAreaFilters.delete(area)
  await reloadAndRepaint()
  if (root) renderManageAreasList()
}

// ==========================================================================
// ADD / EDIT
// The picked File is held until Save (uploaded then, not on pick) - the
// preview just shows what will be saved, from a local blob URL so no
// network round trip is needed to see it.
// ==========================================================================
function renderVideoPreview(url) {
  root.querySelector('#stretchVideoPreview').innerHTML = url
    ? `<video src="${url}" controls muted playsinline class="stretch-video-preview"></video>`
    : ''
}

function openStretchModal(stretch) {
  releasePreviewBlob()
  currentStretch = stretch || null
  pendingVideoFile = null
  selectedAreas = new Set(stretch ? stretch.body_areas : [])

  root.querySelector('#stretchModalTitle').textContent = stretch ? 'Edit Stretch' : 'Add Stretch'
  root.querySelector('#stretchName').value = stretch ? stretch.name : ''
  root.querySelector('#stretchDefaultHold').value = stretch ? stretch.default_hold_seconds : 30
  root.querySelector('#stretchIsUnilateral').checked = stretch ? !!stretch.is_unilateral : false
  root.querySelector('#stretchVideoFile').value = ''
  root.querySelector('#stretchNewAreaGroup').style.display = 'none'
  renderAreaChips()
  renderVideoPreview(stretch ? stretch.video_url : null)

  root.querySelector('#stretchModal').classList.add('active')
}

async function onSaveStretch() {
  const name = root.querySelector('#stretchName').value.trim()
  const defaultHoldSeconds = parseInt(root.querySelector('#stretchDefaultHold').value) || 30
  const isUnilateral = root.querySelector('#stretchIsUnilateral').checked
  const bodyAreas = [...selectedAreas]

  if (!name) { customAlert('Please enter a name'); return }

  const saveBtn = root.querySelector('#saveStretchBtn')
  let videoUrl = currentStretch ? currentStretch.video_url : null

  // Single-attempt upload (not wrapped in the retry helper, which is built
  // for chained PostgREST queries, not storage.upload()) - acceptable here
  // since this is a coach at a desk uploading a pre-filmed clip, not the
  // athlete's live flow. A failed upload just means clicking Save again.
  if (pendingVideoFile) {
    saveBtn.disabled = true
    saveBtn.textContent = 'Uploading...'
    const ext = pendingVideoFile.name.split('.').pop()
    const path = `${coachId()}/${crypto.randomUUID()}.${ext}`
    const { error: uploadError } = await supabase.storage.from('stretch-videos').upload(path, pendingVideoFile, { contentType: pendingVideoFile.type })
    saveBtn.disabled = false
    saveBtn.textContent = 'Save'
    if (uploadError) { console.log(uploadError); customAlert('Video upload failed - check your connection and try again'); return }
    videoUrl = supabase.storage.from('stretch-videos').getPublicUrl(path).data.publicUrl
  }

  const fields = { name, body_areas: bodyAreas, video_url: videoUrl, default_hold_seconds: defaultHoldSeconds, is_unilateral: isUnilateral }

  const { error } = currentStretch
    ? await supabase.from('stretches').update(fields).eq('id', currentStretch.id)
    : await supabase.from('stretches').insert([{ coach_id: coachId(), ...fields }])

  if (error) { console.log(error); customAlert('Something went wrong'); return }

  closeStretchModal()
  releasePreviewBlob()
  await reloadAndRepaint()
}

// No FK-violation handling needed (unlike the Exercise Library's delete) -
// athlete_stretch_preferences references stretches with ON DELETE CASCADE,
// so nothing can block this.
async function deleteStretch(id) {
  if (!(await customConfirm('Delete this stretch?'))) return

  const { error } = await supabase.from('stretches').delete().eq('id', id)
  if (error) { console.log(error); customAlert('Something went wrong'); return }

  await reloadAndRepaint()
}
