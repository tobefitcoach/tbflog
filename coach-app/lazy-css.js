// ==========================================================================
// LAZY STYLESHEET LOADING
// Used by athlete-detail.js and the 3 builder screens to inject their own
// split-out CSS file (coach-app/css/*.css) the first time they mount,
// instead of it sitting on coach-app/dashboard.html's critical path for
// every screen. See Part D of the rebuild plan.
//
// Each url is only ever injected once - a Set tracks what's already been
// added, so navigating back to the same screen a second time is a no-op,
// not a duplicate <link>.
// ==========================================================================
const injected = new Set()

export function ensureCss(href) {
  if (injected.has(href)) return
  injected.add(href)
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = href
  document.head.appendChild(link)
}
