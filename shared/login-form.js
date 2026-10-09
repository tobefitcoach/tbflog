// ==========================================================================
// LOGIN / SIGNUP FORM
// The form behind both login pages (coach: login.html, athlete:
// athlete-app/index.html). Toggles between "Log In" and "Sign Up" mode on
// the same form. Signup passes the role in the auth metadata, which the
// database trigger (handle_new_user) reads to create the matching profiles
// row. Each page's own login.js just says which role/client/pages it is.
//
// options:
//   supabase    the client for this app (coachClient / athleteClient)
//   role        'coach' | 'athlete' - signup metadata and reset link
//   roleTitle   shown in "Create <roleTitle> Account"
//   homeUrl     where a signed-in person goes (relative to the login page)
//   resetUrl    the reset-password.html link emailed for "Forgot password?"
//   readInvite  true: a coach's fallback invite link (?email=...&name=...)
//               pre-fills the form and opens in signup mode - the only
//               reason anyone lands here with those params
// ==========================================================================
export async function initLoginForm({ supabase, role, roleTitle, homeUrl, resetUrl, readInvite = false }) {
  let mode = 'login'

  const authTitle = document.getElementById('authTitle')
  const authMessage = document.getElementById('authMessage')
  const nameField = document.getElementById('nameField')
  const authName = document.getElementById('authName')
  const authEmail = document.getElementById('authEmail')
  const authPassword = document.getElementById('authPassword')
  const authSubmitBtn = document.getElementById('authSubmitBtn')
  const authToggleText = document.getElementById('authToggleText')
  const authToggleLink = document.getElementById('authToggleLink')
  const authForgot = document.getElementById('authForgot')
  const authForgotLink = document.getElementById('authForgotLink')

  // Already logged in? Skip straight to the dashboard instead of showing the form
  const { data: { session } } = await supabase.auth.getSession()
  if (session) {
    window.location.href = homeUrl
  }

  function showMessage(text, isSuccess) {
    authMessage.textContent = text
    authMessage.classList.toggle('success', !!isSuccess)
  }

  function updateFormForMode() {
    showMessage('')
    if (mode === 'signup') {
      authTitle.textContent = `Create ${roleTitle} Account`
      nameField.style.display = 'block'
      authSubmitBtn.textContent = 'Sign Up'
      authToggleText.textContent = 'Already have an account?'
      authToggleLink.textContent = 'Log in'
      authForgot.style.display = 'none'
    } else {
      authTitle.textContent = 'Log In'
      nameField.style.display = 'none'
      authSubmitBtn.textContent = 'Log In'
      authToggleText.textContent = "Don't have an account?"
      authToggleLink.textContent = 'Sign up'
      authForgot.style.display = ''
    }
  }

  if (readInvite) {
    const params = new URLSearchParams(window.location.search)
    const invitedEmail = params.get('email')
    const invitedName = params.get('name')
    if (invitedEmail) {
      authEmail.value = invitedEmail
      if (invitedName) authName.value = invitedName
      mode = 'signup'
      updateFormForMode()
    }
  }

  authToggleLink.addEventListener('click', function(e) {
    e.preventDefault()
    mode = mode === 'login' ? 'signup' : 'login'
    updateFormForMode()
  })

  authSubmitBtn.addEventListener('click', async function() {
    const email = authEmail.value.trim()
    const password = authPassword.value

    if (!email || !password) {
      showMessage('Please enter an email and password')
      return
    }

    if (mode === 'signup') {
      const name = authName.value.trim()
      const { error } = await supabase.auth.signUp({
        email, password,
        options: { data: { role, name } }
      })

      if (error) { showMessage(error.message); return }

      mode = 'login'
      updateFormForMode()
      showMessage('Account created! Check your email to confirm, then log in.', true)
    } else {
      const { error } = await supabase.auth.signInWithPassword({ email, password })
      if (error) { showMessage(error.message); return }
      window.location.href = homeUrl
    }
  })

  // Emails a reset link (Supabase sends it) that opens reset-password.html,
  // which handles choosing the new password. The URL has to be on Supabase's
  // Auth -> URL Configuration redirect allow-list or it gets ignored. The
  // success message is the same whether or not the email has an account, so
  // this can't be used to find out who's registered.
  authForgotLink.addEventListener('click', async function(e) {
    e.preventDefault()
    const email = authEmail.value.trim()
    if (!email) { showMessage('Enter your email above first, then tap "Forgot password?"'); return }

    const redirectTo = new URL(resetUrl, window.location.href).href
    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo })
    if (error) { showMessage(error.message); return }
    showMessage('If that email has an account, a reset link is on its way. Check your inbox.', true)
  })
}
