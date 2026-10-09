// ==========================================================================
// NAMED LIBRARY SCREEN
// Forms and Sections are the same screen: a grid of cards, each showing a
// name and how many items it holds, a "+ New" popup that asks only for a
// name and then opens the builder for it, and a ⋮ menu with Delete. This
// builds that screen from a description; screens/forms.js and
// screens/sections.js are just the descriptions.
//
// The screen contract is screen-context.js's: the document-level click
// listener goes through ctx.on (the router removes it when the screen goes
// away) and every await is followed by a ctx.alive() check before the DOM
// is touched again.
//
// config:
//   singular      'Form'            button "+ New Form", popup "New Form", element ids
//   plural        'forms'           empty/error text and log lines
//   title         'Forms'           heading
//   subtitle      text under the heading
//   table         'forms'           the Supabase table
//   childTable    'form_questions'  embedded rows, counted on each card
//   childNoun     'question'        "3 questions"
//   builderRoute  'form-builder'    where a card / a new row opens
//   placeholder   name field hint
//   icon          the card's svg path markup
//   badge(row)    optional extra html under the count (e.g. a Forms badge)
// ==========================================================================
import { supabase } from '../coachClient.js?v=__V__'
import { go } from './router.js?v=__V__'
import { coachId } from './session.js?v=__V__'
import { showLoadError } from './screen-context.js?v=__V__'
import { escapeHtml } from '../escape.js?v=__V__'
import { customAlert, customConfirm } from '../confirm-modal.js?v=__V__'
import { wireCardMenu, closeMenusOnOutsideClick } from './card-menu.js?v=__V__'

export function createNameLibrary(config) {
  const { singular, plural, title, subtitle, table, childTable, childNoun, builderRoute, placeholder, icon, badge } = config
  const one = singular.toLowerCase()
  const gridId = `${one}Grid`

  // The "+ New" popup asks for just a name - the rest gets built on the
  // builder screen this routes to afterwards. It lives inside the screen
  // rather than the shell, so it is torn down with the screen.
  const TEMPLATE = `
    <div class="dashboard-header">
      <h2>${title}</h2>
      <button class="btn-add" id="new${singular}Btn">+ New ${singular}</button>
    </div>
    <p class="screen-subtitle">${subtitle}</p>
    <div class="athlete-grid" id="${gridId}"></div>

    <div class="modal-overlay" id="new${singular}Modal">
      <div class="modal">
        <h2>New ${singular}</h2>
        <div class="form-group">
          <label>Name</label>
          <input type="text" id="new${singular}Name" placeholder="${placeholder}" />
        </div>
        <div class="form-actions">
          <button class="btn-cancel" id="cancelNew${singular}Btn" data-modal-dismiss>Cancel</button>
          <button class="btn-save" id="saveNew${singular}Btn">Create &amp; Edit</button>
        </div>
      </div>
    </div>
  `

  const SKELETON = `
    <div class="dashboard-header">
      <h2>${title}</h2>
    </div>
    <div class="athlete-grid">
      ${'<div class="skeleton-bar" style="height:132px"></div>'.repeat(4)}
    </div>
  `

  let root = null
  let rows = []

  async function mount(container, params, ctx) {
    root = container
    container.innerHTML = SKELETON

    const { data, error } = await ctx.fetch((signal) => supabase
      .from(table)
      .select(`*, ${childTable}(id)`)
      .order('name')
      .abortSignal(signal)
    )
    if (!ctx.alive()) return

    if (error) {
      console.log(`Error loading ${plural}:`, error)
      showLoadError(container, plural)
      return
    }

    rows = data || []
    container.innerHTML = TEMPLATE
    bindEvents(ctx)
    renderGrid()
  }

  function unmount() {
    root = null
    rows = []
  }

  function bindEvents(ctx) {
    closeMenusOnOutsideClick(ctx, () => root, `#${gridId}`)

    root.querySelector(`#new${singular}Btn`).addEventListener('click', function() {
      root.querySelector(`#new${singular}Name`).value = ''
      root.querySelector(`#new${singular}Modal`).classList.add('active')
    })

    root.querySelector(`#cancelNew${singular}Btn`).addEventListener('click', function() {
      root.querySelector(`#new${singular}Modal`).classList.remove('active')
    })

    root.querySelector(`#saveNew${singular}Btn`).addEventListener('click', async function() {
      const name = root.querySelector(`#new${singular}Name`).value.trim()
      if (!name) { customAlert('Please enter a name'); return }

      const { data, error } = await supabase
        .from(table)
        .insert([{ coach_id: coachId(), name }])
        .select()

      if (error) {
        console.log(`Error creating ${one}:`, error)
        customAlert('Something went wrong')
        return
      }

      go(builderRoute, { id: data[0].id })
    })
  }

  function renderGrid() {
    const grid = root.querySelector(`#${gridId}`)
    grid.innerHTML = ''

    if (rows.length === 0) {
      grid.innerHTML = `<p>No ${plural} yet — create your first one!</p>`
      return
    }

    rows.forEach(row => grid.appendChild(createCard(row)))
  }

  function createCard(row) {
    const count = row[childTable].length

    const card = document.createElement('div')
    card.classList.add('athlete-card')
    card.innerHTML = `
      <div class="card-top">
        <div class="athlete-initials"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${icon}</svg></div>
        <div class="kebab-menu">
          <button class="kebab-btn" data-id="${row.id}">⋮</button>
          <div class="kebab-dropdown" id="dropdown-${row.id}">
            <button class="kebab-delete" data-id="${row.id}">Delete ${one}</button>
          </div>
        </div>
      </div>
      <h3>${escapeHtml(row.name)}</h3>
      <p>${count} ${childNoun}${count === 1 ? '' : 's'}</p>
      ${badge ? badge(row) : ''}
    `

    wireCardMenu(card, {
      open: () => go(builderRoute, { id: row.id }),
      actions: {
        '.kebab-delete': async function() {
          if (!(await customConfirm(`Delete "${row.name}"? This cannot be undone.`))) return

          const { error } = await supabase.from(table).delete().eq('id', row.id)
          if (error) {
            console.log(`Error deleting ${one}:`, error)
            customAlert('Something went wrong')
            return
          }

          // Drop it locally and repaint rather than re-querying - the row is
          // gone, and a round trip here would show a stale grid for as long
          // as it takes to come back.
          rows = rows.filter(r => r.id !== row.id)
          renderGrid()
        }
      }
    })

    return card
  }

  return { mount, unmount }
}
