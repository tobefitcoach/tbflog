// ==========================================================================
// ATHLETE DASHBOARD (placeholder)
// The real training-calendar UI doesn't exist yet - this page's only job
// right now is to work out which of 4 states a logged-in athlete is in,
// and show the right message for each:
//   1. Not logged in at all              -> back to the login page
//   2. Logged in, but not an athlete role -> error + sign out
//   3. Logged in, already linked          -> placeholder "not ready yet"
//   4. Logged in, not linked yet          -> try to auto-link by email,
//                                            or show a retriable "waiting" screen
// ==========================================================================
import { supabase } from './athleteClient.js'

const pageContent = document.getElementById('pageContent')

const { data: { session } } = await supabase.auth.getSession()
if (!session) {
  window.location.href = 'index.html'
}

document.getElementById('logoutBtn').addEventListener('click', async function() {
  await supabase.auth.signOut()
  window.location.href = 'index.html'
})

checkAccountState()

async function checkAccountState() {
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('role, name')
    .eq('id', session.user.id)
    .single()

  if (profileError || !profile || profile.role !== 'athlete') {
    renderWrongRole()
    return
  }

  const { data: athlete } = await supabase
    .from('athletes')
    .select('id, name')
    .eq('user_id', session.user.id)
    .maybeSingle()

  if (athlete) {
    renderPlaceholderDashboard(athlete)
    return
  }

  // Not linked yet - try to auto-link by matching the signup email against
  // an unclaimed athlete row (see claim_athlete_by_email() in the database)
  const { error: claimError } = await supabase.rpc('claim_athlete_by_email')

  if (!claimError) {
    window.location.reload()
    return
  }

  renderWaitingToBeLinked()
}

function renderWrongRole() {
  pageContent.innerHTML = `
    <h2>Wrong login</h2>
    <p>This is the athlete login, and this account isn't set up as an athlete. If you're a coach, use the main TBFlog login instead.</p>
    <button class="btn-save" id="signOutBtn">Sign Out</button>
  `
  document.getElementById('signOutBtn').addEventListener('click', async function() {
    await supabase.auth.signOut()
    window.location.href = 'index.html'
  })
}

function renderWaitingToBeLinked() {
  pageContent.innerHTML = `
    <h2>Almost there</h2>
    <p>Your coach hasn't linked your account yet. Once they've added your email to your athlete profile, click below to try again.</p>
    <button class="btn-save" id="retryBtn">Try Again</button>
  `
  document.getElementById('retryBtn').addEventListener('click', checkAccountState)
}

function renderPlaceholderDashboard(athlete) {
  pageContent.innerHTML = `
    <h2>Welcome, ${athlete.name}</h2>
    <p>Your training program isn't set up yet — check back soon!</p>
  `
}
