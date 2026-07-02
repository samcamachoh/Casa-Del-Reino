// Vercel serverless function: reports whether the church's YouTube channel is
// currently live, and the video id to embed if so. Runs server-side (no
// browser CORS limits, no API key/quota needed) by reading YouTube's public
// /live page, the same way a browser redirect would.
//
// Diagnostics: open /api/livestream?debug=1 to see exactly what the server
// found (upstream status, whether a live signal was detected, the raw match).

const CHANNEL_ID = 'UCnmH19dzWxrnHigDRzhE0ZQ';
const LIVE_URL = 'https://www.youtube.com/channel/' + CHANNEL_ID + '/live';

function fetchWithTimeout(url, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(function () { ctrl.abort(); }, ms);
  return fetch(url, {
    signal: ctrl.signal,
    redirect: 'follow',
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; CasaDelReinoSite/1.0; +https://casadelreino.com)',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9'
    }
  }).finally(function () { clearTimeout(t); });
}

// Extracts a balanced {...} JSON object that starts right after `marker`,
// respecting braces inside string literals. Needed because the page has
// many other "videoId"/"isLive" fields scattered around (sidebar, related
// videos, ads) — grabbing those with unscoped regexes was the bug: the
// live badge could fire off an unrelated video's "isLive":true while the
// videoId grabbed was the *first* one in the whole page, i.e. a different,
// unrelated video. Reading videoId and isLive from the same parsed object
// guarantees they describe the same video.
function extractJsonAfter(html, marker) {
  const markerIdx = html.indexOf(marker);
  if (markerIdx === -1) return null;
  const start = html.indexOf('{', markerIdx);
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return html.slice(start, i + 1);
    }
  }
  return null;
}

async function checkLive() {
  const r = await fetchWithTimeout(LIVE_URL, 7000);
  const html = await r.text();

  // YouTube's live watch page embeds the primary video's player response as
  // a single JSON object (ytInitialPlayerResponse). videoDetails.isLive is
  // true only while that specific video is actively streaming — unlike
  // isLiveContent, which stays true forever on past-broadcast VODs too.
  const raw = extractJsonAfter(html, 'var ytInitialPlayerResponse =')
    || extractJsonAfter(html, '"ytInitialPlayerResponse":');
  let parseError = null, videoDetails = null;
  if (raw) {
    try {
      videoDetails = (JSON.parse(raw) || {}).videoDetails || null;
    } catch (e) {
      parseError = String((e && e.message) || e);
    }
  }

  const isLive = !!(videoDetails && videoDetails.isLive && videoDetails.videoId);
  return {
    status: r.status,
    isLive: isLive,
    videoId: isLive ? videoDetails.videoId : null,
    foundPlayerResponse: !!raw,
    parseError: parseError
  };
}

module.exports = async function handler(req, res) {
  const q = req.query || {};
  const debug = q.debug === '1' || q.debug === 'true';

  let result = { status: 0, isLive: false, videoId: null, error: null, foundPlayerResponse: false, parseError: null };
  try {
    result = Object.assign(result, await checkLive());
  } catch (e) {
    result.error = (e && e.name === 'AbortError') ? 'timeout' : String((e && e.message) || e);
  }

  res.setHeader('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=60');

  if (debug) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      channelId: CHANNEL_ID,
      upstreamStatus: result.status,
      error: result.error,
      foundPlayerResponse: result.foundPlayerResponse,
      parseError: result.parseError,
      live: result.isLive,
      videoId: result.videoId
    });
  }

  return res.status(200).json({ live: result.isLive, videoId: result.videoId });
};
