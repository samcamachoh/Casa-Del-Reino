// Vercel serverless function: reports whether the church's YouTube channel is
// currently live, and the video id to embed if so. Runs server-side (no
// browser CORS limits).
//
// YouTube login-walls its watch pages for datacenter IPs like Vercel's
// (playabilityStatus LOGIN_REQUIRED — "sign in to confirm you're not a bot"),
// observed in production during a real broadcast. So this checks up to three
// sources, most reliable first:
//
//   1. YouTube Data API (only if a YOUTUBE_API_KEY env var is set in Vercel):
//      recent video ids come from the channel's public RSS feed (free, works
//      from Vercel — it's how the sermons feed loads), then one videos.list
//      call (1 quota unit) checks whether any of them is live right now.
//      Authoritative and immune to the bot wall. A free key covers this
//      easily: 1 unit/poll ≈ 3k/day vs the 10k/day free quota.
//   2. The /embed/live_stream page: embeds are served to anonymous contexts
//      everywhere, so they're far less likely to be login-walled than watch
//      pages.
//   3. The /channel/<id>/live watch page (original approach — works when
//      YouTube doesn't bot-wall the request).
//
// Every probe requires a genuine positive signal (isLive/isLiveNow actually
// true) before reporting live — never an absence of a "not live" marker.
// An earlier version guessed "live" whenever the embed page merely
// mentioned *a* video id without spotting an explicit offline marker; in
// production that showed the site as permanently live because the embed
// pointed at the channel's last-ended broadcast with no such marker on the
// page. Without an API key, detection is deliberately conservative: it may
// occasionally miss a broadcast rather than risk showing "live" when the
// channel is actually offline.
//
// Diagnostics: open /api/livestream?debug=1 to see what every probe found.

const CHANNEL_ID = 'UCnmH19dzWxrnHigDRzhE0ZQ';
const LIVE_URL = 'https://www.youtube.com/channel/' + CHANNEL_ID + '/live';
const EMBED_URL = 'https://www.youtube.com/embed/live_stream?channel=' + CHANNEL_ID;
const FEED_URL = 'https://www.youtube.com/feeds/videos.xml?channel_id=' + CHANNEL_ID;

function redactKey(text, apiKey) {
  return apiKey ? text.split(apiKey).join('[redacted]') : text;
}

