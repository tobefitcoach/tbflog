// ==========================================================================
// CARD MENU
// The behaviour every card-grid screen (Athletes, Forms, Sections, Programs,
// Workouts) shares: click the card to open it, the ⋮ button toggles the
// card's dropdown, and each dropdown item runs its own action. The markup
// stays in each screen (the items differ); this only wires it up.
//
//   wireCardMenu(card, {
//     open: () => go('form-builder', { id }),
//     actions: { '.kebab-delete': async (e) => {...}, '.kebab-duplicate': ... }
//   })
//
// Items an action selector doesn't find (e.g. "Resend Invite" only exists on
// pending cards) are skipped. Every action click stops propagating, so it
// can't also open the card or reach the outside-click closer below.
//
//   closeMenusOnOutsideClick(ctx, () => root, '#formGrid')
//
// One document-level listener per screen mount (through ctx.on, so the
// router removes it when the screen goes away) closing any open dropdown
// inside the given scope.
// ==========================================================================
export function wireCardMenu(card, { open, actions = {} }) {
  card.addEventListener('click', function(e) {
    if (e.target.closest('.kebab-menu')) return
    open()
  })

  card.querySelector('.kebab-btn').addEventListener('click', function(e) {
    e.stopPropagation()
    card.querySelector('.kebab-dropdown').classList.toggle('active')
  })

  for (const [selector, action] of Object.entries(actions)) {
    card.querySelector(selector)?.addEventListener('click', function(e) {
      e.stopPropagation()
      return action(e)
    })
  }
}

export function closeMenusOnOutsideClick(ctx, getRoot, scope) {
  ctx.on(document, 'click', function() {
    getRoot()?.querySelectorAll(`${scope} .kebab-dropdown.active`).forEach(d => d.classList.remove('active'))
  })
}
