// ==========================================================================
// PUSH NOTIFICATIONS (shared by both the coach app and the athlete app)
// Thin wrapper around the browser's Push API - registers the one shared
// service worker (sw.js, at the repo root so its scope covers everything
// including /athlete-app/) and reads/writes push_subscriptions. Takes the
// caller's own Supabase client + user id as parameters rather than
// importing a client itself, since the coach app (coachClient.js) and the
// athlete app (athleteClient.js) each have their own. customAlert is a
// global (see confirm-modal.js), already loaded on every page before this
// runs.
// ==========================================================================

// Public key only - the matching private key lives in the send-push Edge
// Function's VAPID_PRIVATE_KEY secret, never shipped to the browser.
const VAPID_PUBLIC_KEY = 'BE9WSRB8zBbkjKEBJlGF9cIVRN-Mn9fOg8XvP9hVFl1Zb2AOZKczpnc6P9aMNQ55MwbMRAj2ILeJQqYOMQhYvOg'

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  const output = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i)
  return output
}

// iOS Safari only supports Web Push once the site's been added to the Home
// Screen and is running installed (display-mode: standalone) - Apple's own
// restriction, nothing this app can route around. Detected so enablePush()
// can show a plain-language instruction instead of failing silently.
function isIosNotInstalled() {
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent)
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true
  return isIos && !isStandalone
}

// "sw.js" resolves relative to the CURRENT page, so it's a different
// absolute URL depending on whether the page lives at the repo root or in
// /athlete-app/ - but since both paths point at the same file living at
// the repo root, the service worker's scope still ends up covering the
// whole site either way (a service worker's default scope is the directory
// IT lives in, not the page that registered it).
function registerServiceWorker() {
  const path = window.location.pathname.includes('/athlete-app/') ? '../sw.js' : 'sw.js'
  return navigator.serviceWorker.register(path)
}

export async function pushStatus() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return 'unsupported'
  if (Notification.permission === 'denied') return 'denied'
  const registration = await navigator.serviceWorker.getRegistration()
  const existing = registration ? await registration.pushManager.getSubscription() : null
  return existing ? 'on' : 'off'
}

export async function enablePush(supabase, userId) {
  if (isIosNotInstalled()) {
    customAlert('On iPhone, first add TBFlog to your Home Screen (Share button → Add to Home Screen), then open it from there and try again.')
    return false
  }
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    customAlert("This browser doesn't support push notifications.")
    return false
  }

  const permission = await Notification.requestPermission()
  if (permission !== 'granted') {
    customAlert('Notifications permission was not granted.')
    return false
  }

  const registration = await registerServiceWorker()
  await navigator.serviceWorker.ready
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
  })

  const json = subscription.toJSON()
  const { error } = await supabase.from('push_subscriptions').upsert({
    user_id: userId,
    endpoint: json.endpoint,
    p256dh: json.keys.p256dh,
    auth_key: json.keys.auth
  }, { onConflict: 'endpoint' })

  if (error) { console.log(error); customAlert('Something went wrong turning on notifications - try again'); return false }
  return true
}

export async function disablePush(supabase) {
  const registration = await navigator.serviceWorker.getRegistration()
  const subscription = registration ? await registration.pushManager.getSubscription() : null
  if (!subscription) return true

  const endpoint = subscription.endpoint
  await subscription.unsubscribe()
  const { error } = await supabase.from('push_subscriptions').delete().eq('endpoint', endpoint)
  if (error) console.log(error)
  return true
}

// Fire-and-forget helper for the two features that actually send a push
// (notifyCoach in dashboard.js, the coach's "push" message timing in
// script.js) - both already never await their own notification calls, so
// this matches that convention. url should already be absolute (built with
// `new URL(path, window.location.href).href`) since the service worker has
// no page context of its own to resolve a relative one against.
export async function sendPush(supabase, userId, title, body, url) {
  const { error } = await supabase.functions.invoke('send-push', {
    body: { user_id: userId, title, body, url }
  })
  if (error) console.log(error)
}
