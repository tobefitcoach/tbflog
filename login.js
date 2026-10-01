// ==========================================================================
// COACH LOGIN / SIGNUP
// Toggles between "Log In" and "Sign Up" mode on the same form. Signup
// passes role: 'coach' in the auth metadata, which the database trigger
// (handle_new_user) reads to create the matching profiles row.
// ==========================================================================
import { supabase } from './coachClient.js?v=__V__'

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
  window.location.href = 'app/index.html'
}

function showMessage(text, isSuccess) {
  authMessage.textContent = text
  authMessage.classList.toggle('success', !!isSuccess)
}

function updateFormForMode() {
  showMessage('')
  if (mode === 'signup') {
    authTitle.textContent = 'Create Coach Account'
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
      options: { data: { role: 'coach', name } }
    })

    if (error) { showMessage(error.message); return }

    mode = 'login'
    updateFormForMode()
    showMessage('Account created! Check your email to confirm, then log in.', true)
  } else {
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) { showMessage(error.message); return }
    window.location.href = 'app/index.html'
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

  const redirectTo = new URL('reset-password.html?role=coach', window.location.href).href
  const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo })
  if (error) { showMessage(error.message); return }
  showMessage('If that email has an account, a reset link is on its way. Check your inbox.', true)
})
