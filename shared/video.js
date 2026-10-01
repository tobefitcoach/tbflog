// ==========================================================================
// shared/video.js - YouTube helpers for exercise and stretch videos.
// Accepts watch?v=, shorts/, embed/ and youtu.be/ links.
// ==========================================================================

const YOUTUBE_ID = /(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/

// Thumbnail image URL for a YouTube link, or null if it isn't one
export function getYouTubeThumbnail(url) {
  if (!url) return null
  const match = url.match(YOUTUBE_ID)
  return match ? `https://img.youtube.com/vi/${match[1]}/mqdefault.jpg` : null
}

// Autoplaying embed URL for a YouTube link, or null if it isn't one
export function getYouTubeEmbedUrl(url) {
  if (!url) return null
  const match = url.match(YOUTUBE_ID)
  return match ? `https://www.youtube.com/embed/${match[1]}?autoplay=1` : null
}
