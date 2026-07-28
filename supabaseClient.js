// ==========================================================================
// SUPABASE CREDENTIALS
// Just the raw URL/key - not an actual client instance. Both the coach app
// (coachClient.js) and athlete app (athlete-app/athleteClient.js) import
// these and create their OWN client instance, each with its own storage
// key, so a coach session and an athlete session never get mixed up even
// though both apps live on the same domain.
// ==========================================================================
export const supabaseUrl = 'https://szvnaiqlxtlsjgnefunt.supabase.co'
export const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InN6dm5haXFseHRsc2pnbmVmdW50Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMxNTgzMTgsImV4cCI6MjA5ODczNDMxOH0.i0qOHffDnKBVreN1QM7h8tEfHlJgQulwhZ1x4YEAEdU'
