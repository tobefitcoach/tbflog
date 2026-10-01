// ==========================================================================
// builder-frame.js - for the screens that embed the root Workout Builder
// (training-builder.html?...&embed=1) in an iframe: athlete-detail's and
// program-builder's overlay, and the training-builder route screen.
//
// The builder autosaves each edit 800ms after typing stops. Blanking or
// removing the iframe inside that window dropped the edit, so every close
// path waits on this first. It asks the builder to send only what's still
// pending (window.flushPendingSaves in training-builder.js), capped so a
// dead connection can't hold the screen open.
// ==========================================================================

const FLUSH_TIMEOUT_MS = 3000

export async function flushBuilderFrame(frame) {
  let flush
  try {
    flush = frame?.contentWindow?.flushPendingSaves
  } catch (err) {
    return // not the builder (about:blank, or not loaded yet)
  }
  if (typeof flush !== 'function') return
  try {
    await Promise.race([flush(), new Promise(resolve => setTimeout(resolve, FLUSH_TIMEOUT_MS))])
  } catch (err) {
    console.warn('[builder-frame] flush failed:', err)
  }
}
