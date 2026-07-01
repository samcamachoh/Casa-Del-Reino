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

async function checkLive() {
  const r = await fetchWithTimeout(LIVE_URL, 7000);
  const html = await r.text();

  // YouTube's live watch page embeds the player response as JSON containing
  // "isLive":true (or "isLiveNow":true) only when a broadcast is actively
  // streaming. When the channel isn't live, /live redirects to the channel
  // home (no isLive flag present at all).
  const isLive = /"isLiveNow"\s*:\s*true/.test(html) || /"isLive"\s*:\s*true/.test(html);
  let videoId = null;
  if (isLive) {
    const m = html.match(/"videoId"\s*:\s*"([^"]+)"/);
    videoId = m ? m[1] : null;
  }
  return { status: r.status, isLive: isLive && !!videoId, videoId: videoId };
}

module.exports = async function handler(req, res) {
  const q = req.query || {};
  const debug = q.debug === '1' || q.debug === 'true';

  let result = { status: 0, isLive: false, videoId: null, error: null };
  try {
    result = Object.assign(result, await checkLive());
  } catch (e) {
    result.error = (e && e.name === 'AbortError') ? 'timeout' : String((e && e.message) || e);
  }

  res.setHeader('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=60');

  if (debug) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ channelId: CHANNEL_ID, upstreamStatus: result.status, error: result.error, live: result.isLive, videoId: result.videoId });
  }

  return res.status(200).json({ live: result.isLive, videoId: result.videoId });
};
