// ==========================================================================
// SIDEBAR NAV — shared by every coach page that has one
// ==========================================================================

// "Library" expands its submenu directly underneath on click/tap (see
// style.css - it no longer opens on hover, since that never worked on
// touch screens anyway)
document.querySelectorAll('.sidebar-item-hover > .sidebar-link').forEach(function(link) {
  link.addEventListener('click', function() {
    link.parentElement.classList.toggle('open')
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
