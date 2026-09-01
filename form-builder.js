// ==========================================================================
// FORM BUILDER
// Edits one form's name, its gate_workout toggle, and its list of
// questions (short answer / long answer / 1-5 scale). Every question edit
// autosaves a moment after the coach stops typing - same "it just stays"
// reliability training-builder.js's exercise cards already have, no
// separate Save button needed since there's nothing here that benefits
// from a batched save (each question is independent).
// ==========================================================================
import { supabase } from './coachClient.js'

const params = new URLSearchParams(window.location.search)
const formId = params.get('id')

let questionsCache = []

const { data: { session } } = await supabase.auth.getSession()
if (!session) {
  window.location.href = 'login.html'
} else {
  loadForm()
}

async function loadForm() {
  const { data, error } = await fetchWithRetry((signal) => supabase
    .from('forms')
    .select('*, form_questions(*)')
    .eq('id', formId)
    .single()
    .abortSignal(signal)
  )

  if (error) {
    console.log('Error loading form:', error)
    document.getElementById('formNameHeading').textContent = 'Form not found'
    customAlert('Something went wrong loading this form - check your connection and try again')
    return
  }

  document.getElementById('formNameHeading').textContent = data.name
  document.getElementById('gateWorkoutToggle').checked = data.gate_workout
  questionsCache = (data.form_questions || []).sort((a, b) => a.order_index - b.order_index)
  renderQuestions()
}

const TYPE_LABELS = { short_text: 'Short Answer', long_text: 'Long Answer', scale_1_5: '1-5 Scale' }

function renderQuestions() {
  const list = document.getElementById('questionsList')
  list.innerHTML = questionsCache.length === 0
    ? '<p class="no-metrics">No questions yet - add one below.</p>'
    : questionsCache.map(renderQuestionCard).join('')

  list.querySelectorAll('.form-question-text').forEach(input => {
    input.addEventListener('input', function() { scheduleAutosave(input.closest('.form-question-card').dataset.id) })
  })
  list.querySelectorAll('.form-question-type').forEach(select => {
    select.addEventListener('change', function() { flushQuestionSave(select.closest('.form-question-card').dataset.id) })
  })
  list.querySelectorAll('.form-question-delete').forEach(btn => {
    btn.addEventListener('click', function() { deleteQuestion(btn.dataset.id) })
  })
}

function renderQuestionCard(q, i) {
  return `
    <div class="form-question-card" data-id="${q.id}">
      <div class="form-question-card-header">
        <span class="form-question-number">${i + 1}</span>
        <input type="text" class="form-question-text" placeholder="Question text..." value="${escapeHtmlForm(q.question_text)}" />
        <button type="button" class="btn-delete-measurement form-question-delete" data-id="${q.id}" title="Delete question"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg></button>
      </div>
      <select class="form-question-type">
        <option value="short_text" ${q.type === 'short_text' ? 'selected' : ''}>Short Answer</option>
        <option value="long_text" ${q.type === 'long_text' ? 'selected' : ''}>Long Answer</option>
        <option value="scale_1_5" ${q.type === 'scale_1_5' ? 'selected' : ''}>1-5 Scale</option>
      </select>
    </div>
  `
}

function escapeHtmlForm(str) {
  if (!str) return ''
  const div = document.createElement('div')
  div.textContent = str
  return div.innerHTML
}

let autosaveTimers = {}

function scheduleAutosave(questionId) {
  clearTimeout(autosaveTimers[questionId])
  autosaveTimers[questionId] = setTimeout(() => flushQuestionSave(questionId), 800)
}

async function flushQuestionSave(questionId) {
  clearTimeout(autosaveTimers[questionId])
  delete autosaveTimers[questionId]
  const card = document.querySelector(`.form-question-card[data-id="${questionId}"]`)
  if (!card) return
  const questionText = card.querySelector('.form-question-text').value.trim()
  const type = card.querySelector('.form-question-type').value

  const { error } = await supabase.from('form_questions').update({ question_text: questionText, type }).eq('id', questionId)
  if (error) { console.log(error); return }
  const q = questionsCache.find(q => q.id === questionId)
  if (q) { q.question_text = questionText; q.type = type }
}

document.getElementById('addQuestionBtn').addEventListener('click', async function() {
  const orderIndex = questionsCache.length
  const { data, error } = await supabase
    .from('form_questions')
    .insert([{ form_id: formId, order_index: orderIndex, question_text: '', type: 'short_text' }])
    .select()

  if (error) { console.log(error); customAlert('Something went wrong'); return }

  questionsCache.push(data[0])
  renderQuestions()
  const newInput = document.querySelector(`.form-question-card[data-id="${data[0].id}"] .form-question-text`)
  if (newInput) newInput.focus()
})

async function deleteQuestion(questionId) {
  if (!(await customConfirm('Delete this question?'))) return

  const { error } = await supabase.from('form_questions').delete().eq('id', questionId)
  if (error) { console.log(error); customAlert('Something went wrong'); return }

  questionsCache = questionsCache.filter(q => q.id !== questionId)
  renderQuestions()
}

document.getElementById('gateWorkoutToggle').addEventListener('change', async function() {
  const { error } = await supabase.from('forms').update({ gate_workout: this.checked }).eq('id', formId)
  if (error) { console.log(error); customAlert('Something went wrong saving that setting'); this.checked = !this.checked }
})

// ==========================================================================
// ---- RENAME ----
// ==========================================================================
document.getElementById('renameFormBtn').addEventListener('click', function() {
  document.getElementById('renameFormInput').value = document.getElementById('formNameHeading').textContent
  document.getElementById('renameFormModal').classList.add('active')
})

document.getElementById('cancelRenameFormBtn').addEventListener('click', function() {
  document.getElementById('renameFormModal').classList.remove('active')
})

document.getElementById('saveRenameFormBtn').addEventListener('click', async function() {
  const name = document.getElementById('renameFormInput').value.trim()
  if (!name) { customAlert('Please enter a name'); return }

  const { error } = await supabase.from('forms').update({ name }).eq('id', formId)
  if (error) { console.log(error); customAlert('Something went wrong'); return }

  document.getElementById('formNameHeading').textContent = name
  document.getElementById('renameFormModal').classList.remove('active')
})
