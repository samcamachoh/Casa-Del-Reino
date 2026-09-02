# Casa Del Reino — Website

Single-page static site plus two serverless functions: one for the sermons feed, one for the live indicator.

## Structure
```
index.html          The homepage (HTML, CSS, JS, logos all inline)
about.html           The "About Us" page — apostles + campus photo, linked from
                     the "Conoce más sobre nosotros" button in the homepage's
                     Nosotros section
api/sermons.js       Vercel serverless function: returns the 3 newest YouTube
                     videos as JSON (server-side, so no CORS / no third-party proxy)
api/livestream.js    Vercel serverless function: reports whether the channel is
                     currently live, and the video id to embed if so
hero-invite.mp4      The invitation video played in the homepage hero
video-poster.jpg     Poster frame shown on the hero video before it plays
```

## Deploy on Vercel
1. Push this folder to a GitHub repo, then import it in Vercel (Framework preset: **Other**). No build command or output dir needed.
   - Or drag the folder into vercel.com/new.
2. Vercel automatically detects everything in `api/` and deploys each file as a function (`/api/sermons`, `/api/livestream`). Nothing to configure.
3. Requires Vercel's default Node runtime (Node 18+) — already the default.

## How the sermons section works
- On load, the page calls `/api/sermons` (your own backend). That function fetches a specific playlist's public feed server-side and returns the 3 newest videos in it as JSON. No CORS issue, no third-party dependency in the normal path.
- If YouTube refuses the direct request from Vercel's IP, the function automatically retries through a couple of proxies server-side, so it still returns data.
- The feed is cached at Vercel's edge for 10 min (`stale-while-revalidate`), so a newly posted sermon appears quickly without hammering YouTube.
- Click any thumbnail to play inline (privacy-friendly youtube-nocookie embed). Titles + dates follow the ES/EN toggle.
- If `/api/sermons` is unreachable (e.g. the function wasn't deployed), the page falls back to public proxies, then to a "watch on YouTube" message — so it never looks broken.
- **Live/upcoming broadcasts are excluded.** The playlist's RSS feed lists every video in it, including one that's currently live or scheduled — those aren't finished sermons yet. If `YOUTUBE_API_KEY` is set (see below), the function checks each video's `liveBroadcastContent` via the YouTube Data API and drops any `live`/`upcoming` entry before returning the newest 3. Without a key, RSS alone can't tell them apart, so the feed is returned unfiltered — setting the key (already recommended for the live indicator) fixes this too.

## Troubleshooting the sermons feed
If the section shows "couldn't load" or no videos:
1. **Confirm the function is deployed.** Open `https://YOUR-SITE/api/sermons` in a browser.
   - **404 / "not found"** → the `api/` folder didn't get deployed. Make sure `api/sermons.js` is in the repo/upload, redeploy. (Vercel needs the `/api` directory present at deploy.)
   - **JSON with `items`** → the function works; the issue is elsewhere (cache or front-end).
2. **See exactly what the server got:** open `https://YOUR-SITE/api/sermons?debug=1`. It returns:
   - `source` — which source worked (`direct`, `allorigins`, `corsproxy`) or `null` if all failed
   - `upstreamStatus` / `error` — what YouTube/proxies returned
   - `entriesParsed` + `sample` — how many videos parsed and the newest few
   - `liveFilterApplied` / `entriesAfterLiveFilter` — whether the live/upcoming filter ran (needs `YOUTUBE_API_KEY`) and how many entries survived it
   This tells you immediately whether it's a deploy issue, a YouTube-blocking issue, or a parsing issue.
3. Playlist ID is set in `PLAYLIST_ID` (currently `PLARohoB7nsl4`) in both `api/sermons.js` and the inline script in `index.html`.

## How the live indicator works
- Every 45s (and once on page load), the page calls `/api/livestream`. That function checks server-side whether a broadcast is currently active (see the probes below).
- **While live:** a red bar appears at the top ("We're live right now"), and the hero shows a pulsing "Live now" badge plus a "Join the live service" button linking straight to the stream on YouTube. The hero background (video or still) stays as-is — the stream itself is not embedded in the hero.
- **When the stream ends:** the very next poll (≤45s later) detects it and everything reverts to the default hero automatically — no page reload needed.
- Channel ID is set in `CHANNEL_ID` in `api/livestream.js` (same channel as the sermons feed).
- YouTube login-walls its watch pages for datacenter IPs like Vercel's (`playabilityStatus: LOGIN_REQUIRED`, "sign in to confirm you're not a bot" — observed in production during a real broadcast), so the function checks up to three sources, most reliable first:
  1. **YouTube Data API** (only if a `YOUTUBE_API_KEY` env var is set — see below). Recent video ids come from the channel's free RSS feed, then one `videos.list` call (1 quota unit) checks if any is live. Authoritative and immune to the bot wall. **This is the recommended setup.**
  2. **The `/embed/live_stream` page** — embeds are served to anonymous contexts everywhere, so they're less likely to be login-walled than watch pages.
  3. **The `/channel/<id>/live` watch page** — the original approach; works whenever YouTube doesn't bot-wall the request.

  Every probe requires a genuine positive signal (isLive/isLiveNow actually `true`) before reporting live — never an absence of a "not live" marker. An earlier version treated *any* video id found on the embed page as live whenever it didn't spot an explicit offline marker; in production that showed the site as permanently live, because the embed page pointed at the channel's last-ended broadcast with no such marker present. **Without the API key, detection is deliberately conservative** — it may occasionally miss a broadcast rather than risk showing "live" when the channel is offline, which is why the key is the recommended setup.
- Diagnostics: open `/api/livestream?debug=1` to see per-probe results and which signal fired (`signal`: `api`/`embed`/`livepage`).

### Setting up the YouTube API key (recommended, free)
1. Go to https://console.cloud.google.com/ → create a project (any name).
2. "APIs & Services" → "Library" → enable **YouTube Data API v3**.
3. "APIs & Services" → "Credentials" → "Create credentials" → **API key**. (Optionally restrict it to the YouTube Data API.)
4. In Vercel: Project → Settings → Environment Variables → add `YOUTUBE_API_KEY` with the key value → redeploy.
5. Usage is ~1 quota unit per poll (edge-cached 30s) ≈ 3k units/day, well inside the 10k/day free quota. Verify with `/api/livestream?debug=1` — it should report `apiKeyConfigured: true` and, while live, `signal: "api"`.

## Hero invitation video
The hero **is** the invitation video: full-bleed under the nav, autoplaying muted on a loop, with a sound button in the corner that turns the audio on. The old headline ("Un lugar de Amor, Familia y Transformación") and the background photo were removed to give the video the whole hero; the two calls to action stay in a compact row beneath it.

**Muted autoplay is not a choice, it's the only option.** No browser will autoplay a video with sound. So the video starts muted and looping, and one tap on the sound button unmutes it. That tap also restarts the clip from the beginning — catching a 35-second invitation halfway through is worse than watching it from the top — turns off looping, and hands over native controls.

If autoplay is refused — iOS Low Power Mode, data saver, or the visitor has "reduce motion" turned on — the centre play button is shown instead, and starts the video with sound straight away, since that click is a real user gesture.

Two files in the repo root, both served straight off Vercel's CDN:

- **`hero-invite.mp4`** — 25 MB, 35s, H.264 High 1920x1080, AAC stereo.
- **`video-poster.jpg`** — 34 KB still pulled from the 3-second mark, shown before playback starts.

They're wired up through two attributes on the hero `<video>` in `index.html`:

```html
<video id="hero-video" playsinline preload="metadata"
       data-src="hero-invite.mp4" data-poster="video-poster.jpg"></video>
```

**Bandwidth:** because the video autoplays, `preload="auto"` is set and the 25 MB is downloaded by everyone who lands on the homepage, not just people who choose to watch. That's the cost of autoplay. If it becomes a problem, the options are to re-encode smaller (a `-crf 23` pass came out at 10.7 MB with no visible difference), to autoplay a short low-bitrate loop and swap in the full file on the sound tap, or to go back to `preload="metadata"` with click-to-play.

### Sizing
The card is full-window width with a 16:9 shape, capped at `calc(100vh - 190px)` so the video and the buttons under it both stay above the fold. On screens wider than that cap allows, the video letterboxes against the hero's own background colour rather than cropping — nothing is ever cut off.

**Under 640px the card crops to 4:3 instead of letterboxing at 16:9**, which takes the video from ~219px tall to ~293px on a 390px-wide phone. The crop window is offset to `47.5%` rather than centred: sampling the whole clip frame by frame, all of the speaker's movement falls within source px 240-1584 of the 1920-wide frame, centred on 912. A 4:3 window at 47.5% keeps every gesture with roughly 48px of margin on each side. If you swap in different footage, re-check that offset — with a subject framed elsewhere it will be wrong.

A vertical source is detected from the video metadata and given a portrait frame sized against the viewport height instead, and is exempt from the mobile crop.

### Fallback behaviour
If `data-src` is empty, the file 404s, or the codec is unsupported, the card is removed and the hero gets an `is-fallback` class that restores the **old photo hero** — `Hero Image` on desktop, `Mobile Hero.png` under 900px, with the gradient scrim and the buttons over it. Those images are referenced only under `.is-fallback`, so they are never fetched while the video is working.

A plain network error is deliberately *not* treated this way: the card stays so the visitor can tap again, rather than the hero silently emptying itself because a phone blipped off wifi.

**`#hero-live-tag` and `#hero-live-btn` must stay in the hero markup.** The live-indicator script bails out entirely if either is missing, which would take the red "we're live right now" bar at the top of the site down with it. Both are hidden unless a broadcast is actually live.

### Replacing the video
Drop in a new file, point `data-src` at it, and pull a fresh poster:

```
ffmpeg -ss 00:00:03 -i hero-invite.mp4 -frames:v 1 -vf "scale=1360:-2" -q:v 4 video-poster.jpg
```

Two things any replacement must satisfy:

1. **H.264 video + AAC audio in an MP4.** Not `.mov`, not HEVC, not ProRes — those either won't play outside Safari or won't play at all. Check with `ffprobe -v error -show_entries stream=codec_name -of default=nw=1 file.mp4`.
2. **`moov` atom at the front** (`-movflags +faststart`). Without it the browser downloads the entire file before showing a single frame. QuickTime and most editors put it at the end by default, so assume you need it:

```
ffmpeg -i input.mp4 -c copy -movflags +faststart hero-invite.mp4
```

That one is a lossless rewrap — no re-encoding, a couple of seconds.

Keep replacements under ~30 MB. If a longer video pushes past that, either re-encode harder (`-crf 26`) or move hosting to Vercel Blob — in that case `data-src` takes the full blob URL and the file leaves the repo, with no other change needed.

## About Us page photos
`about.html` shows a shared photo of both apostles (`Apostoles.jpg`, already uploaded) and reserves space for a campus photo that hasn't been uploaded yet — until it is, the page shows an empty placeholder box in its place (same pattern as the homepage hero, which reads the `Hero Image` file):
- **`Campus.jpg`** — a wide photo of the campus. Upload it to the repo root with that exact filename.

## Notes / open items
- Logo "10" mark in the header is a raster (PNG) embedded inline; swap in an SVG if you ever have the vector. Footer logo is already vector.
- Ministries list and "what to expect" copy are sensible placeholders — confirm against the real ministries.
- The apostles' bio on `about.html` is placeholder copy — replace with their real bio whenever you have it.
- Contact uses `mailto:` (no backend form). Easy to add later.
