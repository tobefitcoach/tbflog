// ==========================================================================
// SIDEBAR NAV — shared by every coach page that has one
// The "Library" submenu shows on hover for desktop (pure CSS), but touch
// devices have no hover - this adds a click/tap toggle so it's reachable
// on mobile too. Harmless on desktop (hover still works either way).
// ==========================================================================
document.querySelectorAll('.sidebar-item-hover > .sidebar-link').forEach(function(link) {
  link.addEventListener('click', function() {
    link.parentElement.classList.toggle('open')
  })
})
