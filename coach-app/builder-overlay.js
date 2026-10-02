// ==========================================================================
// builder-overlay.js - for the screens that show the Workout Builder in
// their "Build Workout" overlay (athlete-detail's calendar, and
// program-builder). The builder module is only fetched the first time an
// overlay opens, so those screens don't load it up front. Same module URL
// as the router's 'training-builder' route, so it's one shared copy.
// ==========================================================================

let builder = null

async function loadBuilder() {
  if (!builder) builder = await import('./screens/training-builder.js?v=__V__')
  return builder
}

// opts: { id } for a Workout Library training, { dayId } for a scheduled day
export async function openBuilderOverlay(hostEl, opts) {
  const b = await loadBuilder()
  await b.openBuilder(hostEl, opts)
}

// Sends the last autosave (no time limit - it runs in this page, so
// nothing can cut it off), then clears the overlay. Await it before
// refreshing whatever the builder edited.
export async function closeBuilderOverlay(hostEl) {
  if (!builder || !hostEl || builder.builderHost() !== hostEl) return
  await builder.flushBuilder()
  if (builder.builderHost() === hostEl) builder.closeBuilder()
}

// Leaving the screen with the overlay still open: send the pending edit
// (the router gives this up to 3s; a save already sent finishes anyway)
export async function flushBuilderOverlay(hostEl) {
  if (builder && hostEl && builder.builderHost() === hostEl) await builder.flushBuilder()
}

// The screen is being torn down: close the overlay's builder if it's open
export function teardownBuilderOverlay(hostEl) {
  if (builder && hostEl && builder.builderHost() === hostEl) builder.closeBuilder()
}
