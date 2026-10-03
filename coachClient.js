// ==========================================================================
// COACH SUPABASE CLIENT
// Used by the coach app (coach-app/), login/reset-password and app/index.js.
// storageKey keeps this session separate from the athlete app's session -
// without it, being logged into one could accidentally log you into the other,
// since both apps share the same browser storage by default.
// ==========================================================================
// Pinned to a specific version (not "latest") so the browser can actually
// cache this long-term instead of re-resolving/re-downloading it on every
// visit - jsdelivr only sets a far-future cache header on versioned URLs
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.112.0/+esm'
import { supabaseUrl, supabaseKey } from './supabaseClient.js?v=__V__'

export const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { storageKey: 'tbflog-coach-auth' }
})
