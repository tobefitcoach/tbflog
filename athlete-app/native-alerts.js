// ==========================================================================
// ATHLETE APP - on-device alerts (the App Store / Play Store app only)
// Inside the native app the browser's Web Push doesn't exist, so the rest
// timer's "rest is over" alert is scheduled on the phone itself instead,
// through Capacitor's LocalNotifications plugin. The phone shows it at the
// right moment even if the athlete has switched apps or locked the screen
// - no server involved.
//
// On the website (and in an older app build without the plugin)
// localAlerts() returns null and nothing here does anything.
// ==========================================================================

export function isNativeApp() {
  return !!window.Capacitor?.isNativePlatform?.()
}

export function localAlerts() {
  const cap = window.Capacitor
  if (!cap?.isNativePlatform?.() || !cap.isPluginAvailable?.('LocalNotifications')) return null
  return cap.Plugins.LocalNotifications
}

// 'granted' | 'denied' | 'prompt' (not asked yet), or null when on-device
// alerts aren't available at all
export async function alertPermission() {
  const alerts = localAlerts()
  if (!alerts) return null
  try {
    const { display } = await alerts.checkPermissions()
    return display === 'prompt-with-rationale' ? 'prompt' : display
  } catch (err) {
    console.log('Error checking alert permission:', err)
    return null
  }
}

// Shows the phone's own "Allow notifications?" question - only ever asked
// once by the phone; after a "Don't Allow" it can only be changed in the
// phone's Settings
export async function askForAlerts() {
  const alerts = localAlerts()
  if (!alerts) return null
  try {
    const { display } = await alerts.requestPermissions()
    return display
  } catch (err) {
    console.log('Error asking for alert permission:', err)
    return null
  }
}
