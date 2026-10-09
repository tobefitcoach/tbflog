// ==========================================================================
// COACH LOGIN / SIGNUP
// The form itself lives in shared/login-form.js (shared with the athlete
// login) - this just says this is the coach one.
// ==========================================================================
import { supabase } from './coachClient.js?v=__V__'
import { initLoginForm } from './shared/login-form.js?v=__V__'

await initLoginForm({
  supabase,
  role: 'coach',
  roleTitle: 'Coach',
  homeUrl: 'app/index.html',
  resetUrl: 'reset-password.html?role=coach'
})
