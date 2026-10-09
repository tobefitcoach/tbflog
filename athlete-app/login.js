// ==========================================================================
// ATHLETE LOGIN / SIGNUP
// The form itself lives in shared/login-form.js (shared with the coach
// login) - this just says this is the athlete one, which sends people to
// this app's own dashboard.html afterwards and accepts the coach's
// fallback invite link (?email=...&name=...).
// ==========================================================================
import { supabase } from './athleteClient.js?v=__V__'
import { initLoginForm } from '../shared/login-form.js?v=__V__'

await initLoginForm({
  supabase,
  role: 'athlete',
  roleTitle: 'Athlete',
  homeUrl: 'dashboard.html',
  resetUrl: '../reset-password.html?role=athlete',
  readInvite: true
})
