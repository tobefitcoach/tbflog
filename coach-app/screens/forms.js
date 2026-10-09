// ==========================================================================
// FORMS LIBRARY — screen
// A questionnaire is built once on the Form Builder screen, then assigned to
// any athlete's calendar day. The list screen itself is the shared named
// library (name-library.js); this says what a form is.
// ==========================================================================
import { createNameLibrary } from '../name-library.js?v=__V__'

const library = createNameLibrary({
  singular: 'Form',
  plural: 'forms',
  title: 'Forms',
  subtitle: 'Build a questionnaire once, then assign it to any athlete\'s calendar day — same "+" popup you already use for a workout.',
  table: 'forms',
  childTable: 'form_questions',
  childNoun: 'question',
  builderRoute: 'form-builder',
  placeholder: 'e.g. Daily Readiness Check',
  icon: '<path d="M9 11l3 3L22 4"></path><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path>',
  badge: form => form.gate_workout ? '<span class="workout-type-badge workout-type-badge-run">Gates that day\'s workout</span>' : ''
})

export const mount = library.mount
export const unmount = library.unmount
