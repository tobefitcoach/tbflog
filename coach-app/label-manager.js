// ==========================================================================
// LABEL MANAGER
// Coach-created tags ("Monthly Plan", "Strength"...) on a screen's cards.
// Athletes and Workouts both have them: a "Filter by Label" dropdown above
// the grid (the grid shows items with ANY of the checked labels, each label
// has a delete ✕), and a per-card "Manage Labels" popup for tagging one
// item. Both read the same state the screen loaded, so this takes small
// getter functions instead of owning any state - the screens reassign
// their label variables on every reload.
//
//   const labels = createLabelManager({ ...see below })
//   labels.renderFilterList()  labels.renderManageList()  labels.addLabel(name, itemId?)
//
// config:
//   getRoot()           the screen's root element (null once it unmounted)
//   noun                'athlete' | 'workout' - wording in messages
//   labelsTable         'athlete_labels' | 'training_labels'
//   linksTable          'athlete_label_links' | 'training_label_links'
//   itemColumn          'athlete_id' | 'training_id' - the links table's item column
//   getLabels()         [{ id, name }]
//   getItems()          the screen's cards' rows (to count labels per item)
//   getLinks()          { itemId: Set(labelId) }
//   getSelected()       Set of label ids ticked in the filter
//   getManageItemId()   the item the Manage Labels popup is open for
//   onFilterChange()    re-apply the grid filters
//   reload()            reload + repaint the screen (after a label is deleted)
//   reloadAfterAdd()    optional - what to reload after adding a label (defaults to reload)
// ==========================================================================
import { supabase } from '../coachClient.js?v=__V__'
import { coachId } from './session.js?v=__V__'
import { escapeHtml } from '../escape.js?v=__V__'
import { customAlert, customConfirm } from '../confirm-modal.js?v=__V__'

export function createLabelManager(config) {
  const { getRoot, noun, labelsTable, linksTable, itemColumn, getLabels, getItems, getLinks, getSelected, getManageItemId, onFilterChange, reload } = config
  const reloadAfterAdd = config.reloadAfterAdd || reload

  function renderFilterList() {
    const root = getRoot()
    const list = root.querySelector('#labelFilterList')
    const labels = getLabels()
    if (labels.length === 0) {
      list.innerHTML = '<p class="label-filter-empty">No labels yet - add one below.</p>'
      return
    }
    list.innerHTML = labels.map(label => {
      const count = getItems().filter(item => getLinks()[item.id]?.has(label.id)).length
      const checked = getSelected().has(label.id) ? 'checked' : ''
      return `
        <div class="label-filter-row">
          <label>
            <input type="checkbox" data-label-id="${label.id}" ${checked}>
            <span>${escapeHtml(label.name)} (${count})</span>
          </label>
          <button type="button" class="label-row-delete" data-label-id="${label.id}" title="Delete label">✕</button>
        </div>
      `
    }).join('')

    list.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      cb.addEventListener('change', function() {
        if (cb.checked) getSelected().add(cb.dataset.labelId)
        else getSelected().delete(cb.dataset.labelId)
        onFilterChange()
      })
    })

    list.querySelectorAll('.label-row-delete').forEach(btn => {
      btn.addEventListener('click', async function() {
        if (!(await customConfirm(`Delete this label? It will be removed from every ${noun}.`))) return
        const { error } = await supabase.from(labelsTable).delete().eq('id', btn.dataset.labelId)
        if (error) {
          console.log('Error deleting label:', error)
          customAlert('Something went wrong deleting that label')
          return
        }
        getSelected().delete(btn.dataset.labelId)
        await reload()
      })
    })
  }

  // Creates a label, optionally linking it straight to one item (used by the
  // Manage Labels popup, so creating a label there tags it onto that item
  // immediately instead of as a separate second step).
  async function addLabel(name, linkToItemId) {
    name = name.trim()
    if (!name) return
    const { data, error } = await supabase.from(labelsTable).insert([{ name, coach_id: coachId() }]).select().single()
    if (error) {
      console.log('Error adding label:', error)
      customAlert('Something went wrong adding that label')
      return
    }
    if (linkToItemId) {
      const { error: linkError } = await supabase.from(linksTable).insert([{ [itemColumn]: linkToItemId, label_id: data.id }])
      // The label itself was created either way - say so if attaching it
      // didn't work, rather than leaving it silently unticked
      if (linkError) {
        console.log('Error attaching label:', linkError)
        customAlert(`The label was created, but attaching it to this ${noun} didn't work - tick it in the list to try again`)
      }
    }
    await reloadAfterAdd()
    if (linkToItemId && getRoot()) renderManageList()
  }

  function renderManageList() {
    const list = getRoot().querySelector('#manageLabelsList')
    const itemLabelIds = getLinks()[getManageItemId()] || new Set()
    const labels = getLabels()

    if (labels.length === 0) {
      list.innerHTML = '<p class="label-filter-empty">No labels yet - add one below.</p>'
      return
    }
    list.innerHTML = labels.map(label => `
      <label class="message-recipient-row">
        <input type="checkbox" data-label-id="${label.id}" ${itemLabelIds.has(label.id) ? 'checked' : ''}>
        <span>${escapeHtml(label.name)}</span>
      </label>
    `).join('')

    list.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      cb.addEventListener('change', function() {
        toggleLabel(getManageItemId(), cb.dataset.labelId, cb.checked)
      })
    })
  }

  async function toggleLabel(itemId, labelId, checked) {
    const { error } = checked
      ? await supabase.from(linksTable).insert([{ [itemColumn]: itemId, label_id: labelId }])
      : await supabase.from(linksTable).delete().eq(itemColumn, itemId).eq('label_id', labelId)

    if (error) {
      console.log(`Error updating ${noun} label:`, error)
      customAlert('Something went wrong')
      return
    }

    (getLinks()[itemId] ||= new Set())[checked ? 'add' : 'delete'](labelId)
    // The insert/delete above is a round trip the coach can navigate away
    // during - the cached Set is still worth updating, the repaint isn't.
    if (!getRoot()) return
    renderFilterList()
    onFilterChange()
  }

  return { renderFilterList, addLabel, renderManageList }
}
