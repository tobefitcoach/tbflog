// ==========================================================================
// LOADING BAR
// A thin animated bar pinned to the top of the page, shown while any
// network request is in flight. Wraps window.fetch once here instead of
// touching every individual load/save function across the app - supabase-js
// itself is built on fetch(), so this automatically covers every database
// call everywhere (page loads, saves, deletes) with no per-page wiring.
//
// Loaded FIRST, before any page's own script, on every page (see the
// <script> order in each .html file) - the fetch patch has to be installed
// before that page's own data-loading calls fire, or the very first
// request would be missed.
// ==========================================================================
const bar = document.createElement('div')
bar.id = 'loadingBar'
document.documentElement.appendChild(bar)

const style = document.createElement('style')
style.textContent = `
  #loadingBar {
    position: fixed;
    top: 0;
    left: 0;
    height: 3px;
    width: 0%;
    background: linear-gradient(90deg, #4a4a8e, #7b7bce);
    z-index: 9999;
    opacity: 0;
    pointer-events: none;
  }
`
document.head.appendChild(style)

let activeRequests = 0
let hideTimeout = null

function show() {
  clearTimeout(hideTimeout)
  bar.style.transition = 'none'
  bar.style.opacity = '1'
  bar.style.width = '0%'
  // Force a reflow so the width:0% reset above actually takes effect
  // before the transition below starts, instead of the browser collapsing
  // both changes into one and skipping straight to the end state
  void bar.offsetHeight
  bar.style.transition = 'width 0.4s ease-out'
  bar.style.width = '70%'
}

function hide() {
  bar.style.transition = 'width 0.2s ease-out'
  bar.style.width = '100%'
  hideTimeout = setTimeout(function() {
    bar.style.transition = 'opacity 0.3s ease-out'
    bar.style.opacity = '0'
  }, 200)
}

function requestStarted() {
  activeRequests++
  if (activeRequests === 1) show()
}

// Several requests often overlap (e.g. loadTrainingData's three queries) -
// only actually hide once the LAST one finishes, not the first
function requestFinished() {
  activeRequests = Math.max(0, activeRequests - 1)
  if (activeRequests === 0) hide()
}

const originalFetch = window.fetch
window.fetch = function(...args) {
  requestStarted()
  return originalFetch.apply(this, args).finally(requestFinished)
}
