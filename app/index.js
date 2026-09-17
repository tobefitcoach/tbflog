// ==========================================================================
// ROLE ROUTER
// The one thing this page does: figure out whether whoever's here is a
// signed-in coach, a signed-in athlete, or neither, and send them to the
// right place. Nothing renders here except a brief splash - this is a
// waypoint, not a destination, so it should never be where anyone lingers.
//
// Why TWO Supabase clients: coachClient.js and athleteClient.js are
// genuinely separate client instances with separate localStorage keys
// ('tbflog-coach-auth' / 'tbflog-athlete-auth'), by design - see either
// file's own header comment for why. That means there is no single
// getSession() call that can answer "is anyone signed in here at all" -
// both clients have to be asked, since either, neither, or (a coach also
// testing the athlete app on the same device) even both could be populated.
//
// This IS the thing both the site root (index.html) and
// mobile-app/capacitor.config.json's server.url point at now - a
// session-less visitor lands here first on every platform.
// ==========================================================================
import { supabase as coachSupabase } from '../coachClient.js'
import { supabase as athleteSupabase } from '../athlete-app/athleteClient.js'

// Once a coach or athlete has been routed once, their role is cached here
// so every later visit skips the two-client session probe (and its two
// network round trips) entirely - this file becomes a same-tick redirect
// instead of a "wait for Supabase to answer" one. A stale/wrong cached
// value self-corrects on the very next login: coachClient.js/athleteClient.js's
// own signOut flows don't touch this key, but the destination apps' own
// role checks (already in place - see coach-app/dashboard.js's start() and
// athlete-app/dashboard.js's checkAccountState()) still verify the real
// role independently, so a stale cache can misroute at most once, to a
// screen that will itself bounce a wrong-role visitor back out.
const CACHED_ROLE_KEY = 'tbflog-known-role'

const cachedRole = localStorage.getItem(CACHED_ROLE_KEY)
if (cachedRole === 'coach') {
  location.replace('../coach-app/dashboard.html')
} else if (cachedRole === 'athlete') {
  location.replace('../athlete-app/dashboard.html')
} else {
  route()
}

async function route() {
  const [{ data: coachData }, { data: athleteData }] = await Promise.all([
    coachSupabase.auth.getSession(),
    athleteSupabase.auth.getSession(),
  ])

  if (coachData.session) {
    const { data: profile } = await coachSupabase
      .from('profiles')
      .select('role')
      .eq('id', coachData.session.user.id)
      .single()
    if (profile?.role === 'coach') {
      localStorage.setItem(CACHED_ROLE_KEY, 'coach')
      location.replace('../coach-app/dashboard.html')
      return
    }
  }

  if (athleteData.session) {
    const { data: profile } = await athleteSupabase
      .from('profiles')
      .select('role')
      .eq('id', athleteData.session.user.id)
      .single()
    if (profile?.role === 'athlete') {
      localStorage.setItem(CACHED_ROLE_KEY, 'athlete')
      location.replace('../athlete-app/dashboard.html')
      return
    }
  }

  // No usable session under either client - a brand new visitor, a
  // logged-out one, or someone whose profile row doesn't match either
  // client's session (shouldn't happen, but falling through here rather
  // than throwing is the safe default). A returning athlete on a fresh
  // device (reinstalled, cleared storage) has no way to know they need
  // athlete-app/index.html specifically, so rather than assuming coach and
  // sending everyone to the coach login, ask.
  showChooser()
}

function showChooser() {
  document.getElementById('routerSplash').hidden = true
  document.getElementById('roleChooser').hidden = false
}

document.getElementById('chooseCoachBtn').addEventListener('click', function() {
  location.href = '../login.html'
})
document.getElementById('chooseAthleteBtn').addEventListener('click', function() {
  location.href = '../athlete-app/index.html'
})
