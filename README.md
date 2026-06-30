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
- On load, the page calls `/api/sermons` (your own backend). That function fetches the channel's public feed server-side and returns the 3 newest videos as JSON. No CORS issue, no third-party dependency in the normal path.
- If YouTube refuses the direct request from Vercel's IP, the function automatically retries through a couple of proxies server-side, so it still returns data.
- The feed is cached at Vercel's edge for 10 min (`stale-while-revalidate`), so a newly posted sermon appears quickly without hammering YouTube.
- Click any thumbnail to play inline (privacy-friendly youtube-nocookie embed). Titles + dates follow the ES/EN toggle.
- If `/api/sermons` is unreachable (e.g. the function wasn't deployed), the page falls back to public proxies, then to a "watch on YouTube" message — so it never looks broken.

## Troubleshooting the sermons feed
If the section shows "couldn't load" or no videos:
1. **Confirm the function is deployed.** Open `https://YOUR-SITE/api/sermons` in a browser.
   - **404 / "not found"** → the `api/` folder didn't get deployed. Make sure `api/sermons.js` is in the repo/upload, redeploy. (Vercel needs the `/api` directory present at deploy.)
   - **JSON with `items`** → the function works; the issue is elsewhere (cache or front-end).
2. **See exactly what the server got:** open `https://YOUR-SITE/api/sermons?debug=1`. It returns:
   - `source` — which source worked (`direct`, `allorigins`, `corsproxy`) or `null` if all failed
   - `upstreamStatus` / `error` — what YouTube/proxies returned
   - `entriesParsed` + `sample` — how many videos parsed and the newest few
   This tells you immediately whether it's a deploy issue, a YouTube-blocking issue, or a parsing issue.
3. Channel ID is set in `CHANNEL_ID` (currently `UCnmH19dzWxrnHigDRzhE0ZQ`) in both `api/sermons.js` and the inline script in `index.html`.

## Notes / open items
- Logo "10" mark in the header is a raster (PNG) embedded inline; swap in an SVG if you ever have the vector. Footer logo is already vector.
- Ministries list and "what to expect" copy are sensible placeholders — confirm against the real ministries.
- Contact uses `mailto:` (no backend form). Easy to add later.
