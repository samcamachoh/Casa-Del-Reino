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
// Diagnostics: open /api/livestream?debug=1 to see what every probe found.

const CHANNEL_ID = 'UCnmH19dzWxrnHigDRzhE0ZQ';
const LIVE_URL = 'https://www.youtube.com/channel/' + CHANNEL_ID + '/live';
const EMBED_URL = 'https://www.youtube.com/embed/live_stream?channel=' + CHANNEL_ID;
const FEED_URL = 'https://www.youtube.com/feeds/videos.xml?channel_id=' + CHANNEL_ID;

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

// Probe 1: YouTube Data API. Definitive when a key is configured — returns
// { checked: true, isLive, videoId } on a conclusive answer, or
// { checked: false } to fall through to the scraping probes.
async function checkViaApi(apiKey, dbg) {
  try {
    const rss = await fetchWithTimeout(FEED_URL, 7000);
    dbg.rssStatus = rss.status;
    if (!rss.ok) return { checked: false };
    const xml = await rss.text();
    const ids = [];
    const re = /<yt:videoId>([\w-]+)<\/yt:videoId>/g;
    let m;
    while ((m = re.exec(xml)) && ids.length < 15) ids.push(m[1]);
    dbg.rssIds = ids.length;
    if (!ids.length) return { checked: false };

    const url = 'https://www.googleapis.com/youtube/v3/videos?part=snippet&id=' + ids.join(',') + '&key=' + apiKey;
    const r = await fetchWithTimeout(url, 7000);
    dbg.apiStatus = r.status;
    if (!r.ok) return { checked: false };
    const data = await r.json();
    const items = data.items || [];
    dbg.apiItems = items.length;
    const liveItem = items.find(function (v) { return v.snippet && v.snippet.liveBroadcastContent === 'live'; });
    return { checked: true, isLive: !!liveItem, videoId: liveItem ? liveItem.id : null };
  } catch (e) {
    dbg.apiError = (e && e.name === 'AbortError') ? 'timeout' : String((e && e.message) || e);
    return { checked: false };
  }
}

// Probe 2: the live_stream embed page. Its player response describes only
// the channel's current/upcoming broadcast (no sidebar noise). isLive is
// true only while actually streaming — an upcoming scheduled stream has
// playabilityStatus LIVE_STREAM_OFFLINE and isLive false.
async function checkViaEmbed(dbg) {
  try {
    const r = await fetchWithTimeout(EMBED_URL, 7000);
    dbg.embedStatus = r.status;
    const html = await r.text();
    const pr = parsePlayerResponse(html);
    dbg.embedFoundPlayerResponse = !!pr.found;
    dbg.embedPlayability = pr.playabilityStatus || null;
    const vd = pr.videoDetails;
    if (vd && vd.isLive && vd.videoId) return { isLive: true, videoId: vd.videoId };
    return { isLive: false };
  } catch (e) {
    dbg.embedError = (e && e.name === 'AbortError') ? 'timeout' : String((e && e.message) || e);
    return { isLive: false };
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

  const apiKey = process.env.YOUTUBE_API_KEY;
  dbg.apiKeyConfigured = !!apiKey;
  if (apiKey) {
    const viaApi = await checkViaApi(apiKey, dbg);
    if (viaApi.checked) {
      isLive = viaApi.isLive; videoId = viaApi.videoId; signal = 'api';
    }
  }

  if (signal === null) {
    const viaEmbed = await checkViaEmbed(dbg);
    if (viaEmbed.isLive) { isLive = true; videoId = viaEmbed.videoId; signal = 'embed'; }
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
