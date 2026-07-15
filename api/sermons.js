// Vercel serverless function: returns the church's 6 newest YouTube videos
// as JSON. Runs server-side (no browser CORS limits). Vercel auto-detects any
// file in /api as a function — no config needed. Requires Node 18+ (default).
//
// The channel's RSS feed lists every public video, including a broadcast
// that's currently live or scheduled ("upcoming") — those aren't finished
// sermons yet, so they're filtered out below (see filterOutLive). That check
// needs the YouTube Data API (same YOUTUBE_API_KEY used by api/livestream.js);
// without a key, RSS alone can't tell a live/upcoming entry from a finished
// video, so the feed is returned unfiltered.
//
// Diagnostics: open /api/sermons?debug=1 in a browser to see exactly what the
// server got from YouTube (which source worked, upstream status, how many
// entries parsed, whether the live filter ran, and a sample). This makes
// failures easy to pinpoint.

const CHANNEL_ID = 'UCnmH19dzWxrnHigDRzhE0ZQ';
const FEED = 'https://www.youtube.com/feeds/videos.xml?channel_id=' + CHANNEL_ID;

// Tried in order. Direct first (clean, no third party). The proxies are only a
// backup in case YouTube refuses Vercel's datacenter IP — they return the XML
// untouched, so parsing is identical.
const SOURCES = [
  { label: 'direct', url: FEED },
  { label: 'allorigins', url: 'https://api.allorigins.win/raw?url=' + encodeURIComponent(FEED) },
  { label: 'corsproxy', url: 'https://corsproxy.io/?url=' + encodeURIComponent(FEED) }
];

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, function (_, h) { return String.fromCodePoint(parseInt(h, 16)); })
    .replace(/&#(\d+);/g, function (_, d) { return String.fromCodePoint(parseInt(d, 10)); });
}

function parseFeed(xml) {
  const items = [];
  const entries = xml.split('<entry>').slice(1);
  for (const raw of entries) {
    const block = raw.split('</entry>')[0];
    const id = (block.match(/<yt:videoId>([^<]+)<\/yt:videoId>/) || [])[1];
    const title = (block.match(/<title>([\s\S]*?)<\/title>/) || [])[1];
    const published = (block.match(/<published>([^<]+)<\/published>/) || [])[1];
    if (id) items.push({ id: id, title: title ? decodeEntities(title.trim()) : '', published: published || '' });
  }
  return items;
}

function fetchWithTimeout(url, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(function () { ctrl.abort(); }, ms);
  return fetch(url, {
    signal: ctrl.signal,
    redirect: 'follow',
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; CasaDelReinoSite/1.0; +https://casadelreino.com)',
      'Accept': 'application/atom+xml, application/xml, text/xml, */*',
      'Accept-Language': 'en-US,en;q=0.9'
    }
  }).finally(function () { clearTimeout(t); });
}

// Drops any video that's currently live or scheduled ("upcoming") using the
// YouTube Data API (1 quota unit for up to 50 ids in a single videos.list
// call). liveBroadcastContent is only "live"/"upcoming" while a broadcast is
// active or scheduled — a finished stream reverts to "none" like any regular
// upload, so past sermons that started life as livestreams are unaffected.
async function filterOutLive(items, apiKey) {
  if (!apiKey || !items.length) return { items: items, applied: false };
  try {
    const ids = items.map(function (i) { return i.id; });
    const url = 'https://www.googleapis.com/youtube/v3/videos?part=snippet&id='
      + encodeURIComponent(ids.join(',')) + '&key=' + encodeURIComponent(apiKey);
    const r = await fetchWithTimeout(url, 7000);
    if (!r.ok) return { items: items, applied: false };
    const data = await r.json();
    const statusById = {};
    for (const v of (data.items || [])) {
      statusById[v.id] = v.snippet && v.snippet.liveBroadcastContent;
    }
    const filtered = items.filter(function (i) {
      const status = statusById[i.id];
      return status !== 'live' && status !== 'upcoming';
    });
    return { items: filtered, applied: true };
  } catch (e) {
    return { items: items, applied: false };
  }
}

// Walk the sources until one returns XML that actually contains entries.
async function getFeed() {
  let lastStatus = 0, lastErr = '';
  for (const s of SOURCES) {
    try {
      const r = await fetchWithTimeout(s.url, 7000);
      lastStatus = r.status;
      if (!r.ok) { lastErr = 'status ' + r.status; continue; }
      const xml = await r.text();
      if (xml.indexOf('<entry') !== -1) return { xml: xml, source: s.label, status: r.status };
      lastErr = 'no <entry> in response';
    } catch (e) {
      lastErr = (e && e.name === 'AbortError') ? 'timeout' : String((e && e.message) || e);
    }
  }
  return { xml: '', source: null, status: lastStatus, error: lastErr };
}

module.exports = async function handler(req, res) {
  const q = req.query || {};
  const debug = q.debug === '1' || q.debug === 'true';

  const feed = await getFeed();
  const all = feed.xml ? parseFeed(feed.xml) : [];
  const liveFilter = await filterOutLive(all, process.env.YOUTUBE_API_KEY);
  const items = liveFilter.items.slice(0, 6);

  if (debug) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      ok: items.length > 0,
      source: feed.source,
      upstreamStatus: feed.status,
      error: feed.error || null,
      channelId: CHANNEL_ID,
      entriesParsed: all.length,
      liveFilterApplied: liveFilter.applied,
      entriesAfterLiveFilter: liveFilter.items.length,
      sample: items
    });
  }

  if (!items.length) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(502).json({ items: [], error: 'feed_unavailable' });
  }

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  // Fresh for 10 min, then serve stale up to an hour while revalidating, so a
  // newly posted sermon shows up quickly without hammering YouTube.
  res.setHeader('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=3600');
  return res.status(200).json({ items: items });
};
