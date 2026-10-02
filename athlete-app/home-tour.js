// ==========================================================================
// ATHLETE APP - home tour
// The first-time Home tour steps (run by tour.js) and the one-time "tick off
// each set" hint shown on the first workout.
// ==========================================================================
import { supabase } from './athleteClient.js?v=__V__'
import { runTour } from './tour.js?v=__V__'
import { athlete } from './state.js?v=__V__'
import { saveWithRetry } from './outbox.js?v=__V__'

function homeTourSteps() {
  const $ = sel => () => document.querySelector(sel)
  return [
    {
      title: `Welcome, ${athlete.name.split(' ')[0]}!`,
      body: "Here's a quick look around, so you know where everything is. It takes about 30 seconds."
    },
    {
      target: $('.week-strip'),
      title: 'Your week',
      body: "Each card is a day of your program. Tap any day to see what's planned. The arrows above switch weeks."
    },
    {
      target: $('.week-day-card.today'),
      title: 'Today',
      body: "When it's time to train, tap today and hit Start Workout. Tick off each set as you go. Everything saves automatically."
    },
    {
      target: $('#addOwnWorkoutTile'),
      title: 'Add your own workout',
      body: 'Trained outside your program, like a team practice or an extra gym session? Log it here so your coach sees it.'
    },
    {
      target: $('#mobilityTile'),
      title: 'Mobility & stretching',
      body: 'Guided mobility and stretching sessions you can do any day, on top of your training.'
    },
    {
      target: $('#tournamentsTile'),
      title: 'Tournaments',
      body: 'Add your upcoming tournaments so your coach can plan your training around them.'
    },
    {
      target: $('#logWeightTile'),
      title: 'Log your weight',
      body: 'Keep track of your bodyweight over time.'
    },
    {
      target: $('#navCommsBtn'),
      title: 'Chat',
      body: 'Message your coach any time. A dot shows up here when they reply.'
    },
    {
      target: $('#navStatsBtn'),
      title: 'Stats',
      body: 'Your training stats and progress, week by week.'
    },
    {
      target: $('#navProfileBtn'),
      title: 'Profile',
      body: 'Switch kg/lbs, turn on notifications and add your photo. You can replay this tour from here too.'
    }
  ]
}

export async function runHomeTour() {
  await runTour(homeTourSteps(), { doneLabel: "Let's go" })
  if (athlete.intro_seen) return
  athlete.intro_seen = true
  await saveWithRetry((signal) => supabase
    .from('athletes')
    .update({ intro_seen: true })
    .eq('id', athlete.id)
    .abortSignal(signal)
  )
}

// One-time hint the first time an athlete opens a workout: points at the
// first unticked set's check button. Called from mountSlide(), which every
// workout screen goes through. Remembered per device (localStorage) - it's
// only a hint, so seeing it once more on a new phone is fine. Profile's
// "Replay" clears it along with replaying the Home tour.
export const SET_HINT_KEY = 'tbflog-set-hint-seen'

export function maybeShowSetHint() {
  try { if (localStorage.getItem(SET_HINT_KEY)) return } catch (e) { return }
  const btn = document.querySelector('.workout-slide .set-row:not(.completed) .set-check-btn')
  if (!btn) return
  try { localStorage.setItem(SET_HINT_KEY, '1') } catch (e) { /* storage blocked - shows again next time, harmless */ }
  // After the slide-in animation (mountSlide's 0.2s) so the hole lands on
  // the button's final position
  setTimeout(function() {
    if (!btn.isConnected) return
    runTour([{
      target: () => btn,
      title: 'Tick off each set',
      body: 'Do the set, change the numbers if yours were different, then tap here. Tap it again to undo.'
    }], { doneLabel: 'Got it' })
  }, 250)
}
