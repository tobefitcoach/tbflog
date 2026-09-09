// ==========================================================================
// delete-account (Supabase Edge Function)
// Permanently deletes the CALLING user's account and every row belonging to
// it. Required by App Store Review Guideline 5.1.1(v) - any app that lets
// users create an account must let them delete it from inside the app - and
// by GDPR's right to erasure. Called from the client via
// supabase.functions.invoke('delete-account') - see the Delete Account
// button in renderProfile() in athlete-app/dashboard.js.
//
// SECURITY - the important difference from send-push: that function takes a
// user_id from the request body, which is fine there because it only sends a
// notification. Here that would let anyone delete anyone's account by
// posting someone else's id. So this function IGNORES the body entirely and
// derives the user from the caller's own JWT. The service role key is used
// only AFTER the token has been verified, and only for that verified id.
//
// This file is kept here for version history only - it isn't deployed by a
// CLI. Deploy it by pasting this file's contents into the Supabase
// Dashboard: Edge Functions -> Deploy a new function -> Via Editor, name it
// "delete-account". It needs no extra secrets (SUPABASE_URL and
// SUPABASE_SERVICE_ROLE_KEY are provided automatically).
// ==========================================================================
// @ts-nocheck - runs on Deno (Supabase Edge Functions), not Node, so VS
// Code's TypeScript checker flags false errors on the Deno global and npm:
// imports. Real checking happens when Supabase deploys it.
import { createClient } from 'npm:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const authHeader = req.headers.get('Authorization') || ''
    const token = authHeader.replace('Bearer ', '').trim()
    if (!token) return json({ error: 'Not signed in' }, 401)

    // Verify the token by asking the auth server who it belongs to. A forged
    // or expired token fails here, before anything is deleted.
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)
    const { data: userData, error: userError } = await admin.auth.getUser(token)
    if (userError || !userData?.user) return json({ error: 'Not signed in' }, 401)

    const userId = userData.user.id

    // Coaches own programmes, exercises and forms that their athletes' rows
    // still point at, and most of those foreign keys don't cascade - so
    // deleting a coach this way would either fail on a constraint or strand
    // their athletes' data. Coach deletion needs a different flow (reassign
    // or remove athletes first), so it's refused here rather than half-done.
    const { data: profile } = await admin
      .from('profiles')
      .select('role')
      .eq('id', userId)
      .maybeSingle()

    if (profile?.role === 'coach') {
      return json({ error: 'Coach accounts must be deleted by contacting support.' }, 403)
    }

    // athletes.id is a bigint of its own, separate from the auth user id -
    // nearly every athlete-owned table hangs off that, not off auth.users.
    const { data: athlete } = await admin
      .from('athletes')
      .select('id')
      .eq('user_id', userId)
      .maybeSingle()

    if (athlete) {
      // exercise_logs is the one athlete-owned table whose foreign key has no
      // "on delete cascade", so it would block the athletes row from being
      // deleted. Everything else (exercise_log_sets, workout_sessions,
      // chat_messages, form_assignments, tournaments, stretch preferences,
      // label links) cascades from athletes automatically.
      const { error: logsError } = await admin
        .from('exercise_logs')
        .delete()
        .eq('athlete_id', athlete.id)
      if (logsError) return json({ error: logsError.message }, 500)

      const { error: athleteError } = await admin
        .from('athletes')
        .delete()
        .eq('id', athlete.id)
      if (athleteError) return json({ error: athleteError.message }, 500)
    }

    // Stored under a folder named after the auth user id - storage objects
    // aren't rows, so nothing cascades them.
    await admin.storage.from('athlete-avatars').remove([`${userId}/avatar.jpg`])

    // Deletes the login itself; profiles cascades off auth.users.
    const { error: deleteError } = await admin.auth.admin.deleteUser(userId)
    if (deleteError) return json({ error: deleteError.message }, 500)

    return json({ deleted: true }, 200)
  } catch (err) {
    return json({ error: err.message }, 500)
  }
})
