// Vercel serverless function: returns the 3 newest YouTube videos from a
// specific playlist, as JSON. Runs server-side (no browser CORS limits).
// Vercel auto-detects any file in /api as a function — no config needed.
// Requires Node 18+ (default).
//
// The playlist's RSS feed lists every video in it, including a broadcast
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

const PLAYLIST_ID = 'PLARohoB7nsl4';
const CHANNEL_ID = 'UCnmH19dzWxrnHigDRzhE0ZQ';
const FEED = 'https://www.youtube.com/feeds/videos.xml?playlist_id=' + PLAYLIST_ID;
const CHANNEL_FEED = 'https://www.youtube.com/feeds/videos.xml?channel_id=' + CHANNEL_ID;

// A real playlist id is "PL" + 32 characters. A shorter one (a truncated copy
// from a URL) makes YouTube answer 404 for the feed, and the sermons section
// then stays empty — so it is skipped, and the channel's uploads feed is used.
const PLAYLIST_LOOKS_VALID = /^(PL|UU|OL|FL)[\w-]{16,}$/.test(PLAYLIST_ID);

// Tried in order. Direct first (clean, no third party). The playlist is the
// curated source; the channel feed is the fallback so the section is never
// empty. The proxies are only a last backup in case YouTube refuses Vercel's
// datacenter IP — they return the XML untouched, so parsing is identical.
const SOURCES = [].concat(
  PLAYLIST_LOOKS_VALID ? [{ label: 'direct', url: FEED }] : [],
  [{ label: 'channel', url: CHANNEL_FEED }],
  PLAYLIST_LOOKS_VALID ? [
    { label: 'allorigins', url: 'https://api.allorigins.win/raw?url=' + encodeURIComponent(FEED) },
    { label: 'corsproxy', url: 'https://corsproxy.io/?url=' + encodeURIComponent(FEED) }
  ] : []
);

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

// ---- Page scrape (used when the RSS feeds are unavailable) ----
// YouTube's RSS feeds sometimes answer 404 to everything (observed from
// Vercel for both the playlist and the channel feed), while the normal
// channel pages still load. So as a fallback we read the channel's /videos and
// /streams tabs (church services are usually streams), pull video ids + titles
// out of the embedded ytInitialData JSON, then read each watch page for its
// publish date and drop anything live/upcoming.
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
    else if (c === '}') { depth--; if (depth === 0) return html.slice(start, i + 1); }
  }
  return null;
}

function collectVideos(node, out, seen) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const n of node) collectVideos(n, out, seen); return; }
  const vr = node.videoRenderer;
  if (vr && vr.videoId && !seen[vr.videoId]) {
    seen[vr.videoId] = 1;
    const title = vr.title && ((vr.title.runs && vr.title.runs[0] && vr.title.runs[0].text) || vr.title.simpleText) || '';
    const overlays = JSON.stringify(vr.thumbnailOverlays || '');
    const isLive = !!vr.upcomingEventData || /"style":"(LIVE|UPCOMING)"/.test(overlays);
    if (!isLive) out.push({ id: vr.videoId, title: title });
  }
  const lv = node.lockupViewModel;
  if (lv && lv.contentId && lv.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO' && !seen[lv.contentId]) {
    seen[lv.contentId] = 1;
    const title = lv.metadata && lv.metadata.lockupMetadataViewModel && lv.metadata.lockupMetadataViewModel.title && lv.metadata.lockupMetadataViewModel.title.content || '';
    const isLive = /"(LIVE|UPCOMING)"/.test(JSON.stringify(lv.contentImage || ''));
    if (!isLive) out.push({ id: lv.contentId, title: title });
  }
  for (const k of Object.keys(node)) collectVideos(node[k], out, seen);
}

async function scrapeTab(tab, dbg) {
  try {
    const r = await fetchWithTimeout('https://www.youtube.com/channel/' + CHANNEL_ID + '/' + tab + '?hl=en', 8000);
    dbg[tab + 'Status'] = r.status;
    if (!r.ok) return [];
    const html = await r.text();
    const raw = extractJsonAfter(html, 'var ytInitialData =') || extractJsonAfter(html, 'window["ytInitialData"] =');
    dbg[tab + 'FoundData'] = !!raw;
    if (!raw) return [];
    const out = [];
    collectVideos(JSON.parse(raw), out, {});
    dbg[tab + 'Videos'] = out.length;
    return out.slice(0, 8);
  } catch (e) {
    dbg[tab + 'Error'] = (e && e.name === 'AbortError') ? 'timeout' : String((e && e.message) || e);
    return [];
  }
}

async function publishDate(id) {
  try {
    const r = await fetchWithTimeout('https://www.youtube.com/watch?v=' + id + '&hl=en', 7000);
    if (!r.ok) return '';
    const html = await r.text();
    const m = html.match(/"publishDate":"([^"]+)"/) || html.match(/itemprop="datePublished" content="([^"]+)"/) || html.match(/"uploadDate":"([^"]+)"/);
    return m ? m[1] : '';
  } catch (e) { return ''; }
}

async function scrapeChannel(dbg) {
  const tabs = await Promise.all([scrapeTab('streams', dbg), scrapeTab('videos', dbg)]);
  const byId = {}, list = [];
  tabs.forEach(function (arr) { arr.forEach(function (v) { if (!byId[v.id]) { byId[v.id] = v; list.push(v); } }); });
  const dates = await Promise.all(list.map(function (v) { return publishDate(v.id); }));
  list.forEach(function (v, i) { v.published = dates[i]; });
  // newest first when dates are known; otherwise keep page order (already newest first)
  list.sort(function (a, b) { return (b.published || '').localeCompare(a.published || ''); });
  return list;
}

// Walk the sources until one returns XML that actually contains entries.
async function getFeed() {
  let lastStatus = 0, lastErr = '';
  const attempts = [];
  for (const s of SOURCES) {
    try {
      const r = await fetchWithTimeout(s.url, 7000);
      lastStatus = r.status;
      if (!r.ok) { lastErr = 'status ' + r.status; attempts.push(s.label + ': ' + lastErr); continue; }
      const xml = await r.text();
      if (xml.indexOf('<entry') !== -1) { attempts.push(s.label + ': ok'); return { xml: xml, source: s.label, status: r.status, attempts: attempts }; }
      lastErr = 'no <entry> in response';
    } catch (e) {
      lastErr = (e && e.name === 'AbortError') ? 'timeout' : String((e && e.message) || e);
    }
    attempts.push(s.label + ': ' + lastErr);
  }
  return { xml: '', source: null, status: lastStatus, error: lastErr, attempts: attempts };
}

module.exports = async function handler(req, res) {
  const q = req.query || {};
  const debug = q.debug === '1' || q.debug === 'true';

  const feed = await getFeed();
  const scrapeDbg = {};
  let all = feed.xml ? parseFeed(feed.xml) : [];
  if (!all.length) {
    all = await scrapeChannel(scrapeDbg);
    if (all.length) feed.source = 'scrape';
  }
  const liveFilter = await filterOutLive(all, process.env.YOUTUBE_API_KEY);
  const items = liveFilter.items.slice(0, 3);

  if (debug) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      ok: items.length > 0,
      source: feed.source,
      upstreamStatus: feed.status,
      error: feed.error || null,
      playlistId: PLAYLIST_ID,
      playlistIdLooksValid: PLAYLIST_LOOKS_VALID,
      attempts: feed.attempts,
      scrape: scrapeDbg,
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
