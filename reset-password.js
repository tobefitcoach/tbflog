// ==========================================================================
// RESET PASSWORD
// Landing page for the link in Supabase's password-reset email. The link
// carries a recovery token in the URL hash; supabase-js reads it when the
// client is created and fires PASSWORD_RECOVERY, which is the signal that
// it's safe to show the "new password" form. ?role=coach|athlete (set by
// whichever login screen requested the email) picks which of the two
// clients to use - each keeps its own session under its own storage key -
// and where the "log in" link at the end points.
// ==========================================================================
const role = new URLSearchParams(window.location.search).get('role') === 'coach' ? 'coach' : 'athlete'
const loginUrl = role === 'coach' ? 'login.html' : 'athlete-app/index.html'

const { supabase } = await import(role === 'coach' ? './coachClient.js' : './athlete-app/athleteClient.js')

const checking = document.getElementById('resetChecking')
const form = document.getElementById('resetForm')
const done = document.getElementById('resetDone')
const expired = document.getElementById('resetExpired')
const message = document.getElementById('resetMessage')
const passwordInput = document.getElementById('resetPassword')
const confirmInput = document.getElementById('resetPasswordConfirm')
const submitBtn = document.getElementById('resetSubmitBtn')

document.getElementById('resetLoginLink').href = loginUrl
document.getElementById('resetExpiredLoginLink').href = loginUrl

let shown = false
function showOnly(el) {
  shown = true
  for (const section of [checking, form, done, expired]) section.style.display = section === el ? 'block' : 'none'
}

supabase.auth.onAuthStateChange(function(event) {
  if (event === 'PASSWORD_RECOVERY' && !done.style.display.includes('block')) showOnly(form)
})

// No recovery event shortly after load means the link was missing, used or
// expired (Supabase rejects it before ever creating a session)
setTimeout(function() { if (!shown) showOnly(expired) }, 4000)

submitBtn.addEventListener('click', async function() {
  const password = passwordInput.value
  if (password.length < 6) { message.textContent = 'Use at least 6 characters'; return }
  if (password !== confirmInput.value) { message.textContent = "The two passwords don't match"; return }

  message.textContent = ''
  submitBtn.disabled = true
  const { error } = await supabase.auth.updateUser({ password })
  submitBtn.disabled = false
  if (error) { message.textContent = error.message; return }

  // The recovery link signed this browser in - sign it back out so the
  // person logs in normally with the new password instead
  await supabase.auth.signOut()
  showOnly(done)
})
