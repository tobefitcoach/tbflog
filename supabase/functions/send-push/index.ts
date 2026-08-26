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

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
)

Deno.serve(async (req) => {
  try {
    const { user_id, title, body, url } = await req.json()
    if (!user_id || !title) {
      return new Response(JSON.stringify({ error: 'user_id and title are required' }), { status: 400 })
    }

    const { data: subs, error } = await supabase
      .from('push_subscriptions')
      .select('*')
      .eq('user_id', user_id)

    if (error) {
      return new Response(JSON.stringify({ error: error.message }), { status: 500 })
    }

    await Promise.all((subs || []).map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth_key } },
          JSON.stringify({ title, body, url })
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

    return new Response(JSON.stringify({ sent: (subs || []).length }), { status: 200 })
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 })
  }
})
