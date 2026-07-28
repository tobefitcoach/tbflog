// ==========================================================================
// ATHLETE SUPABASE CLIENT
// Used by every athlete-facing page (index.html/dashboard.html + app.js).
// storageKey keeps this session separate from the coach app's session -
// without it, being logged into one could accidentally log you into the
// other, since both apps share the same browser origin by default.
// ==========================================================================
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm'
import { supabaseUrl, supabaseKey } from '../supabaseClient.js'

export const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { storageKey: 'tbflog-athlete-auth' }
})
