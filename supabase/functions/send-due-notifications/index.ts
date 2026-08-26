// ==========================================================================
// send-due-notifications (Supabase Edge Function)
// Unlike send-push (which fires the moment something happens, e.g. a chat
// message), this one is never called directly by the app. It runs on a
// SCHEDULE - every minute, via Supabase's Cron Jobs feature - and each
// time it runs, it checks the scheduled_notifications table for any row
// whose fire_at time has already passed, sends each of those as a real
// push (same webpush call send-push uses), then deletes the row.
//
// Built for the rest timer: when an athlete starts resting between sets,
// the app writes a row here for "now + rest length". If they're still on
// the page when the countdown hits zero, the app cancels that row itself
// (a local beep/vibration already told them). If they've switched to
// another app (e.g. Instagram) and never come back to cancel it, this
// cron job is what actually sends the push - it doesn't depend on their
// browser tab still running at all.
//
// SETUP (do this once, after deploying this function - see the numbered
// steps at the bottom of this comment):
// 1. Deploy this file the same manual way as send-push (paste into
//    Supabase Dashboard -> Edge Functions -> Deploy a new function -> Via
//    Editor, name it "send-due-notifications"). No new secret needed - it
//    reuses the VAPID_PRIVATE_KEY already set for send-push.
// 2. In the Supabase Dashboard, go to Database -> Cron Jobs (enable the
//    pg_cron/pg_net extensions first if that section isn't visible yet -
//    Database -> Extensions).
// 3. Create a new job: any name, schedule "* * * * *" (every minute - the
//    finest interval a normal cron schedule supports, so a rest timer's
//    push can arrive up to ~1 minute after it actually ends, not
//    instantly), type "Supabase Edge Function", pointing at
//    send-due-notifications. The dashboard handles authenticating the
//    call for you - no separate secret to copy in.
// ==========================================================================
// @ts-nocheck - this runs on Deno (Supabase Edge Functions), not Node, so
// VS Code's normal TypeScript checker doesn't understand it (Deno global,
// npm: imports) and flags false errors. Real syntax checking happens when
// Supabase deploys it.
import webpush from 'npm:web-push@3.6.7'
import { createClient } from 'npm:@supabase/supabase-js@2'

// Same VAPID keys as send-push - both functions push to the same browsers,
// so they have to identify themselves with the same key pair.
const VAPID_PUBLIC_KEY = 'BE9WSRB8zBbkjKEBJlGF9cIVRN-Mn9fOg8XvP9hVFl1Zb2AOZKczpnc6P9aMNQ55MwbMRAj2ILeJQqYOMQhYvOg'
const VAPID_PRIVATE_KEY = Deno.env.get('VAPID_PRIVATE_KEY')!

webpush.setVapidDetails('mailto:tobefitcoach@gmail.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY)

// Service role key, not the caller's own permissions - a cron job has no
// logged-in user, so it has to read every athlete/coach's due rows at
// once, which normal Row Level Security would never allow.
const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
)

// If a row's fire_at is further in the past than this, something went
// wrong upstream (the cron job stopped running for a while, etc.) - rather
// than send a push that's confusingly late, it's just deleted unsent.
const STALE_AFTER_MS = 15 * 60 * 1000

Deno.serve(async (_req) => {
  try {
    const { data: due, error } = await supabase
      .from('scheduled_notifications')
      .select('*')
      .lte('fire_at', new Date().toISOString())

    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 })
    if (!due || due.length === 0) return new Response(JSON.stringify({ sent: 0 }), { status: 200 })

    let sent = 0

    await Promise.all(due.map(async (row) => {
      const isStale = Date.now() - new Date(row.fire_at).getTime() > STALE_AFTER_MS

      if (!isStale) {
        const { data: subs } = await supabase.from('push_subscriptions').select('*').eq('user_id', row.user_id)

        await Promise.all((subs || []).map(async (sub) => {
          try {
            await webpush.sendNotification(
              { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth_key } },
              JSON.stringify({ title: row.title, body: row.body, url: row.url })
            )
            sent++
          } catch (err) {
            // 404/410 = the browser revoked this subscription (uninstalled,
            // permission pulled, etc.) - clean it up instead of retrying it
            // forever on every future scheduled push too
            if (err.statusCode === 404 || err.statusCode === 410) {
              await supabase.from('push_subscriptions').delete().eq('id', sub.id)
            } else {
              console.log('push send failed', sub.id, err.message)
            }
          }
        }))
      }

      // Always removed once handled - this table is a queue, not a log, so
      // a sent (or stale, or subscription-less) row never lingers
      await supabase.from('scheduled_notifications').delete().eq('id', row.id)
    }))

    return new Response(JSON.stringify({ sent }), { status: 200 })
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 })
  }
})
