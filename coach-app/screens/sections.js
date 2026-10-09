// ==========================================================================
// SECTION LIBRARY — screen
// A section is a reusable group of exercises that gets pasted into workouts
// and program days (see the "+ Add Section" flows in the training/program
// builders). The list screen itself is the shared named library
// (name-library.js); this says what a section is.
// ==========================================================================
import { createNameLibrary } from '../name-library.js?v=__V__'

const library = createNameLibrary({
  singular: 'Section',
  plural: 'sections',
  title: 'Section Library',
  subtitle: 'A section is a reusable group of exercises (e.g. "Warm-up A") — build once, then drop it into any workout or program day.',
  table: 'sections',
  childTable: 'section_exercises',
  childNoun: 'exercise',
  builderRoute: 'section-builder',
  placeholder: 'e.g. Warm-up A',
  icon: '<polygon points="12 2 2 7 12 12 22 7 12 2"></polygon><polyline points="2 17 12 22 22 17"></polyline><polyline points="2 12 12 17 22 12"></polyline>'
})

export const mount = library.mount
export const unmount = library.unmount
