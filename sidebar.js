// ==========================================================================
// SIDEBAR NAV — shared by every coach page that has one
// ==========================================================================

// Each item ("Library", "Athletes") expands its submenu directly
// underneath on click/tap (see style.css - it no longer opens on hover,
// since that never worked on touch screens anyway). Opening one always
// closes any other that's open, so at most one submenu is ever showing.
// "Athletes" is a real link (unlike "Library", a plain non-navigating
// span) since it needs to take you to index.html from every other page -
// only intercepted (preventDefault, toggle instead of navigating) when
// its href points at the page you're already on, where navigating would
// just be a pointless reload with no visible effect.
function currentPageBasename() {
  const path = window.location.pathname
  return (path === '/' || path === '') ? 'index.html' : path.split('/').pop()
}

document.querySelectorAll('.sidebar-item-hover > .sidebar-link').forEach(function(link) {
  link.addEventListener('click', function(e) {
    if (link.tagName === 'A' && link.getAttribute('href').split('?')[0] !== currentPageBasename()) return

    e.preventDefault()
    const item = link.parentElement
    const wasOpen = item.classList.contains('open')
    document.querySelectorAll('.sidebar-item-hover.open').forEach(i => i.classList.remove('open'))
    if (!wasOpen) item.classList.add('open')
  })
})

// ---- Collapse / expand the whole sidebar ----
// Remembered in localStorage so it stays collapsed (or open) as you move
// between pages, instead of resetting every time
const sidebar = document.querySelector('.sidebar')
const toggleBtn = document.getElementById('sidebarToggleBtn')

if (sidebar && toggleBtn) {
  if (localStorage.getItem('tbflog-sidebar-collapsed') === '1') {
    sidebar.classList.add('collapsed')
    toggleBtn.textContent = '›'
  }

  toggleBtn.addEventListener('click', function() {
    const collapsed = sidebar.classList.toggle('collapsed')
    toggleBtn.textContent = collapsed ? '›' : '‹'
    localStorage.setItem('tbflog-sidebar-collapsed', collapsed ? '1' : '0')
  })
}
