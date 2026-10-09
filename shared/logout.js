// ==========================================================================
// LOG OUT
// The one way either app signs someone out. Besides ending the session it
// forgets which role this device was routed as last time (see
// app/index.js's header for that cache), so the app chooser asks again
// instead of sending the next visit straight back to the side that just
// signed out.
//
// destination: the chooser (app/index.html) by default - also right for
// "wrong login" screens, since the login page would just show the same
// message again. The coach app's wrong-role screen passes ../login.html.
// supabase: the client of whichever app is signing out - the coach and
// athlete apps keep separate sessions (coachClient.js / athleteClient.js).
// ==========================================================================

export const KNOWN_ROLE_KEY = 'tbflog-known-role'

export async function logOut(supabase, destination = '../app/index.html') {
  await supabase.auth.signOut()
  try { localStorage.removeItem(KNOWN_ROLE_KEY) } catch (e) { /* storage blocked - nothing cached to forget */ }
  window.location.href = destination
}
