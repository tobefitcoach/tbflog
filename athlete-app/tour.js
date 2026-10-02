// ==========================================================================
// tour.js - spotlight walkthrough for the athlete app.
//
// runTour(steps) dims the screen, cuts a highlighted hole around one real
// element at a time and shows a small bubble next to it with Back / Next /
// Skip. Used for the first-time Home tour and the one-time "check off your
// set" hint in a workout (see home-tour.js).
//
// A step is { target: () => Element|null, title, body }. A step with no
// target function is shown as a centred bubble (welcome). A step whose
// target returns nothing, or a .disabled element (feature switched off
// for this athlete, element not rendered), is skipped, so callers can list
// every possible step and let the page decide which apply.
//
// Resolves with 'done' or 'skipped' once the bubble is closed.
// ==========================================================================

const PAD = 6 // breathing room between the element and the hole's edge
const GAP = 12 // distance between the hole and the bubble
const GUTTER = 16 // bubble never closer than this to the screen edge

export function runTour(steps, { doneLabel = 'Done' } = {}) {
  const live = steps.filter(s => !s.target || isVisible(s.target()))
  if (live.length === 0) return Promise.resolve('done')

  return new Promise(resolve => {
    const layer = document.createElement('div')
    layer.className = 'tour-layer'
    layer.innerHTML = `
      <div class="tour-hole"></div>
      <div class="tour-bubble" role="dialog" aria-live="polite">
        <div class="tour-bubble-top">
          <span class="tour-count"></span>
          <button type="button" class="tour-skip">Skip</button>
        </div>
        <h3 class="tour-title"></h3>
        <p class="tour-body"></p>
        <div class="tour-actions">
          <button type="button" class="icon-btn tour-back" aria-label="Back">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"></polyline></svg>
          </button>
          <button type="button" class="btn-save tour-next"></button>
        </div>
      </div>
    `
    document.body.appendChild(layer)

    const hole = layer.querySelector('.tour-hole')
    const bubble = layer.querySelector('.tour-bubble')
    const backBtn = layer.querySelector('.tour-back')
    const nextBtn = layer.querySelector('.tour-next')
    const single = live.length === 1
    let index = 0

    function render() {
      const step = live[index]
      const isLast = index === live.length - 1
      layer.querySelector('.tour-count').textContent = single ? '' : `${index + 1} of ${live.length}`
      layer.querySelector('.tour-skip').style.display = isLast ? 'none' : ''
      layer.querySelector('.tour-title').textContent = step.title || ''
      layer.querySelector('.tour-title').style.display = step.title ? '' : 'none'
      layer.querySelector('.tour-body').textContent = step.body
      backBtn.style.visibility = index === 0 ? 'hidden' : ''
      nextBtn.textContent = isLast ? doneLabel : 'Next'
      place()
      nextBtn.focus({ preventScroll: true })
    }

    function place() {
      const step = live[index]
      const el = step.target ? step.target() : null
      const vw = window.innerWidth
      const vh = window.innerHeight

      if (!el) {
        // Centred bubble, no hole: a zero-size hole in the middle still
        // casts the full-screen dim through its box-shadow
        layer.classList.add('tour-centred')
        Object.assign(hole.style, { top: `${vh / 2}px`, left: `${vw / 2}px`, width: '0px', height: '0px' })
        bubble.style.left = `${Math.max(GUTTER, (vw - bubble.offsetWidth) / 2)}px`
        bubble.style.top = `${Math.max(GUTTER, (vh - bubble.offsetHeight) / 2)}px`
        return
      }

      layer.classList.remove('tour-centred')
      const r = el.getBoundingClientRect()
      const box = { top: r.top - PAD, left: r.left - PAD, width: r.width + PAD * 2, height: r.height + PAD * 2 }
      Object.assign(hole.style, { top: `${box.top}px`, left: `${box.left}px`, width: `${box.width}px`, height: `${box.height}px` })

      // Below the element if it fits, otherwise above. A target too tall for
      // either (the week strip) gets the bubble over its roomier end.
      // Horizontally centred on the element, clamped inside the screen.
      const bw = bubble.offsetWidth
      const bh = bubble.offsetHeight
      const below = box.top + box.height + GAP
      const above = box.top - GAP - bh
      let top
      if (below + bh <= vh - GUTTER) top = below
      else if (above >= GUTTER) top = above
      else top = vh - (box.top + box.height) > box.top ? vh - GUTTER - bh : GUTTER
      const left = Math.min(Math.max(GUTTER, r.left + r.width / 2 - bw / 2), vw - GUTTER - bw)
      bubble.style.top = `${top}px`
      bubble.style.left = `${left}px`
    }

    function close(result) {
      window.removeEventListener('resize', place)
      document.removeEventListener('keydown', onKey)
      layer.remove()
      resolve(result)
    }

    function onKey(e) {
      if (e.key === 'Escape') close('skipped')
      else if (e.key === 'ArrowRight') nextBtn.click()
      else if (e.key === 'ArrowLeft' && index > 0) backBtn.click()
    }

    nextBtn.addEventListener('click', function() {
      if (index === live.length - 1) { close('done'); return }
      index++
      render()
    })
    backBtn.addEventListener('click', function() {
      if (index === 0) return
      index--
      render()
    })
    layer.querySelector('.tour-skip').addEventListener('click', () => close('skipped'))
    window.addEventListener('resize', place)
    document.addEventListener('keydown', onKey)

    // One frame first, so a screen rendered just before this call has
    // finished laying out and the hole lands in the right place
    requestAnimationFrame(render)
  })
}

function isVisible(el) {
  if (!el || el.classList.contains('disabled')) return false
  const r = el.getBoundingClientRect()
  return r.width > 0 && r.height > 0
}