function fetchWithTimeout(url, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(function () { ctrl.abort(); }, ms);
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
// respecting braces inside string literals. The page has many other
// "videoId"/"isLive" fields scattered around (sidebar, related videos), so
// videoId and isLive must be read from the same parsed object — independent
// page-wide regexes once showed the live badge for one video while embedding
// a different one.
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

function parsePlayerResponse(html) {
  const raw = extractJsonAfter(html, 'var ytInitialPlayerResponse =')
    || extractJsonAfter(html, '"ytInitialPlayerResponse":');
  if (!raw) return { found: false };
  try {
    const pr = JSON.parse(raw) || {};
    return {
      found: true,
      videoDetails: pr.videoDetails || null,
      microformat: (pr.microformat && pr.microformat.playerMicroformatRenderer) || null,
      playabilityStatus: (pr.playabilityStatus && pr.playabilityStatus.status) || null
    };
  } catch (e) {
    return { found: true, parseError: String((e && e.message) || e) };
  }
}

// Probe 1: the live_stream embed page. Embeds are served to anonymous
// contexts everywhere, so they're far less likely to be login-walled than
// watch pages. The page describes only this channel's current/upcoming
// broadcast — there's no sidebar noise — but its exact shape varies: some
// variants inline ytInitialPlayerResponse, others only carry an escaped
// "video_id" in the player config and fetch the player response at runtime.
//
// Only a genuine positive signal (videoDetails.isLive) counts as live here.
// Earlier this also guessed "live" from finding *a* video id with no
// "LIVE_STREAM_OFFLINE" string nearby — that's an absence-based guess, and
// a real false positive: the embed can point at the channel's last-ended
// broadcast without that exact string appearing, which read as permanently
// live. A candidate id with no confirmed isLive is still returned so the
// API probe (proper source of truth) can verify it — it must never be
// trusted on its own.
async function checkViaEmbed(dbg) {
  try {
    const r = await fetchWithTimeout(EMBED_URL, 7000);
    dbg.embedStatus = r.status;
    const html = await r.text();
    const pr = parsePlayerResponse(html);
    dbg.embedFoundPlayerResponse = !!pr.found;
    dbg.embedPlayability = pr.playabilityStatus || null;

    const vd = pr.videoDetails;
    let candidateId = (vd && vd.videoId) || null;
    if (!candidateId) {
      const m = html.match(/\\?"video_?[iI]d\\?"\s*:\s*\\?"([\w-]{6,20})\\?"/);
      candidateId = m ? m[1] : null;
    }
    dbg.embedCandidateId = candidateId;

    if (vd && vd.isLive && vd.videoId) return { isLive: true, videoId: vd.videoId, candidateId: candidateId };
    return { isLive: false, candidateId: candidateId };
  } catch (e) {
    dbg.embedError = (e && e.name === 'AbortError') ? 'timeout' : String((e && e.message) || e);
    return { isLive: false, candidateId: null };
  }
}

// Probe 2: YouTube Data API (when a key is configured). Checks the videos
// listed in the channel's RSS feed plus the embed page's candidate id, via
// one videos.list call (1 quota unit). A "live" answer is always final. A
// "not live" answer is only final when the candidate id was part of the
// checked set — the RSS feed can lag a just-started stream by a few
// minutes, so RSS-only silence must not overrule the scraping probes.
async function checkViaApi(apiKey, candidateId, dbg) {
  try {
    const ids = [];
    if (candidateId) ids.push(candidateId);
    const rss = await fetchWithTimeout(FEED_URL, 7000);
    dbg.rssStatus = rss.status;
    if (rss.ok) {
      const xml = await rss.text();
      const re = /<yt:videoId>([\w-]+)<\/yt:videoId>/g;
      let m;
      while ((m = re.exec(xml)) && ids.length < 15) {
        if (ids.indexOf(m[1]) === -1) ids.push(m[1]);
      }
    }
    dbg.apiIdsChecked = ids.length;
    if (!ids.length) return { checked: false, coversCandidate: false };

    const url = 'https://www.googleapis.com/youtube/v3/videos?part=snippet&id='
      + encodeURIComponent(ids.join(',')) + '&key=' + encodeURIComponent(apiKey);
    const r = await fetchWithTimeout(url, 7000);
    dbg.apiStatus = r.status;
    if (!r.ok) return { checked: false, coversCandidate: false };
    const data = await r.json();
    const items = data.items || [];
    dbg.apiItems = items.length;
    const liveItem = items.find(function (v) { return v.snippet && v.snippet.liveBroadcastContent === 'live'; });
    // "Covers candidate" must mean the API actually returned an item for the
    // candidate id — not merely that we asked about it. A brand-new live
    // video can lag YouTube's Data API index for a bit, so videos.list can
    // silently omit it from `items` even though it's genuinely live right
    // now. Treating a request-only match as coverage would let that gap
    // report a false "final not live" and skip the fallback probes below —
    // exactly the case where the embed/live-page scrape is still needed.
    const coversCandidate = !!candidateId && items.some(function (v) { return v.id === candidateId; });
    return {
      checked: true,
      coversCandidate: coversCandidate,
      isLive: !!liveItem,
      videoId: liveItem ? liveItem.id : null
    };
  } catch (e) {
    // Never let the raw error surface the key: some fetch failures (e.g. a
    // malformed URL) put the full request URL — key included — in
    // e.message, and this ends up in the public, unauthenticated
    // ?debug=1 response.
    dbg.apiError = (e && e.name === 'AbortError')
      ? 'timeout'
      : redactKey(String((e && e.message) || e), apiKey);
    return { checked: false, coversCandidate: false };
  }
}

// Probe 3: the /live watch page (original approach).
async function checkViaLivePage(dbg) {
  try {
    const r = await fetchWithTimeout(LIVE_URL, 7000);
    const html = await r.text();
    dbg.liveStatus = r.status;
    dbg.liveConsentWall = r.url.indexOf('consent.youtube.com') !== -1 || html.indexOf('consent.youtube.com/m?') !== -1;
    const pr = parsePlayerResponse(html);
    dbg.liveFoundPlayerResponse = !!pr.found;
    dbg.livePlayability = pr.playabilityStatus || null;

    const vd = pr.videoDetails, mf = pr.microformat;
    // Fallbacks for bot-stripped pages: the canonical link points at
    // watch?v= only when a broadcast exists, and "isLiveNow":true only ever
    // appears for the page's primary video.
    const canonicalMatch = html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([\w-]{6,20})"/);
    const canonicalVideoId = canonicalMatch ? canonicalMatch[1] : null;
    const isLiveNowInHtml = /"isLiveNow"\s*:\s*true/.test(html);
    dbg.liveCanonicalVideoId = canonicalVideoId;
    dbg.liveIsLiveNowInHtml = isLiveNowInHtml;

    if (vd && vd.isLive && vd.videoId) return { isLive: true, videoId: vd.videoId };
    if (mf && mf.liveBroadcastDetails && mf.liveBroadcastDetails.isLiveNow) {
      const mfId = (vd && vd.videoId) || canonicalVideoId;
      if (mfId) return { isLive: true, videoId: mfId };
    }
    if (canonicalVideoId && isLiveNowInHtml) return { isLive: true, videoId: canonicalVideoId };
    return { isLive: false };
  } catch (e) {
    dbg.liveError = (e && e.name === 'AbortError') ? 'timeout' : String((e && e.message) || e);
    return { isLive: false };
  }
}

module.exports = async function handler(req, res) {
  const q = req.query || {};
  const debug = q.debug === '1' || q.debug === 'true';

  const dbg = {};
  let isLive = false, videoId = null, signal = null;

  // Embed probe runs first: cheap, rarely login-walled, and it supplies a
  // candidate video id for the API to verify.
  const viaEmbed = await checkViaEmbed(dbg);

  const apiKey = process.env.YOUTUBE_API_KEY;
  dbg.apiKeyConfigured = !!apiKey;
  if (apiKey) {
    const viaApi = await checkViaApi(apiKey, viaEmbed.candidateId, dbg);
    if (viaApi.checked && viaApi.isLive) {
      isLive = true; videoId = viaApi.videoId; signal = 'api';
    } else if (viaApi.checked && viaApi.coversCandidate) {
      // The API explicitly checked the embed's candidate and it isn't live —
      // final "not live", overriding the scraping heuristics.
      signal = 'api';
    }
    // API said "not live" from RSS ids alone (or the call failed): not
    // conclusive — the feed lags just-started streams — keep probing.
  }

  if (signal === null && viaEmbed.isLive) {
    isLive = true; videoId = viaEmbed.videoId; signal = 'embed';
  }

  if (signal === null) {
    const viaLive = await checkViaLivePage(dbg);
    if (viaLive.isLive) { isLive = true; videoId = viaLive.videoId; signal = 'livepage'; }
  }

  res.setHeader('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=60');

  if (debug) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(Object.assign({
      channelId: CHANNEL_ID,
      live: isLive,
      videoId: videoId,
      signal: signal
    }, dbg));
  }

  return res.status(200).json({ live: isLive, videoId: videoId });
};
