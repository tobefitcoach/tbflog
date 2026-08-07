// ==========================================================================
// SETUP — Supabase client + references to key DOM elements
// This is the dashboard/index page: it lists all athletes as cards and
// handles adding/deleting athletes.
// ==========================================================================
import { supabase } from './coachClient.js'
 
const addBtn = document.querySelector('.btn-add');
const modal = document.getElementById('addAthleteModal');
const cancelBtn = document.getElementById('cancelBtn');
const saveBtn = document.getElementById('saveBtn');
const athleteGrid = document.querySelector('.athlete-grid');

// Cached full list + the filter currently applied to it, so switching
// status chips re-renders instantly from memory instead of re-querying
let allAthletes = []
let latestWeightByAthlete = {}
let currentStatusFilter = 'all'

// Require a logged-in coach before loading anything. RLS is on, so the
// database itself only ever returns this coach's own athletes - this is
// just an extra UX gate so a logged-out visitor gets bounced to the login
// page instead of seeing an empty dashboard.
const { data: { session } } = await supabase.auth.getSession()
if (!session) {
  window.location.href = 'login.html'
} else {
  // Shows which account is logged in - each device remembers its own
  // session, so it's possible to be logged into a different coach account
  // (e.g. one made by tapping "Sign up" instead of "Log In" on a new
  // device) without realizing it, since the login screen looks the same
  // either way. Comparing this text between devices is the fastest way to
  // check if that's what's happening.
  document.getElementById('loggedInAs').textContent = session.user.email
  loadAthletes();
}

document.getElementById('logoutBtn').addEventListener('click', async function() {
  await supabase.auth.signOut()
  window.location.href = 'login.html'
})
 
// ==========================================================================
// ---- LOAD ATHLETES ----
// Fetches every athlete from the DB and renders a card for each one
// (or a placeholder message if there are none yet).
// ==========================================================================
async function loadAthletes() {
  // These 2 don't depend on each other's results, so they fire together -
  // both go through fetchWithRetry (network-retry.js) so a slow/flaky
  // connection gets a couple of automatic retries instead of silently
  // leaving this page looking like the athletes are missing
  const [
    { data, error },
    { data: bodyweightData }
  ] = await Promise.all([
    fetchWithRetry((signal) => supabase.from('athletes').select('*').abortSignal(signal)),
    // Every athlete's most recent bodyweight entry, so the card shows
    // what's actually been logged instead of the static weight set when
    // the athlete was created
    fetchWithRetry((signal) => supabase
      .from('bodyweight')
      .select('athlete_id, weight, date')
      .order('date', { ascending: false })
      .abortSignal(signal)
    )
  ])

  if (error) {
    console.log('Error loading athletes:', error)
    customAlert('Something went wrong loading your athletes - check your connection and try again')
    return
  }

  allAthletes = data

  // Since bodyweightData is sorted newest-first, the first entry we see for
  // each athlete_id is their most recent one
  latestWeightByAthlete = {}
  if (bodyweightData) {
    for (const entry of bodyweightData) {
      if (!(entry.athlete_id in latestWeightByAthlete)) {
        latestWeightByAthlete[entry.athlete_id] = entry.weight
      }
    }
  }

  applyStatusFilter(currentStatusFilter)
}

// ==========================================================================
// ---- STATUS + FILTER ----
// active = linked to a real login, pending = coach has entered an email but
// the athlete hasn't signed up/linked yet, offline = no email on file yet,
// archived = coach hid them (overrides the other 3 regardless of link state).
// ==========================================================================
function athleteStatus(athlete) {
  if (athlete.archived) return 'archived'
  if (athlete.user_id) return 'active'
  if (athlete.email) return 'pending'
  return 'offline'
}

