# Casa Del Reino — Website

Single-page static site plus one serverless function for the sermons feed.

## Structure
```
index.html        The whole site (HTML, CSS, JS, logos all inline)
api/sermons.js    Vercel serverless function: returns the 3 newest YouTube
                  videos as JSON (server-side, so no CORS / no third-party proxy)
```

## Deploy on Vercel
1. Push this folder to a GitHub repo, then import it in Vercel (Framework preset: **Other**). No build command or output dir needed.
   - Or drag the folder into vercel.com/new.
2. Vercel automatically detects `api/sermons.js` and deploys it as a function at `/api/sermons`. Nothing to configure.
3. Requires Vercel's default Node runtime (Node 18+) — already the default.

## How the sermons section works
- On load, the page calls `/api/sermons` (your own backend). That function fetches the channel's public feed server-side and returns the 3 newest videos as JSON. No CORS issue, no third-party dependency.
- The feed is cached at Vercel's edge for 30 minutes (`stale-while-revalidate`), so YouTube is hit rarely even under traffic.
- It auto-updates: post a new sermon and it appears within the cache window.
- If `/api/sermons` is ever unreachable (e.g. opening `index.html` directly off disk with no server), the page falls back to public CORS proxies, and finally to a "watch on YouTube" message — so it never looks broken.
- Click any thumbnail to play the video inline (privacy-friendly youtube-nocookie embed). Titles + dates follow the ES/EN toggle.

To change the channel, edit `CHANNEL_ID` in `api/sermons.js` (and the same constant in the inline script in `index.html`).

## Notes / open items
- Logo "10" mark in the header is a raster (PNG) embedded inline; swap in an SVG if you ever have the vector. Footer logo is already vector.
- Ministries list and "what to expect" copy are sensible placeholders — confirm against the real ministries.
- Contact uses `mailto:` (no backend form). Easy to add later.
