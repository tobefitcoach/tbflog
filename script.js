// Connect to Supabase
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm'

const supabaseUrl = 'https://sb_publishable_mV5f4N_x6eXux_f62qQiXw_RiyC5kLT.supabase.co'
const supabaseKey = 'sb_publishable_mV5f4N_x6eXux_f62qQiXw_RiyC5kLT'
const supabase = createClient(supabaseUrl, supabaseKey)

// Get references to elements we need
const addBtn = document.querySelector('.btn-add');
const modal = document.getElementById('addAthleteModal');
const cancelBtn = document.getElementById('cancelBtn');
const saveBtn = document.getElementById('saveBtn');
const athleteGrid = document.querySelector('.athlete-grid');

// Load athletes when page opens
loadAthletes();

async function loadAthletes() {
  const { data, error } = await supabase
    .from('athletes')
    .select('*')

  if (error) {
    console.log('Error loading athletes:', error)
    return
  }

  // Clear the grid first
  athleteGrid.innerHTML = ''

  // Create a card for each athlete
  data.forEach(athlete => {
    createAthleteCard(athlete)
  })
}

function createAthleteCard(athlete) {
  const initials = athlete.name.split(' ').map(word => word[0]).join('').toUpperCase()

  const card = document.createElement('div')
  card.classList.add('athlete-card')
  card.innerHTML = `
    <div class="athlete-initials">${initials}</div>
    <h3>${athlete.name}</h3>
    <p>${athlete.gender} · ${athlete.height}cm · ${athlete.weight}kg</p>
    <p>DOB: ${athlete.date_of_birth}</p>
    <p>0 metrics tracked</p>
  `
  athleteGrid.appendChild(card)
}

// Open the modal when clicking "+ Add Athlete"
addBtn.addEventListener('click', function() {
  modal.classList.add('active');
});

// Close the modal when clicking Cancel
cancelBtn.addEventListener('click', function() {
  modal.classList.remove('active');
});

// Save the athlete when clicking Save
saveBtn.addEventListener('click', async function() {
  const name = document.getElementById('athleteName').value;
  const dob = document.getElementById('athleteDOB').value;
  const gender = document.getElementById('athleteGender').value;
  const height = document.getElementById('athleteHeight').value;
  const weight = document.getElementById('athleteWeight').value;

  if (name === '') {
    alert('Please enter a name');
    return;
  }

  // Save to Supabase
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

  // Add card to the screen
  createAthleteCard(data[0])
  modal.classList.remove('active')
});