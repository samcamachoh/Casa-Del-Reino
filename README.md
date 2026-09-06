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
hero-invite-optimized.mp4  The 720p invitation video served by the homepage
hero-invite.mp4      Original source retained for future encoding
logo.png            Shared header/footer logo, cached across both pages
video-poster.jpg     Poster frame shown on the hero video before it plays
```

## Deploy on Vercel
1. Push this folder to a GitHub repo, then import it in Vercel (Framework preset: **Other**). No build command or output dir needed.
   - Or drag the folder into vercel.com/new.
2. Vercel automatically detects everything in `api/` and deploys each file as a function (`/api/sermons`, `/api/livestream`). Nothing to configure.
3. Requires Vercel's default Node runtime (Node 18+) — already the default.

## How the sermons section works
- When the sermons section is within 600px of the viewport, the page calls `/api/sermons` (your own backend). That function fetches a specific playlist's public feed server-side and returns the 3 newest videos in it as JSON. No CORS issue, no third-party dependency in the normal path.
- If YouTube refuses the direct request from Vercel's IP, the function automatically retries through a couple of proxies server-side, so it still returns data.
- The feed is cached at Vercel's edge for 10 min (`stale-while-revalidate`), so a newly posted sermon appears quickly without hammering YouTube.
- Click any thumbnail to play inline (privacy-friendly youtube-nocookie embed). Titles + dates follow the ES/EN toggle.
- If `/api/sermons` is unreachable, the page shows a bilingual fallback with the existing YouTube channel link. Proxy retries remain server-side only. The client deadline is 32 seconds, covering the server's maximum four sequential 7-second requests; deadlines include reading response bodies.
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
3. Playlist ID is set in `PLAYLIST_ID` (currently `PLARohoB7nsl4`) in `api/sermons.js`.

## How the live indicator works
- Every 45s while the tab is visible (and once on page load), the page calls `/api/livestream`. That function checks server-side whether a broadcast is currently active (see the probes below).
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

The homepage serves **`hero-invite-optimized.mp4`** — 3,540,839 bytes, 35s, H.264 1280×720 with AAC audio and the MP4 index at the front. The original 25,353,212-byte `hero-invite.mp4` remains in the repo as source material. `video-poster.jpg` displays immediately in a reserved video frame, avoiding a hero layout shift.

The video starts with `preload="none"` and no `src`. JavaScript attaches the source when the hero is on screen. Reduced-motion, Save-Data, and slow 2G connections require a deliberate play tap and do not download the video on arrival. Muted playback pauses off screen and in hidden tabs; playback with sound remains under the visitor's control. A browser may retain/buffer a source after it has been attached.

```html
<video id="hero-video" playsinline muted loop preload="none"
       poster="/video-poster.jpg" data-src="/hero-invite-optimized.mp4"></video>
```

To reproduce the optimized video:

```sh
ffmpeg -i hero-invite.mp4 -vf scale=1280:-2 -c:v libx264 -preset fast -crf 25 -c:a aac -b:a 96k -movflags +faststart hero-invite-optimized.mp4
```

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
`about.html` shows the shared apostles photo (`Apostoles.jpg`). The campus photo has not been supplied, so the campus section displays the address and directions link instead of requesting the nonexistent `Campus.jpg`.

## Motion, navigation, and loading
- Content is visible by default, including without JavaScript. Only below-the-fold, non-nested sections receive a short 12px/400ms entrance; no long card staggering or continuous giving-button pulse.
- Reduced motion disables transitions, animation, and smooth route scrolling.
- Mobile navigation supports Escape, focus wrapping, expanded-state announcements, and resets when crossing the desktop breakpoint.
- The giving widget loads within 400px of its section. A direct Pushpay link remains available independently of the embed.
- Both pages update the document language with the language switcher and share `/logo.png` rather than duplicating base64 images.

## Notes / open items
- Header and footer use the shared raster `logo.png`; a vector original would improve scaling.
- Ministries list and "what to expect" copy are sensible placeholders — confirm against the real ministries.
- The apostles' bio on `about.html` is placeholder copy — replace with their real bio whenever you have it.
- Contact uses `mailto:` (no backend form). Easy to add later.

## Regression checks

Requires Node 24+ and jsdom 30. Install test dependencies outside the static site directory:

```sh
npm install --prefix /tmp/cdr-tests jsdom@30.0.1
NODE_PATH=/tmp/cdr-tests/node_modules node --test tests/regression.cjs
```

These checks use simulated DOM/media/network behavior; they do not replace real-browser playback or live-provider verification.