function applyStatusFilter(status) {
  currentStatusFilter = status
  document.querySelectorAll('#athleteStatusFilter .chip-btn').forEach(btn => {
    btn.classList.toggle('selected', btn.dataset.status === status)
  })

  const filtered = allAthletes.filter(a => {
    const s = athleteStatus(a)
    if (status === 'all') return s !== 'archived'
    return s === status
  })

  athleteGrid.innerHTML = ''
  if (filtered.length === 0) {
    athleteGrid.innerHTML = '<p>No athletes here yet.</p>'
    return
  }
  filtered.forEach(athlete => {
    createAthleteCard(athlete, latestWeightByAthlete[athlete.id])
  })
}

document.getElementById('athleteStatusFilter').addEventListener('click', function(e) {
  const btn = e.target.closest('.chip-btn')
  if (btn) applyStatusFilter(btn.dataset.status)
})

// ==========================================================================
// ---- CREATE ATHLETE CARD ----
// Builds one athlete card (initials, name, basic stats), wires up:
//  - clicking the card → go to that athlete's profile page
//  - the kebab (⋮) menu → toggle a dropdown
//  - "Delete athlete" in that dropdown → confirm, then delete from DB
// latestWeight is the athlete's most recent logged bodyweight (in kg), or
// undefined if they don't have any bodyweight entries yet
// ==========================================================================
const STATUS_LABELS = { active: 'Active', pending: 'Pending', offline: 'Offline', archived: 'Archived' }

function createAthleteCard(athlete, latestWeight) {
  const initials = athlete.name.split(' ').map(word => word[0]).join('').toUpperCase()
  const weightText = latestWeight ? ` · ${latestWeight}kg` : ''
  const status = athleteStatus(athlete)

  const card = document.createElement('div')
  card.classList.add('athlete-card')
card.innerHTML = `
    <div class="card-top">
      <div style="display:flex; align-items:center; gap:8px">
        <div class="athlete-initials">${initials}</div>
        <span class="athlete-status-badge status-${status}">${STATUS_LABELS[status]}</span>
      </div>
      <div class="kebab-menu">
        <button class="kebab-btn" data-athlete-id="${athlete.id}">⋮</button>
        <div class="kebab-dropdown" id="dropdown-${athlete.id}">
          ${status === 'pending' ? `
            <button class="kebab-item kebab-resend" data-athlete-id="${athlete.id}">✉️ Resend Invite</button>
            <button class="kebab-item kebab-copy-link" data-athlete-id="${athlete.id}">🔗 Copy Invite Link</button>
          ` : ''}
          <button class="kebab-item kebab-archive" data-athlete-id="${athlete.id}">${athlete.archived ? '♻️ Unarchive athlete' : '📦 Archive athlete'}</button>
          <button class="kebab-delete" data-athlete-id="${athlete.id}">🗑 Delete athlete</button>
        </div>
      </div>
    </div>
    <h3>${athlete.name}</h3>
    <p>${athlete.gender} · ${athlete.height}cm${weightText}</p>
    <p>DOB: ${athlete.date_of_birth}</p>
    <p>0 metrics tracked</p>
  `

  // Clicking anywhere on the card (except the kebab menu) opens the athlete's profile
  card.addEventListener('click', function(e) {
    if (e.target.closest('.kebab-menu')) return
    window.location.href = `athlete.html?id=${athlete.id}`
  })

  // Kebab (⋮) button toggles the dropdown open/closed
  card.querySelector('.kebab-btn').addEventListener('click', function(e) {
    e.stopPropagation()
    const dropdown = document.getElementById(`dropdown-${athlete.id}`)
    dropdown.classList.toggle('active')
  })

  // "Resend Invite" / "Copy Invite Link" - only present on Pending cards
  card.querySelector('.kebab-resend')?.addEventListener('click', async function(e) {
    e.stopPropagation()
    const error = await sendInviteEmail(athlete.email, athlete.name)
    customAlert(error ? 'Something went wrong sending the invite' : `Invite sent to ${athlete.email}`)
  })

  card.querySelector('.kebab-copy-link')?.addEventListener('click', async function(e) {
    e.stopPropagation()
    await navigator.clipboard.writeText(buildInviteLink(athlete.email, athlete.name))
    customAlert('Invite link copied - paste it anywhere you like.')
  })

  // "Archive athlete" / "Unarchive athlete" - reversible, no confirm needed
  card.querySelector('.kebab-archive').addEventListener('click', async function(e) {
    e.stopPropagation()
    const { error } = await supabase
      .from('athletes')
      .update({ archived: !athlete.archived })
      .eq('id', athlete.id)

    if (error) {
      console.log('Error archiving athlete:', error)
      customAlert('Something went wrong')
      return
    }

    loadAthletes()
  })

  // "Delete athlete" — confirm, delete from DB, then refresh the list
  card.querySelector('.kebab-delete').addEventListener('click', async function(e) {
    e.stopPropagation()

    if (!(await customConfirm('Delete this athlete? This cannot be undone.'))) return

    const { error } = await supabase
      .from('athletes')
      .delete()
      .eq('id', athlete.id)

    if (error) {
      console.log('Error deleting athlete:', error)
      customAlert('Something went wrong')
      return
    }

    loadAthletes()
  })

  athleteGrid.appendChild(card)
}
 
