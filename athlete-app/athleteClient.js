// ==========================================================================
// ATHLETE SUPABASE CLIENT
// Used by every athlete-facing page (index.html/dashboard.html + app.js).
// storageKey keeps this session separate from the coach app's session -
// without it, being logged into one could accidentally log you into the
// other, since both apps share the same browser origin by default.
// ==========================================================================
// Pinned to a specific version (not "latest") so the browser can actually
// cache this long-term instead of re-resolving/re-downloading it on every
// visit - jsdelivr only sets a far-future cache header on versioned URLs
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.112.0/+esm'
import { supabaseUrl, supabaseKey } from '../supabaseClient.js'

// Captured before createClient() below kicks off its own (async) token
// detection, which strips `type=magiclink` etc. out of the URL hash once it
// processes it - reading it first, synchronously, is what makes this
// reliable. Used by dashboard.js to show a one-time "set a password" prompt
// right after an athlete arrives via an invite email.
export const arrivedViaMagicLink = window.location.hash.includes('type=magiclink')

export const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { storageKey: 'tbflog-athlete-auth' }
})
