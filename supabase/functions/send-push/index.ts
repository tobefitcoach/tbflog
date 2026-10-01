// ==========================================================================
// send-push (Supabase Edge Function)
// Looks up every device (push_subscriptions row) for the given user_id and
// sends each one a real Web Push notification. Called from the client via
// supabase.functions.invoke('send-push', { body: { user_id, title, body,
// url } }) - see push.js's sendPush(), used by notifyCoach() in
// athlete-app/dashboard.js and the coach's "push" message timing in
// script.js.
//
// Uses the service role key (auto-provided, no secret to set up) rather
// than the caller's own permissions, since the caller usually isn't the
// intended recipient - e.g. an athlete's own action needs to push to
// THEIR COACH's device, not their own.
//
// SECURITY: because it runs with the service role, it must check the
// caller itself. The public anon key passes Supabase's own JWT check, so
// without this anyone could push any text and link to any user. Rules:
// - the caller is identified from their own JWT, never from the body
// - they may only push to their own athlete (coach -> athlete) or to
//   their own coach (athlete -> coach)
// - the link must be on one of APP_ORIGINS; anything else is dropped (the
//   push still goes out, the service worker just opens the app instead)
//
// This file is kept here for version history only - it isn't deployed by
// a CLI. Deploy it by pasting this file's contents into the Supabase
// Dashboard: Edge Functions -> Deploy a new function -> Via Editor, name
// it "send-push", then set the one secret it needs (VAPID_PRIVATE_KEY) in
// that function's Secrets panel before deploying.
// ==========================================================================
// @ts-nocheck - this runs on Deno (Supabase Edge Functions), not Node, so
// VS Code's normal TypeScript checker doesn't understand it (Deno global,
// npm: imports) and flags false errors. Real syntax checking happens when
// Supabase deploys it.
import webpush from 'npm:web-push@3.6.7'
import { createClient } from 'npm:@supabase/supabase-js@2'

// Public key - safe to hardcode, matches the same constant in push.js.
const VAPID_PUBLIC_KEY = 'BE9WSRB8zBbkjKEBJlGF9cIVRN-Mn9fOg8XvP9hVFl1Zb2AOZKczpnc6P9aMNQ55MwbMRAj2ILeJQqYOMQhYvOg'
const VAPID_PRIVATE_KEY = Deno.env.get('VAPID_PRIVATE_KEY')!

webpush.setVapidDetails('mailto:tobefitcoach@gmail.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY)

// Where notification links may point: the live site, and the local
// preview server used for testing.
const APP_ORIGINS = ['https://tobefitcoach.github.io', 'http://localhost:8000']

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

function safeUrl(url) {
  try {
    return APP_ORIGINS.includes(new URL(url).origin) ? url : null
  } catch {
    return null
  }
}

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
)

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const token = (req.headers.get('Authorization') || '').replace('Bearer ', '').trim()
    const { data: userData } = token ? await supabase.auth.getUser(token) : { data: null }
    const callerId = userData?.user?.id
    if (!callerId) return json({ error: 'Not signed in' }, 401)

    const { user_id, title, body, url } = await req.json()
    if (!user_id || !title) return json({ error: 'user_id and title are required' }, 400)
    // user_id goes into the .or() filter string below, so it must be a
    // plain uuid - anything else could rewrite the filter
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(user_id)) {
      return json({ error: 'Invalid user_id' }, 400)
    }

    // One athletes row links the caller and the recipient, in either
    // direction: caller coaches the recipient, or the recipient coaches
    // the caller.
    const { data: link, error: linkError } = await supabase
      .from('athletes')
      .select('id')
      .or(`and(coach_id.eq.${callerId},user_id.eq.${user_id}),and(user_id.eq.${callerId},coach_id.eq.${user_id})`)
      .limit(1)
    if (linkError) return json({ error: linkError.message }, 500)
    if (!link?.length) return json({ error: 'Not allowed to notify this user' }, 403)

    const { data: subs, error } = await supabase
      .from('push_subscriptions')
      .select('*')
      .eq('user_id', user_id)

    if (error) return json({ error: error.message }, 500)

    await Promise.all((subs || []).map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth_key } },
          JSON.stringify({ title, body, url: safeUrl(url) })
        )
      } catch (err) {
        // 404/410 = the browser revoked this subscription (uninstalled,
        // permission pulled, etc.) - clean it up instead of retrying it
        // forever on every future push
        if (err.statusCode === 404 || err.statusCode === 410) {
          await supabase.from('push_subscriptions').delete().eq('id', sub.id)
        } else {
          console.log('push send failed', sub.id, err.message)
        }
      }
    }))

    return json({ sent: (subs || []).length }, 200)
  } catch (err) {
    return json({ error: err.message }, 500)
  }
})
