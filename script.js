// Get references to elements we need
const addBtn = document.querySelector('.btn-add');
const modal = document.getElementById('addAthleteModal');
const cancelBtn = document.getElementById('cancelBtn');
const saveBtn = document.getElementById('saveBtn');
const athleteGrid = document.querySelector('.athlete-grid');

// Open the modal when clicking "+ Add Athlete"
addBtn.addEventListener('click', function() {
  modal.classList.add('active');
});

// Close the modal when clicking Cancel
cancelBtn.addEventListener('click', function() {
  modal.classList.remove('active');
});

// Save the athlete when clicking Save
saveBtn.addEventListener('click', function() {
  const name = document.getElementById('athleteName').value;
  const dob = document.getElementById('athleteDOB').value;
  const gender = document.getElementById('athleteGender').value;
  const height = document.getElementById('athleteHeight').value;
  const weight = document.getElementById('athleteWeight').value;

  if (name === '') {
    alert('Please enter a name');
    return;
  }

  const initials = name.split(' ').map(word => word[0]).join('').toUpperCase();

  const card = document.createElement('div');
  card.classList.add('athlete-card');
  card.innerHTML = `
    <div class="athlete-initials">${initials}</div>
    <h3>${name}</h3>
    <p>${gender} · ${height}cm · ${weight}kg</p>
    <p>DOB: ${dob}</p>
    <p>0 metrics tracked</p>
  `;

  athleteGrid.appendChild(card);
  modal.classList.remove('active');
});
