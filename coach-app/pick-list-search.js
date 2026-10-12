// ==========================================================================
// PICK-LIST SEARCH
// A search box above a popup's list of pick rows (Add Workout / Program /
// Section / Form, in the calendar's "+" popup and in the Workout Builder's
// day mode). Filters the rows already on screen by name - every word typed
// has to appear in the name, any case - so it works the same for any list
// made of .training-pick-row elements, and no list had to change how it
// loads.
//
//   addPickListSearch(listEl, 'Search workouts...')
//
// Call once when the screen is built. Each time the list is re-filled (the
// popup reloads its rows every time it opens) the box clears itself, so the
// next opening starts unfiltered.
// ==========================================================================
export function addPickListSearch(listEl, placeholder) {
  const input = document.createElement('input')
  input.type = 'text'
  input.className = 'exercise-search-input'
  input.placeholder = placeholder
  input.setAttribute('aria-label', placeholder)
  input.autocomplete = 'off'
  listEl.insertAdjacentElement('beforebegin', input)

  const none = document.createElement('p')
  none.className = 'no-metrics'
  none.textContent = 'No matches'
  none.style.display = 'none'
  listEl.insertAdjacentElement('afterend', none)

  function apply() {
    const words = input.value.trim().toLowerCase().split(/\s+/).filter(Boolean)
    const rows = listEl.querySelectorAll('.training-pick-row')
    let shown = 0
    rows.forEach(function(row) {
      const name = (row.dataset.name || row.textContent).toLowerCase()
      const hit = words.every(w => name.includes(w))
      row.style.display = hit ? '' : 'none'
      if (hit) shown++
    })
    none.style.display = rows.length > 0 && shown === 0 ? '' : 'none'
  }

  input.addEventListener('input', apply)

  // The rows were replaced: forget the old search
  new MutationObserver(function() {
    if (input.value !== '') input.value = ''
    none.style.display = 'none'
  }).observe(listEl, { childList: true })
}
