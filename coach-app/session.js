// ==========================================================================
// SESSION HOLDER
// The multi-page coach site re-fetched the Supabase session at the top of
// all 15 of its scripts, because each page was a separate document that
// shared nothing. In the SPA that check happens once, in dashboard.js's
// start(), and the result is parked here for every screen to read.
//
// This is a standalone module rather than an export from dashboard.js
// purely to keep the import graph one-directional: dashboard.js imports
// screens (dynamically), screens import this. Nothing imports dashboard.js
// except for its `go`, which is genuinely part of the router's surface.
//
// Screens must not call supabase.auth.getSession() themselves - by the time
// any screen mounts, the session is guaranteed to be set here, and a second
// round trip per screen is exactly the kind of cost this rewrite exists to
// remove.
// ==========================================================================

let session = null

export function setSession(s) {
  session = s
}

export function getSession() {
  return session
}

// The logged-in coach's user id. Every insert on a coach-owned table needs
// it explicitly (RLS scopes selects automatically, but not inserts) - see
// the coach_id fields in the forms/trainings/sections/exercises screens.
export function coachId() {
  return session?.user?.id || null
}