// ==========================================================================
// ---- INVITE HELPERS ----
// sendInviteEmail fires Supabase's own magic-link email (shouldCreateUser
// lets it create the auth account on the spot, with role/name stamped into
// signup metadata for the handle_new_user trigger to pick up) - this is
// what turns a Pending athlete into Active once they click it and land on
// the athlete app, already signed in and auto-linked via
// claim_athlete_by_email(). buildInviteLink is the manual fallback: a
// plain link straight to the athlete app's signup form with email/name
// pre-filled, no dependency on the invite email actually arriving.
// ==========================================================================
async function sendInviteEmail(email, name) {
  const redirectTo = new URL('athlete-app/dashboard.html', window.location.href).href
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: true, emailRedirectTo: redirectTo, data: { role: 'athlete', name } }
  })
  return error
}

function buildInviteLink(email, name) {
  const url = new URL('athlete-app/index.html', window.location.href)
  if (email) url.searchParams.set('email', email)
  if (name) url.searchParams.set('name', name)
  return url.href
}

// ==========================================================================
// ---- ADD ATHLETE MODAL ----
// Open/close the "add athlete" modal, and save a new athlete to the DB.
// ==========================================================================
addBtn.addEventListener('click', function() {
  modal.classList.add('active');
});
 
cancelBtn.addEventListener('click', function() {
  modal.classList.remove('active');
});
 
saveBtn.addEventListener('click', async function() {
  const name = document.getElementById('athleteName').value;
  const dob = document.getElementById('athleteDOB').value;
  const gender = document.getElementById('athleteGender').value;
  const height = parseInt(document.getElementById('athleteHeight').value);
  // Empty -> null, not '' - the email column has a "no duplicates" rule in
  // the database, and two blank emails would otherwise count as duplicates
  const email = document.getElementById('athleteEmail').value.trim() || null;

  if (name === '') {
    customAlert('Please enter a name');
    return;
  }

  // coach_id has to be set on insert - once RLS is on, the athletes table
  // policy only allows rows where coach_id matches the logged-in coach
  const { data, error } = await supabase
    .from('athletes')
    .insert([{
      name: name,
      date_of_birth: dob,
      gender: gender,
      height: height,
      email: email,
      coach_id: session.user.id
    }])
    .select()

  if (error) {
    console.log('Error saving athlete:', error)
    if (error.code === '23505') {
      customAlert('Another athlete is already using that email')
    } else {
      customAlert('Something went wrong saving the athlete')
    }
    return
  }

  modal.classList.remove('active')
  document.getElementById('athleteEmail').value = ''

  // The athlete row is saved either way - an invite failure shouldn't look
  // like the whole save failed, just its own message
  if (email) {
    const inviteError = await sendInviteEmail(email, name)
    if (inviteError) {
      console.log('Error sending invite:', inviteError)
      customAlert('Athlete saved, but the invite email failed to send. You can resend it or copy the invite link from the kebab menu on their card.')
    }
  }

  await loadAthletes()
});
