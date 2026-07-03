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
  // A realistic browser UA matters: YouTube serves bot-looking clients a
  // stripped player response with no videoDetails, which reads as "not live".
  return fetch(url, {
    signal: ctrl.signal,
    redirect: 'follow',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
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

  // YouTube sometimes serves a cookie-consent interstitial instead of the
  // actual page to server-side/datacenter requests (common for EU-flagged
  // IPs, which Vercel's serverless regions can be). If that happens, none
  // of the expected page data is present at all — worth surfacing directly
  // rather than just looking like "not live".
  const consentWall = r.url.indexOf('consent.youtube.com') !== -1 || html.indexOf('consent.youtube.com/m?') !== -1;
  const titleMatch = html.match(/<title>([^<]*)<\/title>/);

  // YouTube's live watch page embeds the primary video's player response as
  // a single JSON object (ytInitialPlayerResponse). videoDetails.isLive is
  // true only while that specific video is actively streaming — unlike
  // isLiveContent, which stays true forever on past-broadcast VODs too.
  const raw = extractJsonAfter(html, 'var ytInitialPlayerResponse =')
    || extractJsonAfter(html, '"ytInitialPlayerResponse":');
  let parseError = null, playerResponse = null, videoDetails = null, microformat = null;
  if (raw) {
    try {
      playerResponse = JSON.parse(raw) || {};
      videoDetails = playerResponse.videoDetails || null;
      microformat = (playerResponse.microformat && playerResponse.microformat.playerMicroformatRenderer) || null;
    } catch (e) {
      parseError = String((e && e.message) || e);
    }
  }

  // Fallback signals for when YouTube strips videoDetails out of the player
  // response for datacenter IPs (its bot heuristic — observed in production:
  // 1MB of page HTML, player response present, but no videoDetails in it).
  // The /live page's canonical link points at watch?v=<id> only when the
  // channel has a current or upcoming broadcast (it points at the channel
  // page otherwise), and "isLiveNow":true only ever appears inside the
  // primary video's liveBroadcastDetails — never in sidebar/related data —
  // so requiring BOTH keeps the earlier wrong-video bug fixed while
  // surviving stripped pages. A scheduled-but-not-started stream has the
  // canonical watch link but isLiveNow false, so it stays "not live".
  const canonicalMatch = html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([\w-]{6,20})"/);
  const canonicalVideoId = canonicalMatch ? canonicalMatch[1] : null;
  const isLiveNowInHtml = /"isLiveNow"\s*:\s*true/.test(html);

  let isLive = false, videoId = null, signal = null;
  if (videoDetails && videoDetails.isLive && videoDetails.videoId) {
    isLive = true; videoId = videoDetails.videoId; signal = 'videoDetails';
  } else if (microformat && microformat.liveBroadcastDetails && microformat.liveBroadcastDetails.isLiveNow) {
    const mfId = (videoDetails && videoDetails.videoId) || canonicalVideoId;
    if (mfId) { isLive = true; videoId = mfId; signal = 'microformat'; }
  } else if (canonicalVideoId && isLiveNowInHtml) {
    isLive = true; videoId = canonicalVideoId; signal = 'canonical';
  }

  return {
    status: r.status,
    finalUrl: r.url,
    htmlLength: html.length,
    consentWall: consentWall,
    pageTitle: titleMatch ? titleMatch[1] : null,
    isLive: isLive,
    videoId: videoId,
    signal: signal,
    foundPlayerResponse: !!raw,
    parseError: parseError,
    videoDetailsFound: !!videoDetails,
    playabilityStatus: (playerResponse && playerResponse.playabilityStatus && playerResponse.playabilityStatus.status) || null,
    canonicalVideoId: canonicalVideoId,
    isLiveNowInHtml: isLiveNowInHtml,
    rawIsLive: videoDetails ? !!videoDetails.isLive : null,
    rawIsLiveContent: videoDetails ? !!videoDetails.isLiveContent : null,
    rawVideoId: videoDetails ? videoDetails.videoId || null : null
  };
}

module.exports = async function handler(req, res) {
  const q = req.query || {};
  const debug = q.debug === '1' || q.debug === 'true';

  let result = {
    status: 0, isLive: false, videoId: null, error: null, signal: null,
    finalUrl: null, htmlLength: 0, consentWall: false, pageTitle: null,
    foundPlayerResponse: false, parseError: null, videoDetailsFound: false,
    playabilityStatus: null, canonicalVideoId: null, isLiveNowInHtml: false,
    rawIsLive: null, rawIsLiveContent: null, rawVideoId: null
  };
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
      finalUrl: result.finalUrl,
      htmlLength: result.htmlLength,
      consentWall: result.consentWall,
      pageTitle: result.pageTitle,
      error: result.error,
      foundPlayerResponse: result.foundPlayerResponse,
      parseError: result.parseError,
      videoDetailsFound: result.videoDetailsFound,
      playabilityStatus: result.playabilityStatus,
      canonicalVideoId: result.canonicalVideoId,
      isLiveNowInHtml: result.isLiveNowInHtml,
      signal: result.signal,
      rawIsLive: result.rawIsLive,
      rawIsLiveContent: result.rawIsLiveContent,
      rawVideoId: result.rawVideoId,
      live: result.isLive,
      videoId: result.videoId
    });
  }

  return res.status(200).json({ live: result.isLive, videoId: result.videoId });
};
