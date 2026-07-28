// ==========================================================================
// ATHLETE LOGIN / SIGNUP
// Same toggle-between-login-and-signup pattern as the coach's login.js, but
// passes role: 'athlete' in the signup metadata and sends people to this
// app's own dashboard.html afterwards.
// ==========================================================================
import { supabase } from './athleteClient.js'

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

// Already logged in? Skip straight to the dashboard instead of showing the form
const { data: { session } } = await supabase.auth.getSession()
if (session) {
  window.location.href = 'dashboard.html'
}

function showMessage(text, isSuccess) {
  authMessage.textContent = text
  authMessage.classList.toggle('success', !!isSuccess)
}

function updateFormForMode() {
  showMessage('')
  if (mode === 'signup') {
    authTitle.textContent = 'Create Athlete Account'
    nameField.style.display = 'block'
    authSubmitBtn.textContent = 'Sign Up'
    authToggleText.textContent = 'Already have an account?'
    authToggleLink.textContent = 'Log in'
  } else {
    authTitle.textContent = 'Log In'
    nameField.style.display = 'none'
    authSubmitBtn.textContent = 'Log In'
    authToggleText.textContent = "Don't have an account?"
    authToggleLink.textContent = 'Sign up'
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
      options: { data: { role: 'athlete', name } }
    })

    if (error) { showMessage(error.message); return }

    mode = 'login'
    updateFormForMode()
    showMessage('Account created! Check your email to confirm, then log in.', true)
  } else {
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) { showMessage(error.message); return }
    window.location.href = 'dashboard.html'
  }
})
