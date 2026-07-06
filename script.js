import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm'

const supabaseUrl = 'https://szvnaiqlxtlsjgnefunt.supabase.co'
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InN6dm5haXFseHRsc2pnbmVmdW50Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMxNTgzMTgsImV4cCI6MjA5ODczNDMxOH0.i0qOHffDnKBVreN1QM7h8tEfHlJgQulwhZ1x4YEAEdU'
const supabase = createClient(supabaseUrl, supabaseKey)

const addBtn = document.querySelector('.btn-add');
const modal = document.getElementById('addAthleteModal');
const cancelBtn = document.getElementById('cancelBtn');
const saveBtn = document.getElementById('saveBtn');
const athleteGrid = document.querySelector('.athlete-grid');

loadAthletes();

async function loadAthletes() {
  athleteGrid.innerHTML = ''

  const { data, error } = await supabase
    .from('athletes')
    .select('*')

  if (error) {
    console.log('Error loading athletes:', error)
    return
  }

  if (data.length === 0) {
    athleteGrid.innerHTML = '<p>No athletes yet — add your first one!</p>'
    return
  }

  data.forEach(athlete => {
    createAthleteCard(athlete)
  })
}

function createAthleteCard(athlete) {
  const initials = athlete.name.split(' ').map(word => word[0]).join('').toUpperCase()

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
    <p>${athlete.gender} · ${athlete.height}cm · ${athlete.weight}kg</p>
    <p>DOB: ${athlete.date_of_birth}</p>
    <p>0 metrics tracked</p>
  `

  card.addEventListener('click', function(e) {
    if (e.target.classList.contains('kebab-btn') ||
        e.target.classList.contains('kebab-delete')) return
    window.location.href = `athlete.html?id=${athlete.id}`
  })

  card.querySelector('.kebab-btn').addEventListener('click', function(e) {
    e.stopPropagation()
    const dropdown = document.getElementById(`dropdown-${athlete.id}`)
    dropdown.classList.toggle('active')
  })

  card.querySelector('.kebab-delete').addEventListener('click', async function(e) {
    e.stopPropagation()
    
    if (!confirm('Delete this athlete? This cannot be undone.')) return

    const { error } = await supabase
      .from('athletes')
      .delete()
      .eq('id', athlete.id)

    if (error) {
      console.log('Error deleting athlete:', error)
      alert('Something went wrong')
      return
    }

    loadAthletes()
  })

  athleteGrid.appendChild(card)
}

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
    alert('Please enter a name');
    return;
  }

  const { data, error } = await supabase
    .from('athletes')
    .insert([{
      name: name,
      date_of_birth: dob,
      gender: gender,
      height: height,
      weight: weight
    }])
    .select()

  if (error) {
    console.log('Error saving athlete:', error)
    alert('Something went wrong saving the athlete')
    return
  }

  createAthleteCard(data[0])
  modal.classList.remove('active')
});