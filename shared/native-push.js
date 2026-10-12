// ==========================================================================
// NATIVE PUSH (the App Store / Play Store app only - both apps use this)
// Inside the native app the browser's Push API doesn't exist (see push.js
// for the website version). Instead the phone gets a device token from
// Apple through Capacitor's PushNotifications plugin; this saves it with
// claim_push_token() (db/changes/0003), and the send-push Edge Function
// sends to it alongside browser subscriptions. Tapping a notification opens
// the link it carries (a chat, an athlete, ...).
//
// On the website, and in an older app build without the plugin,
// nativePush() returns null and everything here does nothing.
//
// iPhone only for now: Android needs a Firebase project before it can
// receive anything, and asking it to register without one would only fail.
// ==========================================================================

const TOKEN_KEY = 'tbflog-device-push-token' // this phone's token, for log-out

export function nativePush() {
  const cap = window.Capacitor
  if (!cap?.isNativePlatform?.() || cap.getPlatform?.() !== 'ios') return null
  if (!cap.isPluginAvailable?.('PushNotifications')) return null
  return cap.Plugins.PushNotifications
}

// 'granted' | 'denied' | 'prompt' (not asked yet), or null when unavailable.
// The same permission also covers the on-device rest-timer alerts.
export async function nativePushPermission() {
  const push = nativePush()
  if (!push) return null
  try {
    const { receive } = await push.checkPermissions()
    return receive === 'prompt-with-rationale' ? 'prompt' : receive
  } catch (err) {
    console.log('Error checking notification permission:', err)
    return null
  }
}

let listening = false

function listen(supabase) {
  if (listening) return
  listening = true
  const push = nativePush()

  push.addListener('registration', async function({ value }) {
    try { localStorage.setItem(TOKEN_KEY, value) } catch (e) { /* storage blocked - log-out just can't forget it */ }
    const { error } = await supabase.rpc('claim_push_token', { p_token: value, p_platform: 'ios' })
    if (error) console.log('Error saving push token:', error)
  })

  push.addListener('registrationError', function(err) {
    console.log('Push registration failed:', err)
  })

  // Tapped a notification: go where it points, if it's this app's own site
  push.addListener('pushNotificationActionPerformed', function(action) {
    const url = action?.notification?.data?.url
    if (!url) return
    try {
      if (new URL(url).origin === window.location.origin) window.location.href = url
    } catch (e) { /* not a link - stay put */ }
  })
}

// Call once the user is known. Registers this phone if notifications are
// already allowed; never shows the permission question itself.
export async function startNativePush(supabase) {
  const push = nativePush()
  if (!push) return
  listen(supabase)
  if (await nativePushPermission() === 'granted') {
    try { await push.register() } catch (err) { console.log('Push register failed:', err) }
  }
}

// Shows the phone's "Allow notifications?" question (asked once by the
// phone; after a "Don't Allow" it can only be changed in the phone's
// Settings) and registers if allowed. Returns the resulting permission.
export async function askForNativePush(supabase) {
  const push = nativePush()
  if (!push) return null
  listen(supabase)
  try {
    const { receive } = await push.requestPermissions()
    if (receive === 'granted') await push.register()
    return receive
  } catch (err) {
    console.log('Error asking for notification permission:', err)
    return null
  }
}

// Asks once, the first time the app opens after this feature arrives, with
// a short explanation first - a cold system prompt gets "Don't Allow" far
// more often. confirmFn is the app's own confirm popup.
const ASKED_KEY = 'tbflog-push-asked'

export async function offerNativePush(supabase, message, confirmFn) {
  if (!nativePush()) return
  if (await nativePushPermission() !== 'prompt') return
  try {
    if (localStorage.getItem(ASKED_KEY)) return
    localStorage.setItem(ASKED_KEY, '1')
  } catch (e) { return }
  if (await confirmFn(message)) await askForNativePush(supabase)
}

// Log-out: stop this phone getting the signed-out person's notifications.
// Best effort and quick - log-out must never hang on it.
export async function forgetThisDevice(supabase) {
  let token = null
  try { token = localStorage.getItem(TOKEN_KEY) } catch (e) { return }
  if (!token) return
  try {
    await Promise.race([
      supabase.from('device_push_tokens').delete().eq('token', token),
      new Promise(resolve => setTimeout(resolve, 2000))
    ])
  } catch (err) {
    console.log('Error forgetting push token:', err)
  }
  try { localStorage.removeItem(TOKEN_KEY) } catch (e) { /* nothing to forget */ }
}
