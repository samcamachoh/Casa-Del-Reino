// Vercel serverless function: returns the church's 3 newest YouTube videos
// as JSON. It runs server-side, so there's no CORS restriction and no
// third-party proxy involved. Vercel automatically treats any file in /api
// as a serverless function — no extra config needed.
//
// Requires Node 18+ (for global fetch), which is Vercel's default runtime.

const CHANNEL_ID = 'UCnmH19dzWxrnHigDRzhE0ZQ';
const FEED = 'https://www.youtube.com/feeds/videos.xml?channel_id=' + CHANNEL_ID;

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, function (_, h) { return String.fromCodePoint(parseInt(h, 16)); })
    .replace(/&#(\d+);/g, function (_, d) { return String.fromCodePoint(parseInt(d, 10)); });
}

// The YouTube feed is well-structured XML; a light parse is plenty here.
function parseFeed(xml) {
  const items = [];
  const entries = xml.split('<entry>').slice(1);
  for (const raw of entries) {
    const block = raw.split('</entry>')[0];
    const id = (block.match(/<yt:videoId>([^<]+)<\/yt:videoId>/) || [])[1];
    const title = (block.match(/<title>([\s\S]*?)<\/title>/) || [])[1];
    const published = (block.match(/<published>([^<]+)<\/published>/) || [])[1];
    if (id) {
      items.push({
        id: id,
        title: title ? decodeEntities(title.trim()) : '',
        published: published || ''
      });
    }
  }
  return items;
}

module.exports = async function handler(req, res) {
  try {
    const r = await fetch(FEED, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (compatible; CasaDelReinoSite/1.0; +https://casadelreino.com)'
      }
    });
    if (!r.ok) throw new Error('feed status ' + r.status);
    const xml = await r.text();
    const items = parseFeed(xml).slice(0, 3);

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    // Cache at Vercel's edge for 30 min; serve stale up to a day while it
    // refreshes in the background, so the channel feed is hit rarely.
    res.setHeader('Cache-Control', 'public, s-maxage=1800, stale-while-revalidate=86400');
    res.status(200).json({ items: items });
  } catch (err) {
    res.status(502).json({ items: [], error: 'feed_unavailable' });
  }
};
