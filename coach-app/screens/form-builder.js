// ==========================================================================
// FORM BUILDER — screen
// Converted from the repo-root form-builder.js + the .dashboard block of
// form-builder.html. Edits one form's name, its gate_workout toggle, and its
// list of questions (short answer / long answer / 1-5 scale). Every question
// edit autosaves a moment after the coach stops typing - same "it just
// stays" reliability the training builder's exercise cards already have, no
// separate Save button needed since there's nothing here that benefits from
// a batched save (each question is independent).
//
// This is a drill-down (route.endsWith('-builder')), so it renders its own
// .screen-header with a back button, same as _placeholder.js's reference
// treatment - it's the one screen of the three builders that already had an
// explicit "Done" affordance in the original (an <a href="forms.html">),
// kept here as a real button that routes instead of navigating documents.
//
// autosaveTimers is the one piece of state that outlives a single call and
// MUST be cleared in unmount() - left running, a debounce armed right before
// the coach navigated away would fire minutes later against a question that
// no longer has a card on screen.
// ==========================================================================
import { supabase } from '../../coachClient.js'
import * as nav from '../nav.js'
import { go } from '../router.js'
import { ensureCss } from '../lazy-css.js'

const TEMPLATE = `
  <div class="screen-header">
    <button class="btn-back" id="formBuilderBackBtn" aria-label="Back">←</button>
    <h2 class="screen-title" id="formNameHeading">Loading...</h2>
  </div>
  <div class="dashboard-header" style="justify-content:flex-end">
    <div style="display:flex; gap:12px">
      <button class="btn-profile-action" id="renameFormBtn">Rename</button>
      <button class="btn-save" id="doneFormBtn">Done</button>
    </div>
  </div>

  <div class="settings-row" style="margin-bottom:24px">
    <div class="settings-row-info">
      <div class="settings-row-title">Gate that day's workout</div>
      <div class="settings-row-desc">When this form is assigned to the same day as a workout, the athlete can't start that workout until they've completed this form.</div>
    </div>
    <label class="toggle-switch">
      <input type="checkbox" id="gateWorkoutToggle" />
      <span class="toggle-slider"></span>
    </label>
  </div>

  <div id="questionsList"></div>
  <button class="btn-add" id="addQuestionBtn" style="margin-top:12px">+ Add Question</button>

  <!-- Rename Form Modal -->
  <div class="modal-overlay" id="renameFormModal">
    <div class="modal">
      <h2>Rename Form</h2>
      <div class="form-group">
        <label>Name</label>
        <input type="text" id="renameFormInput" />
      </div>
      <div class="form-actions">
        <button class="btn-cancel" id="cancelRenameFormBtn" data-modal-dismiss>Cancel</button>
        <button class="btn-save" id="saveRenameFormBtn">Save</button>
      </div>
    </div>
  </div>
`

const TYPE_LABELS = { short_text: 'Short Answer', long_text: 'Long Answer', scale_1_5: '1-5 Scale' }

let root = null
let formId = null
let questionsCache = []
let autosaveTimers = {}

export async function mount(container, params, token) {
  ensureCss('css/builders.css?v=1')
  root = container
  formId = params.id
  container.innerHTML = TEMPLATE
  bindEvents()

  await loadForm(token)
}

export function unmount() {
  // Every armed autosave debounce must die here - left running, one that
  // fired after the coach navigated away would write against a question
  // whose card no longer exists on screen.
  Object.values(autosaveTimers).forEach(clearTimeout)
  autosaveTimers = {}
  root = null
  formId = null
  questionsCache = []
}

function bindEvents() {
  root.querySelector('#formBuilderBackBtn').addEventListener('click', function() { nav.back() })

  root.querySelector('#doneFormBtn').addEventListener('click', function() { go('forms', {}) })

  root.querySelector('#addQuestionBtn').addEventListener('click', async function() {
    const orderIndex = questionsCache.length
    const { data, error } = await supabase
      .from('form_questions')
      .insert([{ form_id: formId, order_index: orderIndex, question_text: '', type: 'short_text' }])
      .select()

    if (error) { console.log(error); customAlert('Something went wrong'); return }

    questionsCache.push(data[0])
    renderQuestions()
    const newInput = root.querySelector(`.form-question-card[data-id="${data[0].id}"] .form-question-text`)
    if (newInput) newInput.focus()
  })

  root.querySelector('#gateWorkoutToggle').addEventListener('change', async function() {
    const { error } = await supabase.from('forms').update({ gate_workout: this.checked }).eq('id', formId)
    if (error) { console.log(error); customAlert('Something went wrong saving that setting'); this.checked = !this.checked }
  })

  // ==========================================================================
  // ---- RENAME ----
  // ==========================================================================
  root.querySelector('#renameFormBtn').addEventListener('click', function() {
    root.querySelector('#renameFormInput').value = root.querySelector('#formNameHeading').textContent
    root.querySelector('#renameFormModal').classList.add('active')
  })

  root.querySelector('#cancelRenameFormBtn').addEventListener('click', function() {
    root.querySelector('#renameFormModal').classList.remove('active')
  })

  root.querySelector('#saveRenameFormBtn').addEventListener('click', async function() {
    const name = root.querySelector('#renameFormInput').value.trim()
    if (!name) { customAlert('Please enter a name'); return }

    const { error } = await supabase.from('forms').update({ name }).eq('id', formId)
    if (error) { console.log(error); customAlert('Something went wrong'); return }

    root.querySelector('#formNameHeading').textContent = name
    root.querySelector('#renameFormModal').classList.remove('active')
  })
}

async function loadForm(token) {
  const { data, error } = await window.fetchWithRetry((signal) => supabase
    .from('forms')
    .select('*, form_questions(*)')
    .eq('id', formId)
    .single()
    .abortSignal(signal)
  )
  if (!nav.isCurrent(token)) return

  if (error) {
    console.log('Error loading form:', error)
    root.querySelector('#formNameHeading').textContent = 'Form not found'
    customAlert('Something went wrong loading this form - check your connection and try again')
    return
  }

  root.querySelector('#formNameHeading').textContent = data.name
  root.querySelector('#gateWorkoutToggle').checked = data.gate_workout
  questionsCache = (data.form_questions || []).sort((a, b) => a.order_index - b.order_index)
  renderQuestions()
}

function renderQuestions() {
  const list = root.querySelector('#questionsList')
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

function scheduleAutosave(questionId) {
  clearTimeout(autosaveTimers[questionId])
  autosaveTimers[questionId] = setTimeout(() => flushQuestionSave(questionId), 800)
}

async function flushQuestionSave(questionId) {
  clearTimeout(autosaveTimers[questionId])
  delete autosaveTimers[questionId]
  const card = root.querySelector(`.form-question-card[data-id="${questionId}"]`)
  if (!card) return
  const questionText = card.querySelector('.form-question-text').value.trim()
  const type = card.querySelector('.form-question-type').value

  const { error } = await supabase.from('form_questions').update({ question_text: questionText, type }).eq('id', questionId)
  if (error) { console.log(error); return }
  const q = questionsCache.find(q => q.id === questionId)
  if (q) { q.question_text = questionText; q.type = type }
}

async function deleteQuestion(questionId) {
  if (!(await customConfirm('Delete this question?'))) return

  const { error } = await supabase.from('form_questions').delete().eq('id', questionId)
  if (error) { console.log(error); customAlert('Something went wrong'); return }

  questionsCache = questionsCache.filter(q => q.id !== questionId)
  renderQuestions()
}
