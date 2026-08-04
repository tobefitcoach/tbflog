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
  athleteGrid.innerHTML = ''

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

  if (data.length === 0) {
    athleteGrid.innerHTML = '<p>No athletes yet — add your first one!</p>'
    return
  }

  // Since bodyweightData is sorted newest-first, the first entry we see for
  // each athlete_id is their most recent one
  const latestWeightByAthlete = {}
  if (bodyweightData) {
    for (const entry of bodyweightData) {
      if (!(entry.athlete_id in latestWeightByAthlete)) {
        latestWeightByAthlete[entry.athlete_id] = entry.weight
      }
    }
  }

  data.forEach(athlete => {
    createAthleteCard(athlete, latestWeightByAthlete[athlete.id])
  })
}
 
// ==========================================================================
// ---- CREATE ATHLETE CARD ----
// Builds one athlete card (initials, name, basic stats), wires up:
//  - clicking the card → go to that athlete's profile page
//  - the kebab (⋮) menu → toggle a dropdown
//  - "Delete athlete" in that dropdown → confirm, then delete from DB
// latestWeight is the athlete's most recent logged bodyweight (in kg), or
// undefined if they don't have any bodyweight entries yet
// ==========================================================================
function createAthleteCard(athlete, latestWeight) {
  const initials = athlete.name.split(' ').map(word => word[0]).join('').toUpperCase()
  const weightText = latestWeight ? ` · ${latestWeight}kg` : ''

  const card = document.createElement('div')
  card.classList.add('athlete-card')
card.innerHTML = `
    <div class="card-top">
      <div class="athlete-initials">${initials}</div>
      <div class="kebab-menu">
        <button class="kebab-btn" data-athlete-id="${athlete.id}">⋮</button>
        <div class="kebab-dropdown" id="dropdown-${athlete.id}">
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
    if (e.target.classList.contains('kebab-btn') ||
        e.target.classList.contains('kebab-delete')) return
    window.location.href = `athlete.html?id=${athlete.id}`
  })
 
  // Kebab (⋮) button toggles the delete dropdown open/closed
  card.querySelector('.kebab-btn').addEventListener('click', function(e) {
    e.stopPropagation()
    const dropdown = document.getElementById(`dropdown-${athlete.id}`)
    dropdown.classList.toggle('active')
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
  const weight = parseInt(document.getElementById('athleteWeight').value);
 
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
      weight: weight,
      coach_id: session.user.id
    }])
    .select()
 
  if (error) {
    console.log('Error saving athlete:', error)
    customAlert('Something went wrong saving the athlete')
    return
  }
 
  // Add the new athlete's card to the grid immediately, no full reload needed
  createAthleteCard(data[0])
  modal.classList.remove('active')
});
 